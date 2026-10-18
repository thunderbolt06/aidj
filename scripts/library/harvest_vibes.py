#!/usr/bin/env python3
"""
Vibe playlists: what people actually file under each vibe chip.

The vibe chips (lib/vibes.json) used to be turned into a genre / tag filter,
which the chart songs barely carry - so every vibe came back as the same
most-viewed handful, mostly decades old. Public playlists know better: a
song that sits in eight "road trip" playlists made this year IS a road-trip
song. This script reads those playlists; lib/server/vibes.ts picks from them.

  harvest   search YouTube for public playlists per vibe and language, read
            their songs   -> library/sources/vibes/<YYYY-MM>/
  wanted    the songs those playlists rank highly that the library lacks, in
            fetch_youtube.py --queries format -> .../<YYYY-MM>/wanted.txt
            (--topup N: a vibe asks only for what it lacks to reach N library
            songs, so downloads go where the pool is thin; every vibe is
            guaranteed a share of the cap, not just the biggest hits)
  index     match every playlist song to a library track -> library/vibes.json
            (and vibes.public.json without the yt-* rows)

  npm run library:vibes        harvest + download + ingest + index (+ upload),
                               the monthly routine (refresh_vibes.sh)
  python3 scripts/library/harvest_vibes.py harvest --only "road trip"

A month's harvest is kept per folder, so a vibe whose search fails this month
falls back to the last month that worked instead of losing its songs.
"""
import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import functools
import json
import os
import re
import sys
import threading
import unicodedata
import urllib.parse

import fetch_youtube as fy  # pins the working IP family on import

ROOT = fy.ROOT
LIBRARY = fy.LIBRARY
VIBES_FILE = os.path.join(ROOT, "lib", "vibes.json")
SEEDS_FILE = os.path.join(ROOT, "scripts", "library", "collections", "indian.seeds.txt")
SRC = os.path.join(LIBRARY, "sources", "vibes")

LANG_WORD = {"en": "english", "hi": "hindi", "pa": "punjabi"}
# a label with one of these already says which language it wants
IMPLIES = {
    "hi": {"bollywood", "hindi", "desi", "sufi", "ghazal", "pakistani", "haryanvi", "sangeet", "shaadi"},
    "pa": {"punjabi", "bhangra"},
}
# playlist titles naming another language belong to that language's crowd -
# YouTube answers this Mac's searches with Indian results first
MARKERS = {
    "tamil", "telugu", "kannada", "malayalam", "marathi", "bhojpuri", "bengali", "bangla",
    "gujarati", "odia", "oriya", "assamese", "nepali", "sinhala", "urdu", "haryanvi", "punjabi",
    "hindi", "bollywood", "desi", "tollywood", "kollywood", "sandalwood", "mollywood", "lollywood",
    "pakistani", "bhangra", "pahadi", "garhwali", "rajasthani", "himachali", "korean", "kpop",
    "japanese", "jpop", "anime", "chinese", "cpop", "mandarin", "arabic", "spanish", "latino",
    "latina", "reggaeton", "espanol", "french", "francais", "german", "deutsch", "italian",
    "italiano", "turkish", "russian", "brasil", "brazilian", "portuguese", "sertanejo",
    "filipino", "tagalog", "opm", "indonesian", "thai", "vietnamese", "persian", "kurdish",
}
ALLOWED = {
    "en": set(),
    "hi": {"hindi", "bollywood", "desi", "urdu", "pakistani", "haryanvi", "punjabi", "lollywood"},
    "pa": {"punjabi", "bhangra", "desi", "hindi", "bollywood", "haryanvi", "pakistani"},
}
# scripts a playlist entry may be written in, per vibe language
SCRIPTS = {
    "en": re.compile(r"^[\u0000-ɏ -⁯\s]*$"),
    "hi": re.compile(r"^[\u0000-ɏऀ-ॿ -⁯\s]*$"),
    "pa": re.compile(r"^[\u0000-ɏऀ-ॿ਀-੿ -⁯\s]*$"),
}
# playlists about something no vibe is: worship music turns up for "devotional
# morning", American holiday sets for "patriotic anthems"
OFF_THEME = re.compile(r"\b(?:christian|worship|gospel|church|jesus|hymns?|4th of july|fourth of july|veterans?)\b", re.I)
ONE_LONG_VIDEO = re.compile(r"jukebox|non ?-?stop|mashup|full album|\b\d+\s*(?:hour|hr)s?\b|megamix|back ?to ?back", re.I)
# a re-recording of the song rather than the song: search for the original
NOT_ORIGINAL = re.compile(r"slowed|reverb|sped ?up|nightcore|\b8d\b|lo-?fi|remix|cover|karaoke|instrumental|unplugged|reprise", re.I)
SEARCH_URL = "https://www.youtube.com/results?search_query={q}&sp=EgIQAw%253D%253D"  # playlists only

