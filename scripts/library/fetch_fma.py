#!/usr/bin/env python3
"""
Pull Creative-Commons tracks from the Free Music Archive dataset
(https://github.com/mdeff/fma) into library/incoming/fma/.

The full-length audio lives in one 880 GB zip. Instead of downloading it, this
reads the zip's central directory over HTTP range requests and then fetches
only the selected tracks' byte ranges - so "top 5,000 English tracks" costs
~40 GB, not 880.

Selection (most-listened first):
  --language en          keep tracks tagged with this language (default en)
  --instrumental         also keep tracks FMA flags as instrumental (no lyrics,
                         so language-neutral) - on by default, --no-instrumental
  --untagged             also keep tracks with no language tag at all (most of
                         the archive - largely English or wordless, but some
                         non-English vocals slip through; "International" is
                         left out)
  --allow-nd             include NoDerivatives licences (off: a DJ mix is a
                         derivative work, so ND tracks are skipped by default)
  --commercial           only licences that allow commercial use
  --genres Rock,Pop      restrict to top-level genres
  --limit N              how many tracks (default 500)

Stdlib only. Each track lands as <id>.mp3 + <id>.json (sidecar the ingest
step reads). Re-running resumes: existing files are skipped.
"""
import argparse
import ast
import bz2
import concurrent.futures as cf
import csv
import io
import json
import os
import struct
import sys
import time
import urllib.request
import zipfile
import zlib

import netfamily

# only one IP family reaches the internet here
netfamily.pin("os.unil.cloud.switch.ch")

BASE = "https://os.unil.cloud.switch.ch/fma"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIBRARY = os.environ.get("LIBRARY_DIR") or os.path.join(ROOT, "library")
SRC = os.path.join(LIBRARY, "sources", "fma")
OUT = os.path.join(LIBRARY, "incoming", "fma")

csv.field_size_limit(10**9)


