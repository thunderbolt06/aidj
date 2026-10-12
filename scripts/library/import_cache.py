#!/usr/bin/env python3
"""
Bring the songs the old YouTube-extractor build already downloaded
(.cache/audio + .cache/meta) into the library - no network needed, and each
keeps its real "most replayed" heatmap.

The library is English-focused, so tracks that look like they come from the
Indian-catalogue tests (label channels, Indic script, pipe-separated label
titles) are left out unless you pass --all. Files are copied, never moved.
Then run: npm run library:ingest
"""
import argparse
import json
import os
import re
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIBRARY = os.environ.get("LIBRARY_DIR") or os.path.join(ROOT, "library")
CACHE = os.path.join(ROOT, ".cache")
OUT = os.path.join(LIBRARY, "incoming", "youtube")

LABELS = re.compile(
    r"t-series|zee music|sony music india|saregama|tips (official|music)|yrf|goldmines|speed records|"
    r"eros now|shemaroo|venus|ultra bollywood|desi music|white hill|geet mp3|aditya music|lahari|"
    r"think music|sun tv|mc stan|ap ?dhillon|coke studio|bollywood|punjabi|hindi|tamil|telugu",
    re.I,
)
INDIC = re.compile(r"[ऀ-෿]")
NOISE = re.compile(
    r"\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali[sz]er|remaster|hd|4k|hq|mv)[^\)\]]*[\)\]]", re.I
)


def looks_english(meta):
    blob = f"{meta.get('artist', '')} {meta.get('title', '')}"
    return not (LABELS.search(blob) or INDIC.search(blob) or meta.get("title", "").count(" | ") >= 2)


def clean(meta):
    title = NOISE.sub("", meta.get("title", "")).strip()
    channel = re.sub(r"\s*(- Topic|VEVO|Official)$", "", meta.get("artist", "Unknown"), flags=re.I).strip()
    if " - " in title:
        artist, _, song = title.partition(" - ")
        return artist.strip(), song.strip(' "')
    return channel, title


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="include tracks that do not look English")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    audio_dir = os.path.join(CACHE, "audio")
    counts = {"imported": 0, "skipped_language": 0, "no_meta": 0, "already": 0}
    os.makedirs(OUT, exist_ok=True)
    for name in sorted(os.listdir(audio_dir)) if os.path.isdir(audio_dir) else []:
        vid, _, ext = name.rpartition(".")
        if ext not in ("m4a", "mp3", "webm", "opus"):
            continue
        meta_path = os.path.join(CACHE, "meta", f"{vid}.json")
        if not os.path.exists(meta_path):
            counts["no_meta"] += 1
            continue
        with open(meta_path) as f:
            meta = json.load(f)
        if not args.all and not looks_english(meta):
            counts["skipped_language"] += 1
            continue
        lid = f"yt-{vid}"
        if os.path.exists(os.path.join(LIBRARY, "meta", f"{lid}.json")) or os.path.exists(os.path.join(OUT, f"{lid}.json")):
            counts["already"] += 1
            continue
        counts["imported"] += 1
        if args.dry_run:
            continue
        artist, title = clean(meta)
        with open(os.path.join(OUT, f"{lid}.json"), "w") as f:
            json.dump(
                {
                    "id": lid,
                    "kind": "song",
                    "title": title,
                    "artist": artist,
                    "album": None,
                    "genres": [],
                    "tags": ["hits"],
                    "language": "en" if looks_english(meta) else None,
                    "instrumental": False,
                    # no view counts in the old cache: rank these with the chart songs
                    "popularity": 1_000_000,
                    "license": {
                        "name": "All rights reserved (local experiment only)",
                        "url": None,
                        "commercialUse": False,
                        "derivatives": False,
                    },
                    "source": "youtube",
                    "sourceUrl": f"https://www.youtube.com/watch?v={vid}",
                    "heatmap": meta.get("heatmap") or [],
                    "famousStart": meta.get("famousStart"),
                },
                f,
            )
        shutil.copyfile(os.path.join(audio_dir, name), os.path.join(OUT, f"{lid}.{ext}"))
    print(counts)


if __name__ == "__main__":
    main()
