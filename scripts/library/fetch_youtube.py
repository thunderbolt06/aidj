#!/usr/bin/env python3
"""
Pull well-known songs from YouTube (yt-dlp) into library/incoming/youtube/.

LOCAL EXPERIMENT ONLY: these recordings are all-rights-reserved. They are
tagged source="youtube" so they can be kept out of anything that gets
deployed or shared (see README - never sync yt-* entries to a public host).

Where the song list comes from (combine freely):
  --years 1980-2024      Billboard Year-End Hot 100 for each year (titles and
                         artists read from Wikipedia) - the default
  --queries FILE         one "Artist - Title" per line; a line starting with
                         "@" sets genres / tags for the songs below it:
                           @ genres: Bollywood, Dance | tags: party, club
  --language hi          language code stored on every song of this run
  --playlist URL         any YouTube playlist / channel URL (repeatable)

Each song is one `ytsearch1:` lookup + one audio download. YouTube's "most
replayed" heatmap comes along in the metadata, so these tracks get a REAL
famous-part marker instead of the computed one.

Resumable: finished lookups are remembered in sources/youtube/done.jsonl.
Throttled on purpose (--workers 3, small sleeps) - hammering YouTube gets the
IP bot-checked. If that happens: wait, lower --workers, or pass
--cookies-from-browser chrome.
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# This network advertises IPv6 but blackholes it: every connection would stall
# until timeout before falling back. Resolve IPv4 only (yt-dlp gets `-4`).
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda host, port, family=0, *a, **k: _getaddrinfo(host, port, socket.AF_INET, *a, **k)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIBRARY = os.environ.get("LIBRARY_DIR") or os.path.join(ROOT, "library")
SRC = os.path.join(LIBRARY, "sources", "youtube")
OUT = os.path.join(LIBRARY, "incoming", "youtube")
VENV = os.path.join(LIBRARY, ".venv")
UA = "EverplayLibrary/1.0 (local research; python-urllib)"

LICENSE = {
    "name": "All rights reserved (local experiment only)",
    "url": None,
    "commercialUse": False,
    "derivatives": False,
}


def strip_wiki(s):
    s = re.sub(r"<ref[^>]*?/>|<ref.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"<[^>]+>|'''?", "", s)
    return re.sub(r"\s+", " ", s).strip(" \"|")


def chart_for_year(year):
    """[(artist, title)] from Wikipedia's Billboard Year-End Hot 100 page."""
    cache = os.path.join(SRC, "charts", f"{year}.json")
    if os.path.exists(cache):
        with open(cache) as f:
            return [tuple(x) for x in json.load(f)]
    page = f"Billboard_Year-End_Hot_100_singles_of_{year}"
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "parse", "page": page, "prop": "wikitext", "format": "json", "redirects": 1}
    )
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    text = ""
    for attempt in range(6):
        try:
            time.sleep(1.5)  # Wikipedia answers bursts with 429
            with urllib.request.urlopen(req, timeout=60) as r:
                text = json.load(r).get("parse", {}).get("wikitext", {}).get("*", "")
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(20 * (attempt + 1))
    # only the chart table - the intro prose is full of quoted song titles too
    start = text.find('{| class="wikitable')
    text = text[start : text.find("\n|}", start)] if start >= 0 else ""
    songs = []
    for row in text.split("\n|-"):
        if 'scope="col"' in row or "{|" in row or row.lstrip().startswith("|+"):
            continue
        # cell attributes (scope="row", rowspan="2") are quoted too - drop them
        row = re.sub(r'\b(?:scope|style|rowspan|colspan|align|class)\s*=\s*"[^"]*"\s*\|?', "", row)
        # cells are separated by "||" or by a newline + "|" / "!"
        cells = [c for c in re.split(r"\|\||\n[|!]", row) if c.strip()]
        for i, cell in enumerate(cells):
            m = re.search(r'"(.+)"', cell, flags=re.S)
            if m and i + 1 < len(cells):
                title = strip_wiki(m.group(1))
                artist = strip_wiki(cells[i + 1].split("|")[-1] if "[[" not in cells[i + 1] else cells[i + 1])
                # rowspan'd artist cells carry attributes before the last "|"
                artist = re.sub(r'^(?:rowspan|scope|style|align)[^|]*\|\s*', "", artist).strip()
                if title and artist and len(title) < 120 and len(artist) < 120:
                    songs.append((artist, title))
                break
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w") as f:
        json.dump(songs, f)
    return songs


def famous_start(heatmap):
    """Most-replayed peak, ignoring the first 10s (intros always spike)."""
    late = [p for p in heatmap if p["start"] > 10]
    return round(max(late, key=lambda p: p["value"])["start"]) if late else None