PLAYLISTS_PER_VIBE = 10
ENTRIES_PER_PLAYLIST = 150
STALE_DAYS = 3 * 365  # a playlist nobody touched in three years is a time capsule


def slug(label):
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")


def month_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")


def load_vibes():
    """[(label, lang)] - every vibe in every language it is harvested in."""
    with open(VIBES_FILE) as f:
        v = json.load(f)
    out = [(label, "en") for label in v["general"]]
    out += [(label, lang) for label in v["anyLanguage"] for lang in ("hi", "pa")]
    out += [(label, "hi") for label in v["hindi"]]
    out += [(label, "pa") for label in v["punjabi"]]
    return out, v.get("search", {})


@functools.lru_cache(maxsize=1)
def vibe_lists():
    with open(VIBES_FILE) as f:
        return json.load(f)


def native(label):
    """A vibe that only exists in Hindi or Punjabi: its search overrides are already in that language."""
    v = vibe_lists()
    return label in v["hindi"] or label in v["punjabi"]


def curated(label):
    """Vibes whose playlists are one channel's uploads by nature (lofi, ambient, royalty-free):
    a channel dominating the list is the genre, not a sign of an artist catalogue."""
    return label in vibe_lists().get("curated", [])


def queries(label, lang, search):
    words = set(re.findall(r"[a-z]+", label.lower()))
    own = search.get(label)
    # a year in the search finds the playlists people keep updating, not the
    # "greatest driving songs of all time" ones that are all 70s rock
    year = dt.date.today().year
    if lang == "en":
        return (own or [f"{label} songs playlist", f"{label} playlist"]) + [f"{label} songs {year}"]
    word = LANG_WORD[lang]
    # an English label searched in Hindi finds other people's "Chill" playlists:
    # "<label>|<lang>" gives the phrasing that language's curators actually use
    own_lang = search.get(f"{label}|{lang}")
    if own_lang:
        return own_lang + [f"{label} {word} songs {year}"]
    if own and native(label):
        # the year search must name the language too: "70s evergreen songs 2026"
        # alone finds English chart playlists ("Best Music 2000 to 2026")
        return own + [f"{label} {word} songs {year}"]
    if words & IMPLIES[lang]:
        return (own or [f"{label} songs playlist", f"best {label} songs"]) + [f"{label} songs {year}"]
    # "late night chill" in Hindi: say so, or the search answers in English
    return [f"{label} {word} songs playlist", f"{word} {label} songs", f"{label} {word} songs {year}"]


# ── text normalisation, shared by matching and parsing ─────────────────────

def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("&", " and ").replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9ऀ-੿]+", " ", s).strip()


# "with" splits artists ("Kygo with ...") but is part of titles ("Here With Me")
FEAT = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|prod\.?)\s+.*$", re.I)


