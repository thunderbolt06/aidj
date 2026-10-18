#!/usr/bin/env python3
"""
Vocal map: where in each song someone is singing.

Runs Demucs (htdemucs) source separation on every song, measures the loudness
of the isolated vocal stem 10 times a second, and stores in
library/meta/<id>.json:
  vocals      [[start, end], ...] seconds - the sung stretches (lines)
  vocalLevel  vocal loudness 10x a second, whole dB relative to the song's
              loud singing (0 = loud, -40 = silent). `vocals` is derived from
              it alone, so `--resegment` re-tunes every song in seconds
              without another day of separation. Never sent to the app.
The stems themselves are thrown away (~10 KB per song is kept).

The auto-DJ uses the gaps between the lines as exit points: a vocal line ends,
the band plays on for a few bars, and that is where the next song comes in -
no word cut in half, no two singers on top of each other (lib/audio/vocalExits.ts).

    npm run library:vocals                      # every song still missing a map
    npm run library:vocals -- --limit 50        # a quick sample
    npm run library:vocals -- --ids yt-abc,yt-def --force
    npm run library:vocals -- --source fma      # the open-licence crate
    npm run library:vocals -- --shard 0/2 & npm run library:vocals -- --shard 1/2
    npm run library:vocals -- --resegment       # re-derive `vocals` only

Commercial (yt-*) songs go first, most popular first. Resumable: songs that
already have a map are skipped, and each meta file is updated in place
(re-read right before the write, so other pipelines' edits survive).
~5 s per song on an M4 Max (MPS); falls back to CPU, which is far slower.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIB = os.environ.get("LIBRARY_DIR") or os.path.join(ROOT, "library")
FFMPEG = os.environ.get("FFMPEG_PATH", "ffmpeg")
MODEL = "htdemucs"
VERSION = 2  # bump when the stored format changes; older maps get redone

FPS = 10  # vocal level frames per second
# a frame counts as sung when the vocal stem is within this many dB of the
# song's loud singing (95th percentile) - the gaps barely move between -20
# and -25, so this sits in the middle
REL_DB = -22
# rap and dense pop never drop that far - backing vocals and reverb fill the
# breaths - so a dip this far below the line's own peak (within +-1.5 s) also
# ends a line. Instrumental breaks come out the same either way.
LOCAL_DROP = 12
LOCAL_WIN = 1.5
# a 0.3 s breath already separates two lines in dense pop, so only shorter
# dips (inside a word) are merged
MERGE_GAP = 0.25
MIN_SEG = 0.3  # shorter blips are hi-hat/synth bleed into the stem
LEVEL_FLOOR = -40


def relative_db(level: np.ndarray):
    """Vocal level in dB relative to the song's loud singing, or None if silent."""
    db = 20 * np.log10(level + 1e-6)
    audible = db[db > -70]
    if audible.size < FPS * 5:
        return None
    return db - np.percentile(audible, 95)


def level_curve(rel) -> list:
    if rel is None:
        return []
    return [int(v) for v in np.clip(np.round(rel), LEVEL_FLOOR, 0)]


def segments(level: list) -> list:
    """Sung stretches from a stored vocalLevel curve (10 fps, dB)."""
    rel = np.asarray(level, dtype=float)
    w = int(LOCAL_WIN * FPS)
    if rel.size <= 2 * w:
        return []
    padded = np.pad(rel, w, constant_values=LEVEL_FLOOR)
    local_peak = np.lib.stride_tricks.sliding_window_view(padded, 2 * w + 1).max(1)
    on = (rel > REL_DB) & (rel > local_peak - LOCAL_DROP)
    segs = []
    start = None
    for i, active in enumerate(on):
        if active and start is None:
            start = i
        elif not active and start is not None:
            segs.append([start, i])
            start = None
    if start is not None:
        segs.append([start, len(on)])
    merged = []
    for a, b in segs:
        if merged and a - merged[-1][1] < MERGE_GAP * FPS:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [[round(a / FPS, 1), round(b / FPS, 1)] for a, b in merged if b - a >= MIN_SEG * FPS]


