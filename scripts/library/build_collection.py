#!/usr/bin/env python3
"""
Turn a list of artists into fetch lists for fetch_youtube.py.

For every artist in the seeds file this asks Apple's public catalogue (the
iTunes Search API - no key) for their songs, which come back most popular
first with a genre and a release year, keeps the top N, and writes one
"Artist - Title | genres: … | tags: …" line per song:

  npm run library:collection
    scripts/library/collections/indian.seeds.txt
      → collections/hindi_wide.txt   (language hi)
      → collections/punjabi.txt      (language pa)

Only names and metadata come from the catalogue; the audio is still fetched
by fetch_youtube.py, so the same local-experiment rules apply.

What is dropped: songs on the hand-written lists (--skip), other-language releases of
multilingual singers (Tamil, Telugu, …), remixes / lofi / karaoke cuts, and
artists whose match in the catalogue is clearly someone else (a Western act
sharing the name) - those are listed at the end so the seeds can be fixed.
An artist the catalogue files under a generic genre fails that test too: mark
a distinctive name with a trailing " *" in the seeds to take it regardless.

Resumable: every catalogue answer is cached in library/sources/itunes/.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import netfamily

# only one IP family reaches the internet here
netfamily.pin("itunes.apple.com")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LIBRARY = os.environ.get("LIBRARY_DIR") or os.path.join(ROOT, "library")
CACHE = os.path.join(LIBRARY, "sources", "itunes")
UA = "EverplayLibrary/1.0 (local research; python-urllib)"

# catalogue genre → the genre the library files it under
GENRE_MAP = {
    "Bollywood": "Bollywood",
    "Punjabi": "Punjabi",
    "Punjabi Pop": "Punjabi Pop",
    "Indian Pop": "Indian Pop",
    "Ghazals": "Ghazal",
    "Sufi": "Sufi",
    "Devotional & Spiritual": "Devotional",
    "Indian Classical": "Classical",
    "Hindustani Classical": "Classical",
    "Indian Folk": "Folk",
    "Hip-Hop/Rap": "Hip-Hop",
    "Urdu": "Urdu",
}
# enough of these among an artist's songs means the match is the right person
INDIAN = {*GENRE_MAP, "Indian", "Haryanvi", "Rajasthani", "Regional Indian"} - {"Hip-Hop/Rap"}
PUNJABI = {"Punjabi", "Punjabi Pop"}
OTHER_LANGUAGE = {
    "Tamil", "Telugu", "Malayalam", "Kannada", "Bengali", "Marathi", "Gujarati", "Odia",
    "Assamese", "Bhojpuri", "Carnatic Classical", "Tollywood", "Kollywood", "Mollywood",
    "Sandalwood", "Rabindra Sangeet",
}
SKIP_GENRE = {"Karaoke", "Instrumental", "Children's Music", "Spoken Word", "Comedy", "Fitness & Workout"}
SKIP_TEXT = re.compile(
    r"\b(remix(ed)?|re-?mix|lo-?fi|slowed|reverb|instrumental|karaoke|8d|mashup|jukebox|dialogues?|"
    r"reprise|version|medley|live|cover|flip|edit|sped up|mix|unplugged|acoustic|interlude|intro|outro|"
    r"skit|commentary|tamil|telugu|malayalam|kannada|bengali|marathi|gujarati|bhojpuri)\b",
    re.I,
)


def norm(s):
    s = re.sub(r"[\(\[].*?[\)\]]", "", s.lower())
    return re.sub(r"[^a-z0-9]+", "", s.replace("&", "").replace(" and ", ""))


def clean_title(t):
    """'Kesariya (From "Brahmastra")' → 'Kesariya'."""
    t = re.sub(r"\s*[\(\[].*?[\)\]]", "", t)
    return re.sub(r"\s+", " ", t.replace("|", " ")).strip(" -")


last_call = [0.0]


def api(path, params, cache_name, pause):
    """One catalogue call, cached on disk. The API allows ~20 calls a minute."""
    file = os.path.join(CACHE, cache_name)
    if os.path.exists(file):
        with open(file) as f:
            return json.load(f)
    url = f"https://itunes.apple.com/{path}?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        time.sleep(max(0, last_call[0] + pause - time.time()))
        last_call[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            if e.code not in (403, 429, 502, 503) or attempt == 5:
                raise
            time.sleep(30 * (attempt + 1))  # rate-limited: back off and retry
        except (urllib.error.URLError, TimeoutError):
            if attempt == 5:
                raise
            time.sleep(10)
    with open(file, "w") as f:
        json.dump(data, f)
    return data


def read_seeds(path):
    """[(artist, section)] in file order."""
    section = {"language": "hi", "genres": [], "tags": [], "top": 25}
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("@"):
                section = {"language": "hi", "genres": [], "tags": [], "top": 25}
                for part in line[1:].split("|"):
                    name, _, value = part.partition(":")
                    name, value = name.strip(), value.strip()
                    if name in ("genres", "tags"):
                        section[name] = [v.strip() for v in value.split(",") if v.strip()]
                    elif name == "top":
                        section["top"] = int(value)
                    elif name == "language":
                        section["language"] = value
            elif line and not line.startswith("#"):
                out.append((line, section))
    return out


def songs_of(artist, country, pause, trusted=False):
    """The catalogue's songs for the best-matching artist, most popular first."""
    found = api(
        "search",
        {"term": artist, "entity": "musicArtist", "limit": 10, "country": country},
        f"artist-{norm(artist)}.json",
        pause,
    ).get("results", [])
    exact = [a for a in found if norm(a.get("artistName", "")) == norm(artist)]
    # same-named acts: the one filed under an Indian genre first
    candidates = sorted(exact or found[:1], key=lambda a: a.get("primaryGenreName") not in INDIAN)
    if trusted and not exact:
        return None  # a trusted name is taken on its spelling alone, so it must match
    for cand in candidates[:3]:
        rows = api(
            "lookup",
            {"id": cand["artistId"], "entity": "song", "limit": 200, "country": country},
            f"songs-{cand['artistId']}.json",
            pause,
        ).get("results", [])
        tracks = [r for r in rows if r.get("wrapperType") == "track"]
        indian = sum(1 for t in tracks if t.get("primaryGenreName") in INDIAN)
        if tracks and (trusted or cand.get("primaryGenreName") in INDIAN or indian >= 0.15 * len(tracks)):
            return tracks
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("seeds")
    ap.add_argument("--out", action="append", required=True, metavar="LANG=FILE[:MAX]",
                    help="where each language's list goes, e.g. hi=collections/hindi_wide.txt:3500")
    ap.add_argument("--skip", action="append", default=[], metavar="FILE",
                    help="a hand-written list whose songs must not be listed again")
    ap.add_argument("--country", default="in", help="storefront whose popularity order is used")
    ap.add_argument("--pause", type=float, default=3.1, help="seconds between catalogue calls")
    args = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)

    outs = {}
    for spec in args.out:
        lang, _, rest = spec.partition("=")
        file, _, cap = rest.partition(":")
        outs[lang] = (file, int(cap) if cap else 0)

    # never list again: songs of the hand-written lists (by title - the same
    # song is credited to a different singer as often as not) and songs the
    # library holds in another language (a chart hit by a same-named act)
    have_titles, have_pairs = set(), set()
    for path in args.skip:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and line[0] not in "#@":
                    have_titles.add(norm(line.split(" | ")[0].partition(" - ")[2]))
    catalog = os.path.join(LIBRARY, "catalog.json")
    if os.path.exists(catalog):
        with open(catalog) as f:
            for r in json.load(f)["tracks"]:
                if r["kind"] == "song" and r.get("source") == "youtube" and r.get("language") not in outs:
                    have_pairs.add((norm(r["title"]), norm(r["artist"])))

    seeds = read_seeds(args.seeds)
    picked = {lang: [] for lang in outs}  # (rank within artist, line)
    seen = {lang: set() for lang in outs}
    missing = []
    for n, (artist, section) in enumerate(seeds, 1):
        # "Name *" in the seeds: the catalogue files this act under a generic
        # genre (Alternative, Hip-Hop/Rap), so skip the is-this-the-right-act test
        trusted = artist.endswith("*")
        artist = artist.rstrip("* ")
        try:
            tracks = songs_of(artist, args.country, args.pause, trusted)
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {artist}: {e}", file=sys.stderr)
            tracks = None
        if not tracks:
            missing.append(artist)
            continue
        kept = 0
        for t in tracks:
            if kept >= section["top"]:
                break
            genre = t.get("primaryGenreName") or ""
            title = clean_title(t.get("trackName") or "")
            text = f"{t.get('trackName', '')} {t.get('collectionName', '')}"
            ms = t.get("trackTimeMillis") or 0
            if genre in OTHER_LANGUAGE or genre in SKIP_GENRE or SKIP_TEXT.search(text):
                continue
            if not title or not (90_000 <= ms <= 480_000):
                continue
            lang = "pa" if genre in PUNJABI and "pa" in outs else section["language"]
            if lang not in outs:
                continue
            # by title alone: a duet shows up under both singers, and two
            # listings of one song cost a download each. The price is the odd
            # different song that shares a title.
            key = norm(title)
            if not key or (key, norm(artist)) in have_pairs or key in have_titles or key in seen[lang]:
                continue
            seen[lang].add(key)
            year = int((t.get("releaseDate") or "0")[:4] or 0)
            tags = list(section["tags"])
            if 1940 <= year <= 2100:
                tags.append(f"{year // 10 * 10}s" if year >= 2000 else f"{year // 10 % 10 * 10}s")
            genres = list(dict.fromkeys([*section["genres"], *([GENRE_MAP[genre]] if genre in GENRE_MAP else [])]))
            line = f"{artist} - {title} | genres: {', '.join(genres)} | tags: {', '.join(tags)}"
            picked[lang].append((kept, line))
            kept += 1
        if n % 20 == 0 or n == len(seeds):
            print(f"  {n}/{len(seeds)} artists  " + "  ".join(f"{k}: {len(v)}" for k, v in picked.items()), flush=True)

    for lang, (file, cap) in outs.items():
        # every artist's biggest song first, then everyone's second, …: an
        # interrupted download (or a cap) loses the deep cuts, not the hits
        rows = [line for _, line in sorted(picked[lang], key=lambda p: p[0])]
        if cap:
            rows = rows[:cap]
        with open(file, "w") as f:
            f.write(
                f"# Generated by scripts/library/build_collection.py from {os.path.basename(args.seeds)} - edit the\n"
                f"# seeds and re-run rather than editing this file. {len(rows)} songs, language {lang}.\n\n"
            )
            f.write("\n".join(rows) + "\n")
        print(f"{lang}: {len(rows)} songs → {file}")
    if missing:
        print(f"no usable catalogue match for {len(missing)} artists: {', '.join(missing)}")


if __name__ == "__main__":
    main()