def http_range(url, start, end, tries=8):
    """GET bytes [start, end] inclusive. The host drops connections mid-body,
    so a short read resumes from where it stopped instead of starting over."""
    got = bytearray()
    failures = 0
    while len(got) < end - start + 1:
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start + len(got)}-{end}"})
            with urllib.request.urlopen(req, timeout=60) as r:
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    got += chunk
                    failures = 0
        except Exception as e:  # noqa: BLE001 - network flake, resume
            failures += 1
            if failures >= tries:
                raise
            time.sleep(min(10, failures))
            if failures > 2:
                print(f"  retry {failures}: {e}", file=sys.stderr)
    return bytes(got)


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only view of a remote file, enough for zipfile to read
    the central directory without downloading the archive."""

    def __init__(self, url):
        self.url = url
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])
        self.pos = 0
        self.buf_start = 0
        self.buf = b""

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        n = min(n, self.size - self.pos)
        if n <= 0:
            return b""
        lo = self.pos - self.buf_start
        if lo < 0 or lo + n > len(self.buf):
            # zipfile reads the tail in small pieces - fetch generously
            want = max(n, 4 * 1024 * 1024)
            end = min(self.size, self.pos + want) - 1
            self.buf = http_range(self.url, self.pos, end)
            self.buf_start = self.pos
            lo = 0
        out = self.buf[lo : lo + n]
        self.pos += len(out)
        return out


def ensure_metadata():
    os.makedirs(SRC, exist_ok=True)
    need = ["tracks.csv", "raw_tracks.csv"]
    if all(os.path.exists(os.path.join(SRC, "fma_metadata", n)) for n in need):
        return
    zpath = os.path.join(SRC, "fma_metadata.zip")
    if not os.path.exists(zpath):
        print("downloading fma_metadata.zip (342 MB)…")
        urllib.request.urlretrieve(f"{BASE}/fma_metadata.zip", zpath)
    # bzip2-compressed zip: system `unzip` can't read it, Python can
    with zipfile.ZipFile(zpath) as z:
        for n in need:
            z.extract(f"fma_metadata/{n}", SRC)


def zip_index(archive):
    """name -> [header_offset, compressed_size, method]; cached on disk."""
    cache = os.path.join(SRC, f"{archive}.index.json")
    if os.path.exists(cache):
        with open(cache) as f:
            return json.load(f)
    print(f"reading {archive}.zip central directory over HTTP (one-off)…")
    z = zipfile.ZipFile(HttpRangeFile(f"{BASE}/{archive}.zip"))
    idx = {
        i.filename: [i.header_offset, i.compress_size, i.compress_type]
        for i in z.infolist()
        if i.filename.endswith(".mp3")
    }
    with open(cache, "w") as f:
        json.dump(idx, f)
    return idx


def fetch_member(archive, entry):
    offset, csize, method = entry
    # local header is 30 bytes + name + extra; over-read a little to cover it
    raw = http_range(f"{BASE}/{archive}.zip", offset, offset + 30 + 2048 + csize)
    if raw[:4] != b"PK\x03\x04":
        raise ValueError("bad local header")
    name_len, extra_len = struct.unpack("<HH", raw[26:30])
    data = raw[30 + name_len + extra_len : 30 + name_len + extra_len + csize]
    if method == 0:
        return data
    if method == 8:
        return zlib.decompress(data, -15)
    if method == 12:
        return bz2.decompress(data)
    raise ValueError(f"unsupported zip method {method}")


def license_flags(name):
    n = name.lower().replace("-", " ")
    return {
        "nd": "noderiv" in n.replace(" ", "") or "no deriv" in n or "music sharing" in n,
        "nc": "noncommercial" in n.replace(" ", "") or "non commercial" in n,
    }


def load_rows():
    with open(os.path.join(SRC, "fma_metadata", "tracks.csv"), newline="", encoding="utf-8") as f:
        r = csv.reader(f)
        h0, h1, _ = next(r), next(r), next(r)
        cols = [f"{a}.{b}" if a else "track_id" for a, b in zip(h0, h1)]
        rows = [dict(zip(cols, row)) for row in r]
    raw = {}
    with open(os.path.join(SRC, "fma_metadata", "raw_tracks.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            raw[row["track_id"]] = row
    return rows, raw


def parse_list(s):
    try:
        v = ast.literal_eval(s) if s else []
        return [str(x) for x in v] if isinstance(v, list) else []
    except (ValueError, SyntaxError):
        return []


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--language", default="en")
    ap.add_argument("--instrumental", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--untagged", action="store_true")
    ap.add_argument("--allow-nd", action="store_true")
    ap.add_argument("--commercial", action="store_true")
    ap.add_argument("--genres", default="")
    ap.add_argument("--min-duration", type=int, default=75)
    ap.add_argument("--max-duration", type=int, default=540)
    ap.add_argument("--archive", default="fma_full", help="fma_full (whole tracks) or fma_large (30s clips)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true", help="print the selection, download nothing")
    args = ap.parse_args()

    ensure_metadata()
    rows, raw = load_rows()
    genres = {g.strip().lower() for g in args.genres.split(",") if g.strip()}

    picked = []
    for t in rows:
        r = raw.get(t["track_id"], {})
        lang = t["track.language_code"]
        instrumental = r.get("track_instrumental") == "1"
        untagged = args.untagged and not lang and t["track.genre_top"] != "International"
        if not (lang == args.language or (args.instrumental and instrumental and not lang) or untagged):
            continue
        lic = t["track.license"]
        if not lic:
            continue
        flags = license_flags(lic)
        if flags["nd"] and not args.allow_nd:
            continue
        if flags["nc"] and args.commercial:
            continue
        try:
            dur = int(float(t["track.duration"]))
        except ValueError:
            continue
        if not (args.min_duration <= dur <= args.max_duration):
            continue
        top = t["track.genre_top"]
        if genres and top.lower() not in genres:
            continue
        # spoken word / field recordings / noise make poor DJ material
        if top in ("Spoken", "Experimental", "Old-Time / Historic"):
            continue
        picked.append((int(t["track.listens"] or 0), t, r, instrumental, flags))

    picked.sort(key=lambda x: -x[0])
    picked = picked[: args.limit]
    print(f"selected {len(picked)} tracks (most-listened first)")
    if args.dry_run:
        for listens, t, *_ in picked[:40]:
            print(f"  {listens:>8}  {t['artist.name']} - {t['track.title']}  [{t['track.genre_top']}] {t['track.license']}")
        return

    os.makedirs(OUT, exist_ok=True)
    index = zip_index(args.archive)
    done_meta = os.path.join(LIBRARY, "meta")

    def one(item):
        listens, t, r, instrumental, flags = item
        tid = int(t["track_id"])
        lid = f"fma-{tid}"
        mp3 = os.path.join(OUT, f"{lid}.mp3")
        if os.path.exists(mp3) or os.path.exists(os.path.join(done_meta, f"{lid}.json")):
            return "skip"
        name = f"{args.archive}/{tid:06d}"[: len(args.archive) + 4] + f"/{tid:06d}.mp3"
        entry = index.get(name)
        if not entry:
            return "missing"
        data = fetch_member(args.archive, entry)
        tags = sorted({*parse_list(t["track.tags"]), *parse_list(r.get("tags", ""))})
        sub = [g.get("genre_title") for g in (ast.literal_eval(r["track_genres"]) if r.get("track_genres") else [])]
        side = {
            "id": lid,
            "kind": "song",
            "title": t["track.title"],
            "artist": t["artist.name"],
            "album": t["album.title"],
            "genres": [g for g in dict.fromkeys([t["track.genre_top"], *sub]) if g],
            "tags": tags,
            "language": t["track.language_code"] or None,
            "instrumental": instrumental,
            "popularity": listens,
            "license": {
                "name": t["track.license"],
                "url": r.get("license_url") or None,
                "commercialUse": not flags["nc"],
                "derivatives": not flags["nd"],
            },
            "source": "fma",
            "sourceUrl": r.get("track_url") or None,
        }
        # sidecar first: ingest only picks up audio that already has one
        with open(os.path.join(OUT, f"{lid}.json"), "w") as f:
            json.dump(side, f)
        tmp = mp3 + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, mp3)
        return "ok"

    counts = {"ok": 0, "skip": 0, "missing": 0, "error": 0}
    t0 = time.time()
    with cf.ThreadPoolExecutor(args.workers) as ex:
        for i, fut in enumerate(cf.as_completed([ex.submit(one, p) for p in picked]), 1):
            try:
                counts[fut.result()] += 1
            except Exception as e:  # noqa: BLE001
                counts["error"] += 1
                print(f"  error: {e}", file=sys.stderr)
            if i % 25 == 0 or i == len(picked):
                print(f"  {i}/{len(picked)}  {counts}  {time.time() - t0:.0f}s", flush=True)
    print(f"done → {OUT}\nnext: npm run library:ingest")


if __name__ == "__main__":
    main()