def decode(path: str, sr: int) -> np.ndarray:
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def vocal_level(model, device: str, wav: np.ndarray) -> np.ndarray:
    import torch
    from demucs.apply import apply_model

    x = torch.from_numpy(wav)
    ref = x.mean(0)
    x = (x - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        out = apply_model(model, x[None].to(device), device=device, shifts=0, split=True, overlap=0.1, progress=False)[0]
    voc = out[model.sources.index("vocals")].mean(0).cpu().numpy()
    hop = model.samplerate // FPS
    n = len(voc) // hop
    return np.sqrt((voc[: n * hop].reshape(n, hop) ** 2).mean(1))


def write_meta(meta_path: str, vocals: list, level: list):
    # re-read: fetch_covers / labelers may have touched the file meanwhile
    with open(meta_path) as f:
        meta = json.load(f)
    meta["vocals"] = vocals
    meta["vocalLevel"] = level
    meta["vocalsModel"] = MODEL
    meta["vocalsVersion"] = VERSION
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(meta_path), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(meta, f)
    os.replace(tmp, meta_path)


def pick(args) -> list:
    with open(os.path.join(LIB, "catalog.json")) as f:
        rows = json.load(f)["tracks"]
    if args.ids:
        wanted = set(args.ids.split(","))
        rows = [r for r in rows if r["id"] in wanted]
    else:
        prefix = {"yt": ("yt-",), "fma": ("fma-",), "all": ("yt-", "fma-")}[args.source]
        rows = [
            r for r in rows
            if r.get("kind") == "song" and r["id"].startswith(prefix) and not r.get("instrumental")
        ]
        # chart songs before open-licence ones, then most played first
        rows.sort(key=lambda r: (not r["id"].startswith("yt-"), -(r.get("popularity") or 0)))
    todo = []
    for r in rows:
        meta_path = os.path.join(LIB, "meta", f"{r['id']}.json")
        if not os.path.exists(meta_path):
            continue
        if not args.force:
            with open(meta_path) as f:
                if json.load(f).get("vocalsVersion", 0) >= VERSION:
                    continue
        todo.append((r["id"], r["file"], meta_path))
    i, n = (int(v) for v in args.shard.split("/"))
    todo = todo[i::n]
    return todo[: args.limit] if args.limit else todo


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["yt", "fma", "all"], default="yt")
    ap.add_argument("--ids", help="comma-separated ids (ignores --source)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true", help="redo songs that already have a map")
    ap.add_argument("--shard", default="0/1", help="i/n: take every n-th song from i (parallel runs)")
    ap.add_argument("--resegment", action="store_true", help="re-derive `vocals` from stored levels, no separation")
    args = ap.parse_args()
    if args.resegment:
        return resegment()

    import torch
    from demucs.pretrained import get_model

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = get_model(MODEL)
    model.to(device).eval()
    todo = pick(args)
    print(f"{len(todo)} songs to map on {device}", flush=True)

    # decode the next song on a thread while the GPU separates this one
    pool = ThreadPoolExecutor(max_workers=2)
    started = time.time()
    done = failed = 0
    nxt = pool.submit(decode, os.path.join(LIB, "audio", todo[0][1]), model.samplerate) if todo else None
    for i, (tid, file, meta_path) in enumerate(todo):
        fut = nxt
        if i + 1 < len(todo):
            nxt = pool.submit(decode, os.path.join(LIB, "audio", todo[i + 1][1]), model.samplerate)
        try:
            wav = fut.result()
            level = level_curve(relative_db(vocal_level(model, device, wav)))
            write_meta(meta_path, segments(level), level)
            done += 1
        except Exception as e:  # one bad file must not stop a day-long run
            failed += 1
            print(f"FAIL {tid}: {e}", flush=True)
            continue
        if done % 25 == 0 or i == len(todo) - 1:
            rate = (time.time() - started) / max(done, 1)
            left = (len(todo) - i - 1) * rate / 3600
            print(f"{done} mapped, {failed} failed, {rate:.1f}s/song, ~{left:.1f}h left", flush=True)
    print(f"finished: {done} mapped, {failed} failed", flush=True)


def resegment():
    meta_dir = os.path.join(LIB, "meta")
    n = 0
    for name in sorted(os.listdir(meta_dir)):
        if not name.endswith(".json"):
            continue
        meta_path = os.path.join(meta_dir, name)
        with open(meta_path) as f:
            meta = json.load(f)
        if meta.get("vocalsVersion", 0) < VERSION:
            continue
        write_meta(meta_path, segments(meta["vocalLevel"]), meta["vocalLevel"])
        n += 1
    print(f"re-derived vocals for {n} songs", flush=True)


if __name__ == "__main__":
    sys.exit(main())