def norm_title(s):
    s = re.sub(r"[\(\[\{][^\)\]\}]*[\)\]\}]", " ", s or "")
    s = re.sub(r"\s+-\s+(?:remaster|live|radio edit|single version|from ).*$", "", s, flags=re.I)
    s = FEAT.sub("", s)
    t = norm(s)
    return t[4:] if t.startswith("the ") else t


ARTIST_SPLIT = re.compile(r",|&|\s+(?:and|x|feat\.?|ft\.?|featuring|with|vs\.?)\s+", re.I)


def split_artists(s):
    return [a for a in (norm(p) for p in ARTIST_SPLIT.split(s or "")) if len(a) >= 2]


def contains(hay, needle):
    return f" {needle} " in f" {hay} "


JUNK = re.compile(
    r"\b(?:official\s+(?:music\s+|lyrical?\s+)?(?:video|audio|song|visuali[sz]er)|full\s+(?:hd\s+)?(?:song|video|audio)"
    r"|lyrics?\s+video|lyrical(?:\s+(?:video|song))?|with lyrics|video song|audio song|music video"
    r"|[48]k(?:\s+video)?|hd|hq|latest\s+(?:punjabi|hindi|bollywood)\s+songs?(?:\s+\d{4})?)\b",
    re.I,
)


def clean_head(title):
    """The song part of an upload title: no (Official Video), no emoji, no '| cast | label' tail."""
    t = re.sub(r"[\(\[\{][^\)\]\}]*[\)\]\}]", " ", title)
    t = re.sub(r"[^\w\s\-–—:|'’&.,!?/+]", " ", t)
    t = re.sub(r"\s[–—]\s|\s[–—]|[–—]\s", " - ", t)
    segs = [s.strip() for s in t.split("|") if s.strip()]
    head = JUNK.sub(" ", segs[0] if segs else t)
    return re.sub(r"\s+", " ", head).strip(" -:"), [JUNK.sub(" ", s) for s in segs[1:]]


class Artists:
    """Names the library already knows, for spotting the singer in a busy title.

    Each name remembers its usual language (an English song turns up in a
    Hindi playlist and must stay English). Scanning a title for a name only
    uses that language family: English band names ("Heart", "Love") are
    ordinary words inside a Hindi title.
    """

    def __init__(self, rows):
        self.langs = {}  # name -> Counter of languages
        self.display = {}
        self.seeds = set()
        if os.path.exists(SEEDS_FILE):
            lang = "hi"
            with open(SEEDS_FILE) as f:
                for line in f:
                    line = line.strip()
                    m = re.match(r"@\s*language:\s*(\w+)", line)
                    if m:
                        lang = m.group(1)
                    elif line and not line.startswith(("#", "@")):
                        self._add(line.rstrip("*").strip(), lang)
                        self.seeds.add(norm(line.rstrip("*").strip()))
        for r in rows:
            for name in ARTIST_SPLIT.split(r["artist"] or ""):
                self._add(name.strip(), r.get("language") or "en")
        self.family = {"en": set(), "in": set()}
        for n, c in self.langs.items():
            if n in {"various artists", "unknown", "music", "official"}:
                continue
            # one short word is too likely to be part of a song title
            if " " not in n and len(n) < 4 and n not in self.seeds:
                continue
            self.family["en" if self.lang_of(n) == "en" else "in"].add(n)

    def _add(self, name, lang):
        n = norm(name)
        if len(n) >= 2:
            self.langs.setdefault(n, collections.Counter())[lang] += 1
            self.display.setdefault(n, name)

    def lang_of(self, name):
        c = self.langs.get(norm(name))
        return c.most_common(1)[0][0] if c else None

    def known(self, s):
        n = norm(s)
        return n in self.family["en"] or n in self.family["in"]

    def first_in(self, text, lang):
        names = self.family["en" if lang == "en" else "in"]
        words = norm(text).split()
        for i in range(len(words)):
            for n in (4, 3, 2, 1):
                cand = " ".join(words[i : i + n])
                if i + n <= len(words) and cand in names:
                    return self.display[cand]
        return None

    def strip_trailing(self, title, lang):
        """'2 Raflaan Mankirt Aulakh' -> '2 Raflaan' (the singer tacked on after the song)."""
        names = self.family["en" if lang == "en" else "in"]
        words = title.split()
        for n in (4, 3, 2, 1):
            if len(words) > n and norm(" ".join(words[-n:])) in names:
                return " ".join(words[:-n])
        return title