def ensure_ytdlp():
    """A current yt-dlp in library/.venv. YouTube changes constantly: a build a
    few months old still returns metadata but gets HTTP 403 on the audio, so
    this keeps its own copy fresh instead of trusting whatever is on PATH."""
    if os.environ.get("YTDLP_PATH"):
        return os.environ["YTDLP_PATH"]
    exe = os.path.join(VENV, "bin", "yt-dlp")
    stale = not os.path.exists(exe) or time.time() - os.path.getmtime(exe) > 7 * 86400
    if stale:
        print("installing / updating yt-dlp in library/.venv…")
        if not os.path.exists(os.path.join(VENV, "bin", "pip")):
            subprocess.run([sys.executable, "-m", "venv", VENV], check=True)
        subprocess.run([os.path.join(VENV, "bin", "pip"), "install", "-q", "-U", "yt-dlp"], check=True)
        os.utime(exe)
    return exe


YTDLP = None


def ytdlp(args, timeout=300):
    return subprocess.run(
        [YTDLP, "-4", "--no-warnings", *args], capture_output=True, text=True, timeout=timeout
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--years", default="1980-2024")
    ap.add_argument("--queries")
    ap.add_argument("--language", default="en", help="ISO 639-1 code for the songs of this run")
    ap.add_argument("--tags", default="", help="comma-separated tags added to every song")
    ap.add_argument("--playlist", action="append", default=[])
    ap.add_argument("--limit", type=int, default=0, help="stop after N songs (0 = all)")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--sleep", type=float, default=1.5, help="seconds between a worker's requests")
    ap.add_argument("--cookies-from-browser", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    os.makedirs(SRC, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    global YTDLP
    YTDLP = ensure_ytdlp()
    extra = ["--cookies-from-browser", args.cookies_from_browser] if args.cookies_from_browser else []

    # job = (lookup key, yt-dlp target, artist, title, tags, genres)
    jobs = []
    seen = set()
    base_tags = [t.strip().lower() for t in args.tags.split(",") if t.strip()]

    def add(key, target, artist, title, tags, genres=()):
        k = key.lower()
        if k not in seen:
            seen.add(k)
            jobs.append((key, target, artist, title, [*base_tags, *tags], list(genres)))

    if args.queries:
        section = {"genres": [], "tags": []}
        with open(args.queries) as f:
            for line in f:
                line = line.strip()
                if line.startswith("@"):
                    section = {"genres": [], "tags": []}
                    for part in line[1:].split("|"):
                        name, _, values = part.partition(":")
                        if name.strip() in section:
                            section[name.strip()] = [v.strip() for v in values.split(",") if v.strip()]
                elif line and not line.startswith("#"):
                    artist, _, title = line.partition(" - ")
                    add(
                        line,
                        f"ytsearch1:{line} official audio",
                        artist if title else None,
                        title or None,
                        [t.lower() for t in section["tags"]],
                        section["genres"],
                    )
    for url in args.playlist:
        r = ytdlp(["--flat-playlist", "--print", "%(id)s", url, *extra])
        for vid in r.stdout.split():
            add(f"yt:{vid}", f"https://www.youtube.com/watch?v={vid}", None, None, [])
    if not args.queries and not args.playlist or args.years != "1980-2024":
        lo, _, hi = args.years.partition("-")
        # newest first: recent hits are what people recognise soonest
        for year in range(int(hi or lo), int(lo) - 1, -1):
            try:
                chart = chart_for_year(year)
            except Exception as e:  # noqa: BLE001
                print(f"  chart {year} failed: {e}", file=sys.stderr)
                continue
            for artist, title in chart:
                lead = re.split(r"\s+(?:featuring|feat\.?|with|and|&)\s+|,", artist, flags=re.I)[0]
                add(
                    f"{lead} - {title}",
                    f"ytsearch1:{lead} {title} official audio",
                    artist,
                    title,
                    ["hits", str(year), f"{year // 10 * 10}s"],
                )

    done = set()
    done_path = os.path.join(SRC, "done.jsonl")
    if os.path.exists(done_path):
        with open(done_path) as f:
            done = {json.loads(line)["key"] for line in f if line.strip()}
    todo = [j for j in jobs if j[0] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(jobs)} songs listed, {len(jobs) - len([j for j in jobs if j[0] not in done])} already done, fetching {len(todo)}")
    if args.dry_run:
        for j in todo[:40]:
            print("  ", j[0])
        return

    lock = threading.Lock()
    meta_dir = os.path.join(LIBRARY, "meta")
    blocked = threading.Event()
    refusals = [0]  # consecutive refused downloads, across workers

    def refused(key, why):
        """One 403 under load is normal; a streak means YouTube is saying stop."""
        with lock:
            refusals[0] += 1
            if refusals[0] >= 8:
                blocked.set()
        print(f"  ✗ {key}: {why[:140]}", file=sys.stderr)
        return "blocked" if blocked.is_set() else "error"

    def one(job):
        key, target, artist, title, tags, genres = job
        if blocked.is_set():
            return "blocked"
        cmd = [
            target, "--no-playlist", "--print-json",
            "--match-filter", "duration>60 & duration<600 & !is_live",
            "-f", "bestaudio[ext=m4a]/bestaudio", "-x", "--audio-format", "m4a",
            "-o", os.path.join(OUT, "yt-%(id)s.%(ext)s"),
            *extra,
        ]
        j = None
        for attempt in range(2):
            time.sleep(args.sleep if attempt == 0 else 20)
            r = ytdlp(cmd)
            line = next((ln for ln in r.stdout.splitlines() if ln.startswith("{")), None)
            err = ((r.stderr or "").strip().splitlines()[-1:] or ["no result"])[0]
            if not line:
                if "does not pass filter" in (r.stdout + r.stderr):
                    with lock, open(done_path, "a") as f:
                        f.write(json.dumps({"key": key, "id": None}) + "\n")
                    return "filtered"
                if "not a bot" in err or "429" in err or "403" in err:
                    continue  # refused - pause and try once more
                print(f"  ✗ {key}: {err[:140]}", file=sys.stderr)
                return "error"
            j = json.loads(line)
            # metadata can succeed while the audio is refused - only a file on
            # disk counts, otherwise the song would be marked done forever
            if os.path.exists(os.path.join(OUT, f"yt-{j['id']}.m4a")):
                break
            j = None
        if j is None:
            return refused(key, err)
        with lock:
            refusals[0] = 0
        lid = f"yt-{j['id']}"
        if os.path.exists(os.path.join(meta_dir, f"{lid}.json")):
            # already in the library (e.g. imported from the old cache, or
            # listed under a second singer / section): keep the audio, but
            # let this run's language, genres and tags land on it
            os.remove(os.path.join(OUT, f"{lid}.m4a"))
            with lock:
                with open(os.path.join(meta_dir, f"{lid}.json")) as f:
                    old = json.load(f)
                old["language"] = args.language
                old["genres"] = sorted({*(old.get("genres") or []), *genres})
                old["tags"] = sorted({*(old.get("tags") or []), *tags})
                with open(os.path.join(meta_dir, f"{lid}.json"), "w") as f:
                    json.dump(old, f)
        heatmap = [
            {"start": p["start_time"], "end": p["end_time"], "value": p["value"]}
            for p in (j.get("heatmap") or [])
        ]
        if not os.path.exists(os.path.join(meta_dir, f"{lid}.json")):
            side = {
                "id": lid,
                "kind": "song",
                "title": title or j.get("track") or j.get("title") or "Unknown",
                "artist": artist or j.get("artist") or j.get("channel") or "Unknown",
                "album": j.get("album"),
                "genres": genres,
                "tags": sorted({*tags, *[t.lower() for t in (j.get("tags") or [])[:10]]}),
                "language": args.language,
                "instrumental": False,
                "popularity": j.get("view_count") or 0,
                "license": LICENSE,
                "source": "youtube",
                "sourceUrl": f"https://www.youtube.com/watch?v={j['id']}",
                "heatmap": heatmap,
                "famousStart": famous_start(heatmap),
            }
            side_path = os.path.join(OUT, f"{lid}.json")
            with lock:
                if os.path.exists(side_path):
                    # same recording listed twice and not ingested yet
                    with open(side_path) as f:
                        prev = json.load(f)
                    side["genres"] = sorted({*prev.get("genres", []), *genres})
                    side["tags"] = sorted({*prev.get("tags", []), *side["tags"]})
                with open(side_path, "w") as f:
                    json.dump(side, f)
        with lock, open(done_path, "a") as f:
            f.write(json.dumps({"key": key, "id": lid}) + "\n")
        return "ok"

    counts = {"ok": 0, "filtered": 0, "error": 0, "blocked": 0}
    t0 = time.time()
    with cf.ThreadPoolExecutor(args.workers) as ex:
        for i, fut in enumerate(cf.as_completed([ex.submit(one, j) for j in todo]), 1):
            try:
                counts[fut.result()] += 1
            except Exception as e:  # noqa: BLE001
                counts["error"] += 1
                print(f"  error: {e}", file=sys.stderr)
            if i % 20 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}  {counts}  {time.time() - t0:.0f}s", flush=True)
    if blocked.is_set():
        print("YouTube refused the audio (403 / bot check) - stopped early. Wait a while and re-run; it\n"
              "resumes where it left off.", file=sys.stderr)
    print(f"done → {OUT}\nnext: npm run library:ingest")


if __name__ == "__main__":
    main()
