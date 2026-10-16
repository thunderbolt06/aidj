#!/usr/bin/env python3
"""
A contact sheet of song covers, each captioned with the song and where its cover came
from - for checking fetch_covers.py's choices by eye.

  python3 scripts/library/cover_sheet.py --out sheet.jpg --sample 48            # random mix
  python3 scripts/library/cover_sheet.py --out sheet.jpg --status itunes --conf medium --sample 48
  python3 scripts/library/cover_sheet.py --out sheet.jpg --status ytmusic --sample 48
  python3 scripts/library/cover_sheet.py --out sheet.jpg --status youtube --kind frame --sample 48
  python3 scripts/library/cover_sheet.py --out sheet.jpg --ids yt-abc yt-def
  python3 scripts/library/cover_sheet.py --out sheet.jpg --sample 48 --offset 48   # the next page

Each cell is numbered; the numbers and ids are printed ("#3 yt-abc"). Caption lines: "title - artist" of
the library's song, then "itunes/high" (or ytmusic / youtube/frame), then the matched track as the store
names it. Needs Pillow.
"""
import argparse
import json
import os
import random

from PIL import Image, ImageDraw, ImageFont

LIBRARY = os.path.abspath(os.environ.get("LIBRARY_DIR") or os.path.join(os.path.dirname(__file__), "..", "..", "library"))


def font(size):
    for name in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def clip(draw, text, fnt, width):
    if draw.textlength(text, font=fnt) <= width:
        return text
    while text and draw.textlength(text + "...", font=fnt) > width:
        text = text[:-1]
    return text + "..."


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ids", nargs="*")
    ap.add_argument("--sample", type=int, default=48)
    ap.add_argument("--offset", type=int, default=0, help="skip this many of the (seeded) picks, for paging")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--status", choices=["itunes", "ytmusic", "youtube", "none"])
    ap.add_argument("--conf", choices=["high", "medium"])
    ap.add_argument("--kind", choices=["art", "frame"])
    ap.add_argument("--language")
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--cell", type=int, default=250, help="cover size in px")
    args = ap.parse_args()

    with open(os.path.join(LIBRARY, "catalog.json")) as f:
        catalog = {r["id"]: r for r in json.load(f)["tracks"] if r["kind"] == "song"}
    manifest = {}
    path = os.path.join(LIBRARY, "sources", "covers", "manifest.jsonl")
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                manifest[d["id"]] = d

    if args.ids:
        ids = args.ids
    else:
        ids = [i for i in catalog if i in manifest]
        pick = lambda m: (
            (not args.status or m["status"] == args.status)
            and (not args.conf or m.get("conf") == args.conf)
            and (not args.kind or m.get("kind") == args.kind)
        )
        ids = [i for i in ids if pick(manifest[i]) and (not args.language or catalog[i].get("language") == args.language)]
        random.Random(args.seed).shuffle(ids)
        ids = ids[args.offset : args.offset + args.sample]

    cell, cols, pad, cap = args.cell, args.cols, 10, 64
    rows = (len(ids) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cell + pad) + pad, rows * (cell + cap + pad) + pad), (24, 24, 27))
    draw = ImageDraw.Draw(sheet)
    f1, f2 = font(14), font(12)
    for n, cid in enumerate(ids):
        x = pad + (n % cols) * (cell + pad)
        y = pad + (n // cols) * (cell + cap + pad)
        try:
            img = Image.open(os.path.join(LIBRARY, "covers", f"{cid}.jpg")).convert("RGB").resize((cell, cell), Image.LANCZOS)
            sheet.paste(img, (x, y))
        except OSError:
            draw.rectangle((x, y, x + cell, y + cell), outline=(200, 60, 60))
        draw.rectangle((x, y, x + 34, y + 18), fill=(0, 0, 0))
        draw.text((x + 4, y + 2), f"#{n + 1}", fill=(255, 255, 255), font=f2)
        print(f"#{n + 1} {cid}")
        r, m = catalog.get(cid, {}), manifest.get(cid, {})
        draw.text((x, y + cell + 4), clip(draw, f"{r.get('title', cid)} - {r.get('artist', '')}", f1, cell), fill=(244, 244, 245), font=f1)
        src = f"{m.get('status', '?')}/{m.get('conf') or m.get('kind') or ''}"
        mt = m.get("match") or {}
        detail = f"{mt.get('title', '')} - {mt.get('artist', '')} | {mt.get('album', '')}" if mt else ""
        draw.text((x, y + cell + 22), clip(draw, src, f2, cell), fill=(250, 204, 21), font=f2)
        draw.text((x, y + cell + 38), clip(draw, detail, f2, cell), fill=(161, 161, 170), font=f2)
    sheet.save(args.out, quality=85)
    print(f"{len(ids)} covers -> {args.out} ({sheet.size[0]}x{sheet.size[1]})")


if __name__ == "__main__":
    main()