def parse_entry(e, lang, artists):
    """(artist, title, confident) for one playlist entry."""
    head, tail = clean_head(e["title"])
    # what's left of "| cast | label | 2020" once the junk and bare years are gone
    tail = [t.strip() for t in tail if t.strip() and not re.fullmatch(r"[\d\s]+", t.strip())]
    raw_channel = e.get("channel") or ""
    channel = re.sub(r"[\(\[][^\)\]]*[\)\]]|\s*-\s*Topic$|VEVO$|\bofficial\b", "", raw_channel, flags=re.I).strip()
    topic = raw_channel.endswith(" - Topic")

    def is_artist(x):
        return artists.known(x) or (bool(channel) and norm(x) == norm(channel))

    def tidy(t):
        t = FEAT.sub("", t).strip()
        if lang != "en":
            t = artists.strip_trailing(t, lang)
            t = re.sub(r"\s+(?:song|by)$", "", t, flags=re.I) or t
        return t

    def named(artist, title, confident=True):
        title = tidy(title)
        if not title or (artist and norm(title) == norm(artist)):
            return artist, title or head, False
        return artist, title, confident

    left = right = None
    colon = False
    if " - " in head:
        left, right = [p.strip() for p in head.split(" - ", 1)]
    elif ": " in head and len(head.split(": ", 1)[0]) < 30:
        left, right = [p.strip() for p in head.split(": ", 1)]
        colon = True
    if left and right:
        if is_artist(left):
            return named(left, right)
        if is_artist(right):
            return named(right, left)
        if lang == "en" or colon:  # "Artist - Song", "Guru Randhawa: High Rated Gabru"
            return named(left, right, lang == "en")
        # Indian uploads: "Song - Film | cast | singer | label"
        singer = artists.first_in(" ".join(tail), lang) or artists.first_in(right, lang)
        if singer:
            return named(singer, left)
        # no film credits after it: an independent "Artist - Song"
        return named(left, right, False) if not tail else named(None, left, False)
    if tail and is_artist(head):  # "Diljit Dosanjh | DON | Official Music Video"
        return named(head, tail[0])
    if topic or artists.known(channel):
        return named(channel, head)
    singer = artists.first_in(" ".join(tail), lang) or (lang != "en" and artists.first_in(head, lang))
    if singer:
        return named(singer, head)
    # maybe the artist's own channel, maybe a fan's: download that exact
    # upload and let its own metadata name the artist
    return named((channel or None) if lang == "en" else None, head, False)


def remake(title):
    """A slowed / lofi / cover re-recording, also when spelled 's l o w e d'."""
    return bool(NOT_ORIGINAL.search(title) or NOT_ORIGINAL.search(title.replace(" ", "")))


# ── harvest ────────────────────────────────────────────────────────────────

def month_dir(month):
    return os.path.join(SRC, month)


def read_json(path):
    with open(path) as f:
        return json.load(f)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp{threading.get_ident()}"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def search_playlists(q):
    r = fy.ytdlp(["--flat-playlist", "--playlist-end", "30", "-J", SEARCH_URL.format(q=urllib.parse.quote_plus(q))], timeout=120)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "search failed").strip().splitlines()[-1][:160])
    return [
        {"id": e["id"], "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or ""}
        for e in json.loads(r.stdout).get("entries") or []
        if e.get("id")
    ]


def playlist_ok(p, lang):
    pid = p["id"]
    # RD* are endless auto-mixes and OLAK5uy_ are albums - neither is a vibe;
    # RDCLAK5uy_ is YouTube Music's own editorial playlists, the best of all
    if (pid.startswith("RD") and not pid.startswith("RDCLAK")) or pid.startswith("OLAK"):
        return False
    words = set(re.findall(r"[a-z]+", norm(p["title"])))
    if words & (MARKERS - ALLOWED[lang]):
        return False
    if lang == "en" and not SCRIPTS["en"].match(p["title"]):
        return False
    return not (ONE_LONG_VIDEO.search(p["title"]) or OFF_THEME.search(p["title"]))


def fetch_playlist(pid, month):
    path = os.path.join(month_dir(month), "playlists", f"{pid}.json")
    if os.path.exists(path):
        return read_json(path)
    r = fy.ytdlp(
        ["--flat-playlist", "--playlist-end", str(ENTRIES_PER_PLAYLIST), "-J",
         f"https://www.youtube.com/playlist?list={pid}"],
        timeout=180,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "playlist failed").strip().splitlines()[-1][:160])
    j = json.loads(r.stdout)
    data = {
        "id": pid,
        "title": j.get("title") or "",
        "channel": j.get("channel") or j.get("uploader") or "",
        "count": j.get("playlist_count"),
        "modified": j.get("modified_date"),
        "entries": [
            {
                "id": e["id"],
                "title": e.get("title") or "",
                "channel": e.get("channel") or "",
                "duration": e.get("duration"),
                "views": e.get("view_count"),
            }
            for e in j.get("entries") or []
            if e and e.get("id") and e.get("title")
        ],
    }
    write_json(path, data)
    return data


def usable_entries(pl, lang):
    out = []
    for e in pl["entries"]:
        d = e.get("duration") or 0
        if not 90 <= d <= 480:  # deleted / private videos have none; long ones are mixes
            continue
        if ONE_LONG_VIDEO.search(e["title"]) or "#shorts" in e["title"].lower():
            continue
        if not SCRIPTS[lang].match(e["title"]):
            continue
        out.append(e)
    return out


def stale(pl):
    m = pl.get("modified")
    if not m or not re.fullmatch(r"\d{8}", m):
        return False
    age = dt.datetime.now() - dt.datetime.strptime(m, "%Y%m%d")
    return age.days > STALE_DAYS


def harvest_one(label, lang, search, month, log):
    path = os.path.join(month_dir(month), "search", f"{lang}-{slug(label)}.json")
    if os.path.exists(path):
        return "cached"
    cands, seen = [], set()
    qs = queries(label, lang, search)
    results = [search_playlists(q) for q in qs]
    # interleave the searches so each one's best results come first
    for rank in range(max(len(r) for r in results)):
        for r in results:
            if rank < len(r) and r[rank]["id"] not in seen:
                seen.add(r[rank]["id"])
                cands.append(r[rank])
    kept, old = [], []
    for p in cands:
        if len(kept) >= PLAYLISTS_PER_VIBE:
            break
        if not playlist_ok(p, lang):
            continue
        try:
            pl = fetch_playlist(p["id"], month)
        except Exception as e:  # noqa: BLE001
            log(f"    playlist {p['id']}: {e}")
            continue
        usable = usable_entries(pl, lang)
        if len(usable) < 10:
            continue
        # "chill Drake playlist" is one artist's catalogue, not a vibe
        top = max(collections.Counter(e["channel"] for e in usable).values())
        if top > (0.9 if curated(label) else 0.4) * len(usable):
            continue
        (old if stale(pl) else kept).append(p["id"])
    # only a thin vibe falls back on old playlists
    kept += old[: max(0, 4 - len(kept))]
    if not kept:
        raise RuntimeError("no usable playlists")
    write_json(path, {"label": label, "lang": lang, "queries": qs, "playlists": kept, "month": month})
    return f"{len(kept)} playlists"


def cmd_harvest(args):
    vibes, search = load_vibes()
    if args.only:
        vibes = [v for v in vibes if v[0] in args.only]
    fy.YTDLP = fy.ensure_ytdlp()
    lock = threading.Lock()

    def log(msg):
        with lock:
            print(msg, flush=True)

    counts = {"ok": 0, "cached": 0, "failed": 0}

    def job(v):
        label, lang = v
        try:
            res = harvest_one(label, lang, search, args.month, log)
            counts["cached" if res == "cached" else "ok"] += 1
            if res != "cached":
                log(f"  {lang} {label}: {res}")
        except Exception as e:  # noqa: BLE001
            counts["failed"] += 1
            log(f"  ✗ {lang} {label}: {e}")

    with cf.ThreadPoolExecutor(args.workers) as ex:
        list(ex.map(job, vibes))
    print(f"harvest {args.month}: {counts}")
    if counts["failed"] and not counts["ok"] and not counts["cached"]:
        sys.exit(1)


# ── matching playlist songs to the library ─────────────────────────────────

def load_catalog():
    path = os.path.join(LIBRARY, "catalog.json")
    rows = [r for r in read_json(path)["tracks"] if r["kind"] == "song"]
    return rows


class Matcher:
    def __init__(self, rows):
        self.ids = {r["id"] for r in rows}
        self.by_title = {}
        for r in rows:
            self.by_title.setdefault(norm_title(r["title"]), []).append(r)
        self.done = {}
        done_path = os.path.join(fy.SRC, "done.jsonl")
        if os.path.exists(done_path):
            with open(done_path) as f:
                for line in f:
                    if line.strip():
                        d = json.loads(line)
                        self.done[d["key"].lower()] = d.get("id")
        self.artists = Artists(rows)

    def match(self, e, artist, title):
        vid = f"yt-{e['id']}"
        if vid in self.ids:
            return vid
        lid = self.done.get(line_key(artist, title).lower())
        if lid in self.ids:
            return lid
        hay = norm(f"{e['title']} {e.get('channel') or ''} {artist or ''}")
        head, _ = clean_head(e["title"])
        cands = {norm_title(title), norm_title(head), *(norm_title(p) for p in re.split(r"\s+-\s+|:\s", head))}
        for t in cands:
            for r in self.by_title.get(t, []) if t else []:
                if any(contains(hay, a) for a in split_artists(r["artist"])):
                    return r["id"]
        return None


def line_key(artist, title):
    """The name part of a wanted.txt line - also its key in fetch_youtube's done.jsonl."""
    return (f"{artist} - {title}" if artist else title).replace(" | ", " / ")


def latest_searches(month):
    """{(label, lang): search file} - this month's, else the newest older one."""
    out = {}
    if not os.path.isdir(SRC):
        return out
    for m in sorted(d for d in os.listdir(SRC) if re.fullmatch(r"\d{4}-\d{2}", d) and d <= month):
        sdir = os.path.join(SRC, m, "search")
        if not os.path.isdir(sdir):
            continue
        for f in os.listdir(sdir):
            if f.endswith(".json"):
                s = read_json(os.path.join(sdir, f))
                s["_month"] = m
                out[(s["label"], s["lang"])] = s
    return out


def position_weight(i):
    # the top of a curated playlist is its core; deep tracks still count
    return 1.0 - 0.5 * min(1.0, i / ENTRIES_PER_PLAYLIST)


def dropped_playlists():
    """{(label, lang, playlist id)} that judge_vibes.mjs found were not made for that vibe."""
    path = os.path.join(SRC, "judge", "playlists.json")
    if not os.path.exists(path):
        return set()
    return {tuple(k.rsplit("|", 2)) for k, v in read_json(path).items() if v.get("keep") is False}


def walk_harvest(month, matcher, only=None):
    """Yield (label, lang, playlist, position, entry, artist, title, confident, library id)."""
    vibes, _ = load_vibes()
    wanted_vibes = set(vibes)
    # a search for "bollywood party" also finds "Bollywood 90s Hits" and "Self
    # Love Songs Hindi": playlists the judge dropped neither nominate downloads
    # nor speak for the vibe
    dropped = dropped_playlists()
    for (label, lang), s in sorted(latest_searches(month).items()):
        if (label, lang) not in wanted_vibes or (only and label not in only):
            continue
        for pid in s["playlists"]:
            if (label, lang, pid) in dropped:
                continue
            path = os.path.join(month_dir(s["_month"]), "playlists", f"{pid}.json")
            if not os.path.exists(path):
                continue
            pl = read_json(path)
            for i, e in enumerate(usable_entries(pl, lang)):
                artist, title, confident = parse_entry(e, lang, matcher.artists)
                if not title:
                    continue
                yield label, lang, pl, i, e, artist, title, confident, matcher.match(e, artist, title)


def cmd_wanted(args):
    matcher = Matcher(load_catalog())
    # song key -> what we know about it across every vibe
    songs = {}
    have = {}  # (label, lang) -> library songs it already has
    for label, lang, pl, i, e, artist, title, confident, lid in walk_harvest(args.month, matcher, args.only):
        if lid:
            have.setdefault((label, lang), set()).add(lid)
            continue
        key = f"{norm_title(title)}|{norm(artist or '')}"
        s = songs.setdefault(key, {"artist": artist, "title": title, "langs": {}, "vibes": {}, "entry": e, "confident": confident})
        s["langs"][lang] = s["langs"].get(lang, 0) + 1
        s["vibes"][(label, lang)] = s["vibes"].get((label, lang), 0) + position_weight(i)
        # keep the most-viewed upload as the one to download
        if (e.get("views") or 0) > (s["entry"].get("views") or 0):
            s["entry"] = e

    # each vibe nominates its best-supported missing songs
    per_vibe = {}
    for key, s in songs.items():
        for v, w in s["vibes"].items():
            per_vibe.setdefault(v, []).append((w, key))
    chosen = {}
    nominated = {}  # vibe -> its picks, best first
    for v, lst in per_vibe.items():
        lst.sort(reverse=True)
        taken = 0
        # --topup: a vibe asks only for what it lacks to reach N songs (plus a few
        # fresh ones), so the downloads go where the pool is thin
        limit = args.per_vibe
        if args.topup:
            limit = min(limit, max(args.topup - len(have.get(v, ())), args.fresh))
        for w, key in lst:
            if taken >= limit:
                break
            s = songs[key]
            if line_key(s["artist"], s["title"]).lower() in matcher.done:
                continue  # tried before (filtered out or failed) - don't spend the budget again
            # a one-playlist song is a curator's taste, not the vibe - unless the vibe is thin
            if w < 0.75 and len(lst) > args.per_vibe * 2:
                continue
            chosen[key] = max(chosen.get(key, 0), w)
            nominated.setdefault(v, []).append(key)
            taken += 1
    # The cap used to take the globally best-supported songs, which are hits
    # many playlists share: niche vibes (jazz, lofi, holi) never got a song in.
    # Every vibe is now guaranteed its best few before the rest compete.
    quota = args.max // (2 * max(1, len(nominated)))
    first = {key for keys in nominated.values() for key in keys[:quota]}
    rest = sorted((k for k in chosen if k not in first), key=lambda k: -chosen[k])
    ranked = sorted(first, key=lambda k: -chosen[k]) + rest
    ranked = sorted(ranked[: args.max], key=lambda k: -chosen[k])

    lines = []
    for key in ranked:
        s = songs[key]
        # a known singer's usual language decides; otherwise English wins,
        # since English songs turn up in Hindi playlists, not the other way round
        lang = (
            (s["artist"] and matcher.artists.lang_of(s["artist"]))
            or ("en" if "en" in s["langs"] else max(s["langs"], key=s["langs"].get))
        )
        e = s["entry"]
        labels = [f"language: {lang}"]
        # a named song is searched as official audio, like every other chart
        # song (and so gets the audio upload, which lyrics line up with); one
        # whose title won't parse is taken as the exact upload the playlist
        # holds - unless that upload is a remix / slowed edit of the song
        # (lofi / instrumental vibes want the remake: the exact upload, always)
        if not s["confident"] and (not remake(e["title"]) or any(curated(v[0]) for v in s["vibes"])):
            labels.append(f"video: {e['id']}")
        lines.append(" | ".join([line_key(s["artist"], s["title"]), *labels]))

    out = os.path.join(month_dir(args.month), "wanted.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        f.write(f"# Generated by harvest_vibes.py wanted ({args.month}): songs the vibe playlists\n")
        f.write("# rank highly that the library lacks. Fetched by fetch_youtube.py --queries.\n\n")
        f.write("\n".join(lines) + "\n")
    print(f"wanted: {len(lines)} songs missing from the library across {len(per_vibe)} vibes -> {out}")


def cmd_index(args):
    rows = load_catalog()
    matcher = Matcher(rows)
    language = {r["id"]: r.get("language") for r in rows}
    # a playlist only English vibes found is an English playlist: the odd Hindi
    # song in an Indian curator's "travel songs" is that curator, not the vibe
    langs_of = {}
    for (label, lang), s in latest_searches(args.month).items():
        for pid in s["playlists"]:
            langs_of.setdefault(pid, set()).add(lang)
    vibes = {}
    playlists = []
    pindex = {}
    members = {}
    entries = matched = 0
    for label, lang, pl, i, e, artist, title, confident, lid in walk_harvest(args.month, matcher):
        entries += 1
        v = vibes.setdefault((label, lang), [])
        if pl["id"] not in pindex:
            pindex[pl["id"]] = len(playlists)
            playlists.append({
                "id": pl["id"],
                "title": pl["title"],
                "channel": pl["channel"],
                "size": len(pl["entries"]),
                "modified": pl.get("modified"),
            })
        pi = pindex[pl["id"]]
        if pi not in v:
            v.append(pi)
        if not lid:
            continue
        if langs_of.get(pl["id"]) == {"en"} and language.get(lid) in ("hi", "pa"):
            continue
        matched += 1
        m = members.setdefault(lid, [])
        if pi not in m[0::2]:  # a song listed twice in one playlist counts once
            m += [pi, i]

    index = {
        "version": 1,
        "builtAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "month": args.month,
        "vibes": [{"label": l, "lang": g, "playlists": p} for (l, g), p in sorted(vibes.items())],
        "playlists": playlists,
        "songs": members,
        "stats": {"entries": entries, "matched": matched, "songs": len(members)},
    }
    write_json(os.path.join(LIBRARY, "vibes.json"), index)
    public = dict(index, songs={k: v for k, v in members.items() if not k.startswith("yt-")})
    write_json(os.path.join(LIBRARY, "vibes.public.json"), public)
    print(
        f"vibes.json: {len(vibes)} vibes, {len(playlists)} playlists, {len(members)} library songs "
        f"({matched}/{entries} playlist entries matched)"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["harvest", "wanted", "index"])
    ap.add_argument("--month", default=month_now(), help="harvest folder (YYYY-MM), default this month")
    ap.add_argument("--only", nargs="+", metavar="LABEL", help="limit to these vibe labels")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--per-vibe", type=int, default=120, help="wanted: missing songs each vibe may nominate")
    ap.add_argument("--max", type=int, default=6000, help="wanted: cap on the whole list")
    ap.add_argument("--topup", type=int, default=0, help="wanted: each vibe asks only for the songs it lacks to reach N")
    ap.add_argument("--fresh", type=int, default=40, help="wanted: with --topup, songs even a full vibe may ask for")
    args = ap.parse_args()
    {"harvest": cmd_harvest, "wanted": cmd_wanted, "index": cmd_index}[args.command](args)


if __name__ == "__main__":
    main()
