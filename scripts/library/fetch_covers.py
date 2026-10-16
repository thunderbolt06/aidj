#!/usr/bin/env python3
"""
Real cover art for every song in the library -> library/covers/<id>.jpg

Every cover used to be a generated gradient (ingest.mjs). This replaces the
gradient of each song with its album art, as a 512x512 JPEG, in the same file
the app and the S3 push already use - nothing downstream changes.

Where the art comes from, best first:
  1. iTunes / Apple Music and YouTube Music (official artwork, no key needed). A song
     is only accepted when title, artist AND duration agree with the one in the
     library: a wrong cover is worse than an honest fallback, so karaoke / tribute /
     cover-band / remix versions are rejected and ties prefer the original release.
  2. The song's own YouTube thumbnail: the album art for "Topic" uploads, a video
     frame otherwise. Black bars are trimmed, the result is centre-cropped square.
Songs neither source can serve keep their gradient.

Two phases, so every song has a real cover within minutes and the slow part
only ever improves it:
  (default)  OFFLINE - iTunes answers already cached in library/sources/itunes/
             (build_collection.py keeps ~60k tracks there: free, no API call),
             then the YouTube thumbnail. Takes minutes.
  --online   For every song whose cover is not official art yet: YouTube Music
             search (fast, 1 call/song), then the iTunes Search API (Apple
             rate-limits per IP, so calls are paced, every worker pauses when
             refused, and one catalogue lookup settles most of an artist's songs).
             Most popular songs first. Resumable - stop it any time.

Every decision is logged in library/sources/covers/manifest.jsonl (the last row
of an id wins), so runs resume and the choices are auditable:
  status  "itunes" | "ytmusic" | "youtube" | "none"
  conf    "high" | "medium"      (itunes / ytmusic only)
  kind    "art" | "frame"        (youtube only: square album art vs a video frame)
  miss    ["ytmusic", ...]       sources that were asked and had nothing better
Search answers are kept in library/sources/covers/*-search.jsonl, so re-running
(or --redo after changing the scoring) re-decides without asking again.

  python3 scripts/library/fetch_covers.py                      # offline phase
  python3 scripts/library/fetch_covers.py --online             # upgrade via YouTube Music + iTunes
  python3 scripts/library/fetch_covers.py --dry-run --sample 50   # decide, write nothing
  python3 scripts/library/fetch_covers.py --ids yt-abc yt-def --redo --online

Needs Pillow (pip install pillow). One run at a time (library/sources/covers/.lock).
"""
import argparse
import collections
import concurrent.futures as cf
import difflib
import fcntl
import http.client
import io
import json
import os
import random
import re
import ssl
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

import netfamily

try:
    from PIL import Image, ImageStat
except ImportError:  # pragma: no cover
    sys.exit("fetch_covers.py needs Pillow:  pip install pillow")

LIBRARY = os.environ.get("LIBRARY_DIR") or os.path.join(os.path.dirname(__file__), "..", "..", "library")
LIBRARY = os.path.abspath(LIBRARY)
COVERS = os.path.join(LIBRARY, "covers")
SOURCES = os.path.join(LIBRARY, "sources", "covers")
MANIFEST = os.path.join(SOURCES, "manifest.jsonl")
ITUNES_CACHE = os.path.join(LIBRARY, "sources", "itunes")
DONE_KEYS = os.path.join(LIBRARY, "sources", "youtube", "done.jsonl")

SIZE = 512
UA = "everplay-library/1.0 (local music library; cover art)"
IP_FAMILY = netfamily.pin("itunes.apple.com")

# ── text matching ────────────────────────────────────────────────────────────

# a bracketed group or a trailing " - something" that only names a version
VERSION_WORDS = (
    r"remaster(?:ed)?|version|edit|mix|remix|radio|single|album|explicit|clean|from|original|"
    r"soundtrack|ost|motion picture|film|movie|live|acoustic|unplugged|reprise|deluxe|bonus|"
    r"official|video|audio|lyrics?|lyrical|hd|hq|4k|mv|anniversary|stereo|mono|extended|"
    r"short|full song|theme"
)
BRACKETS = re.compile(r"\s*[\(\[\{][^\)\]\}]*[\)\]\}]")
DASH_SUFFIX = re.compile(rf"\s+[-–—:]\s+(?:[^-–—]*\b(?:{VERSION_WORDS})\b[^-–—]*)$", re.I)
# "Song feat. X" / "Song ft X" / "Song prod. X" - not the word "with" ("With or Without You")
FEAT = re.compile(r"\s+(?:feat(?:uring)?\.?|ft\.?|prod\.)\s.*$", re.I)
# a credit group inside a track name: "(feat. X)", "[with X]", "- featuring X"
CREDIT = re.compile(
    r"[\(\[]\s*(?:feat(?:uring)?\.?|ft\.?|with|prod\.?(?:\s+by)?)\s+([^\)\]]+)[\)\]]|"
    r"\b(?:feat(?:uring)?\.?|ft\.?)\s+(.+)$",
    re.I,
)
# letters that do not decompose under NFKD, and scripts the library carries
FOLD = str.maketrans({"ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "ß": "ss", "ð": "d", "þ": "th", "ı": "i"})
WORD = re.compile(
    r"[a-z0-9ऀ-ॿ਀-੿Ѐ-ӿ؀-ۿ぀-ヿ一-鿿가-힯]+"
)


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower().replace("&", " and ")
    return s.translate(FOLD)


def words(s):
    return WORD.findall(fold(s))


def title_core(s):
    """The song's name without version noise: brackets, feat., ' - Remastered 2011'."""
    s = BRACKETS.sub("", s or "")
    s = DASH_SUFFIX.sub("", s)
    s = FEAT.sub("", s)
    return " ".join(words(s))


def compact(s):
    return "".join(words(s))


def skel(s):
    """
    Spelling-variant key for Hinglish / Punjabi titles: Pyaar~Pyar, Humsafar~Hamsafar, Aankhon~Ankhon.
    Aspirates and long vowels collapse, vowels drop; digits stay (Part 1 is not Part 2).
    """
    s = fold(s)
    for a, b in (("kh", "k"), ("gh", "g"), ("ch", "c"), ("jh", "j"), ("th", "t"), ("dh", "d"), ("bh", "b"), ("sh", "s"), ("ph", "f")):
        s = s.replace(a, b)
    s = s.replace("w", "v")
    s = re.sub(r"[aeiouy\s]+", "", s)
    return re.sub(r"(.)\1+", r"\1", s)


def digit_clash(ta, tb):
    """Titles that differ by a number: 'Part 1' / 'Part 2', 'On Top' / 'On Top 2'."""
    da, db = [w for w in ta if w.isdigit()], [w for w in tb if w.isdigit()]
    if da == db:
        return False
    if da and db:
        return True
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    return long_[:-1] == short and long_[-1].isdigit()


def title_sim(a, b):
    ca, cb = title_core(a), title_core(b)
    if not ca or not cb:
        return 0.0
    if ca == cb or ca.replace(" ", "") == cb.replace(" ", ""):
        return 1.0
    ta, tb = ca.split(), cb.split()
    if digit_clash(ta, tb):
        return 0.0 if len(ta) == len(tb) else 0.7
    sm = difflib.SequenceMatcher(None, ca, cb).ratio()
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    # "Tum Hi Ho" inside "Tum Hi Ho Aashiqui 2": whole-word containment of a 2+ word title
    if len(short) >= 2 and len(short) / len(long_) >= 0.5 and all(w in long_ for w in short):
        sm = max(sm, 0.9)
    if len(ta) == len(tb):
        diff = [(x, y) for x, y in zip(ta, tb) if x != y]
        if len(diff) == 1 and skel(diff[0][0]) != skel(diff[0][1]):
            sm = min(sm, 0.8)  # one different word: Meri / Teri Yaad are two songs
        elif skel(ca) == skel(cb) and len(skel(ca)) >= 3 and sm >= 0.7:
            sm = max(sm, 0.9)  # the same words spelled differently (and still similar to look at)
    return sm


ARTIST_SPLIT = re.compile(r"\s*(?:,|&|/|;|\band\b|\bx\b|\bvs\.?\b|\bwith\b|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bpresents\b|\+)\s*", re.I)
# one name from a credit never identifies an act on its own: Singh, Khan, King, Bunny...
GENERIC = {"khan", "singh", "kumar", "kaur", "master", "king", "bunny", "mann", "john", "sharma", "gill", "band",
           "brothers", "sisters", "orchestra", "official", "music", "records", "various", "artists"}
ALIASES = (("mohd", "mohammed"), ("md", "mohammed"), ("muhammad", "mohammed"), ("mohammad", "mohammed"))


def artist_parts(s):
    parts = [p for p in ARTIST_SPLIT.split(fold(s)) if p and p.strip()]
    out = [" ".join(words(p)) for p in parts if words(p)] or ([" ".join(words(s))] if words(s) else [])
    for i, p in enumerate(out):
        out[i] = " ".join(dict(ALIASES).get(w, w) for w in p.split())
    return out


def artist_sim(a, b):
    """0..1: how well two artist credits name the same act (any one name in common)."""
    if not a or not b:
        return 0.0
    pa, pb = artist_parts(a), artist_parts(b)
    best = 0.0
    for x in pa:
        for y in pb:
            cx, cy = x.replace(" ", ""), y.replace(" ", "")
            if not cx or not cy:
                continue
            if cx == cy:
                # a lone shared word ("Fire" in "Earth, Wind & Fire") is a coincidence unless both
                # credits are that one name, or it is long and specific enough to mean one act
                if (len(pa) == 1 and len(pb) == 1) or (len(cx) >= 5 and cx not in GENERIC):
                    return 1.0
                best = max(best, 0.55)  # coincidence-level evidence: below every accepting tier
                continue
            # "AR Rahman" inside "A. R. Rahman, Sukhwinder Singh"
            if min(len(cx), len(cy)) >= 4 and (cx in cy or cy in cx) and (len(pa) == 1 or len(pb) == 1 or min(len(cx), len(cy)) >= 8):
                best = max(best, 0.9)
            ratio = difflib.SequenceMatcher(None, cx, cy).ratio()
            # sound-alike acts sharing a surname (Nusrat / Rahat Fateh Ali Khan) sit at 0.80-0.86:
            # only a near-identical spelling counts as the same name
            best = max(best, ratio if ratio >= 0.9 else min(ratio, 0.55))
    return best


# versions of a song that are not the song: never accept their artwork
BAD_VERSION = re.compile(
    r"karaoke|karoke|tribute|originally (?:performed|by|recorded)|made famous|in the style of|as made popular|"
    r"backing track|sing[- ]?along|lullaby|rockabye|music box|8[- ]?bit|string quartet|piano (?:version|tribute|cover)|"
    r"ringtone|workout|cover version|\bcovers?\b|parody|renditions?|recreat(?:ed|ions?)|re-?recorded|instrumental|vitamin string|"
    r"medley|nightcore|slowed|reverb|sped up|mashup|\bdj\b.*\bmix\b",
    re.I,
)
# an album that is a compilation, not the song's own release: allowed, but never preferred
COMPILATION = re.compile(
    r"now that'?s what i call|greatest hits|best of|the very best|essentials?|collection|anthology|"
    r"top \d+|throwback|party|workout|various artists|\bhits?\b|\b\d0s\b|\blove songs\b|"
    r"\bclassics\b|\blegends\b|\bgold\b|\bplatinum\b|\bdecade\b|\bvol(?:ume|\.)?\s*\d+|"
    r"jukebox|the ultimate|chartbusters?|chart[- ]?toppers?|mix ?tape|éxitos|exitos|lo mejor|"
    r"favou?rites|the best|shinning star|top 10|number ones",
    re.I,
)
# a different recording of the title: a remix, a live take, "(Tabla Version)", "(Jhankar Beats)"...
VARIANT = re.compile(
    r"\b(?:remix|live|acoustic|unplugged|reprise|tabla|lo-?fi|rework(?:ed)?|reimagined|stripped|demo|session|"
    r"sped up|slowed|female|male|duet|unwind|chill|mashup|jhankar|trap|chill ?wave|flip|amapiano|dhol|house|"
    r"revisited|rendition|retro|bass boosted|cover)\b|"
    r"\b(?!radio\b|album\b|original\b|single\b|extended\b|full\b|main\b|video\b|clean\b|explicit\b|stereo\b|mono\b|club\b)\w+ mix\b|"
    r"\b(?!album\b|original\b|single\b|radio\b|explicit\b|clean\b|remaster(?:ed)?\b|deluxe\b|stereo\b|mono\b|"
    r"studio\b|bonus\b|lp\b|us\b|uk\b|full\b|theme\b|film\b|movie\b)\w+ version\b",
    re.I,
)
# channels that upload songs under their own name: no evidence about the real act
LABELS = re.compile(
    r"t-?series|saregama|zee music|speed records|sony music|\btips\b|times music|lahari|ishtar|shemaroo|\byrf\b|"
    r"\beros\b|venus|white hill|desi melodies|gaana|jjust music|\bvevo\b|- topic$|records$",
    re.I,
)
OST = re.compile(r"original (?:motion picture )?soundtrack|\bost\b|from \"|\bfrom '", re.I)


def variant_words(text):
    return {" ".join(m.group(0).lower().split()) for m in VARIANT.finditer(text or "")}


def itunes_year(c):
    m = re.match(r"(\d{4})", c.get("releaseDate") or "")
    return int(m.group(1)) if m else None


def score(identities, dur, year, cand, vid=None):
    """(tier, composite) for one candidate track against the song; tier None = reject."""
    if vid and cand.get("videoId") == vid:
        return "high", 9.0  # the very upload this library holds
    name = cand.get("trackName") or ""
    artist = cand.get("artistName") or ""
    album = cand.get("collectionName") or ""
    if re.search(r"\bviews?$", album, re.I):
        return None, 0.0  # a YouTube video result, not a release
    haystack = f"{name} {artist} {album}"
    mine = " ".join(f"{a or ''} {t or ''}" for a, t in identities)
    # a karaoke/tribute word the song itself does not carry means a different recording
    for m in BAD_VERSION.finditer(haystack):
        if m.group(0).lower() not in mine.lower():
            return None, 0.0
    t = max(title_sim(it, name) for _, it in identities)
    a = max((artist_sim(ia, artist) for ia, _ in identities if ia and not LABELS.search(ia)), default=0.0)
    # "Jugni (feat. Bilal Saeed)" filed under another primary artist: the credit names this act
    credit = " , ".join(g for m in CREDIT.finditer(name) for g in m.groups() if g)
    if credit and any(ia and not LABELS.search(ia) and artist_sim(ia, credit) >= 0.9 for ia, _ in identities):
        a = max(a, 0.9)
    cdur = (cand.get("trackTimeMillis") or 0) / 1000
    d = abs(dur - cdur) if dur and cdur else None

    extra = variant_words(name) - variant_words(mine)
    if extra and re.search(r"- (?:single|ep)$", album, re.I) and any(e in album.lower() for e in extra):
        return None, 0.0  # the album IS the variant release: "Song (Trap Mix) - Single"

    tier = None
    if t >= 0.88 and a >= 0.8 and (d is None or d <= 20):
        tier = "high"
    elif t >= 0.93 and d is not None and d <= 2 and not extra and (a >= 0.6 or OST.search(album)):
        tier = "medium"
    elif t >= 0.97 and a >= 0.9 and (not extra or (d is not None and d <= 60)):
        # a YouTube upload often runs well past the album track (intro, outro); the same title by
        # the same act is still this song's cover - and an upload that is a shorter edit of the store
        # track is the same song (only a variant, e.g. a remix, has to be close in length)
        tier = "medium"
    if tier is None:
        return None, 0.0
    if extra and tier == "high":
        tier = "medium"  # a re-creation is never trusted as much as the song itself

    comp = 3 * t + 2 * a
    if d is not None:
        comp += 1.0 if d <= 2 else 0.6 if d <= 5 else 0.3 if d <= 10 else 0.0
    cy = itunes_year(cand)
    if year and cy:
        gap = cy - year
        comp += 0.6 if gap == 0 else 0.4 if abs(gap) == 1 else 0.2 if abs(gap) <= 3 else 0.0
        if gap > 3:
            comp -= 0.3  # a reissue / compilation long after the original
    if COMPILATION.search(f"{album} {artist}"):
        comp -= 0.5
    if extra:
        comp -= 2.0  # never outranks the original
    if re.search(r"- (?:single|ep)$", album, re.I) and year and cy == year:
        comp += 0.1
    return tier, comp


# ── pacing and caches ────────────────────────────────────────────────────────


class Gate:
    """
    One shared pace for every call to one service. Apple answers 403/429 per IP when pushed
    and keeps refusing for a while: on one, ALL workers stop for a cool-down (doubling while
    it keeps happening), the pace that failed becomes the new floor, and a run of successes
    creeps the interval back down to that floor (which itself relaxes after a quiet spell).
    A `soft` gate (YouTube Music, which refuses ~15% of calls at random whatever the pace)
    only does that when most of the recent calls were refused.
    """

    def __init__(self, start, floor, name="api", soft=False):
        self.name = name
        self.soft = soft  # True: a stray refusal is just retried; only a sustained rate pauses everyone
        self.recent = collections.deque(maxlen=20)  # True = that call was refused
        self.base_floor = floor
        self.floor = floor
        self.interval = max(start, floor)
        self.next = 0.0
        self.blocked_until = 0.0
        self.cool = 20.0
        self.streak = 0
        self.calls = 0
        self.blocks = 0
        self.eased = time.time()
        self.gave_up = 0  # calls in a row that exhausted their retries
        self.lock = threading.Lock()

    def wait(self):
        with self.lock:
            now = time.time()
            t = max(now, self.next, self.blocked_until)
            self.next = t + self.interval
            self.calls += 1
        if STOP.is_set():
            raise StopRun("stopping")
        if t > now:
            nap(t - now)

    def failed(self):
        """A call used up its retries. Several in a row = the service is down: stop, do not grind."""
        with self.lock:
            self.gave_up += 1
            if self.gave_up >= 4:
                raise StopRun("the service keeps refusing or failing - stopping (resumable; try again later)")

    def ok(self):
        with self.lock:
            self.recent.append(False)
            self.gave_up = 0
            self.streak += 1
            if self.streak >= 5:
                self.cool = 20.0
            if self.streak >= 20:
                self.interval = max(self.floor, self.interval * 0.9)
                self.streak = 0
            if self.floor > self.base_floor and time.time() - self.eased > 120:
                self.floor = max(self.base_floor, self.floor * 0.85)  # a refusal a while ago may have been a burst
                self.eased = time.time()

    def refused(self, why=""):
        with self.lock:
            self.recent.append(True)
            if self.soft and not (len(self.recent) >= 8 and sum(self.recent) >= 0.7 * len(self.recent)):
                return  # YouTube Music refuses about 1 call in 6 at random: the caller retries it
            now = time.time()
            if now < self.blocked_until:
                return  # another worker already reported this refusal
            self.recent.clear()
            self.blocks += 1
            self.streak = 0
            pause = self.cool
            self.blocked_until = now + pause
            self.cool = min(self.cool * 2, 300.0)
            self.floor = max(self.floor, self.interval * 1.15)
            self.interval = min(max(self.interval * 1.5, self.floor), 20.0)
            self.eased = now
            print(f"  [{self.name}] refused ({why}) - every worker pauses {pause:.0f}s, then one call per {self.interval:.2f}s", flush=True)


STOP = threading.Event()  # set when the run is ending: every wait below returns at once


def nap(seconds):
    """Sleep, but wake (and abandon the work) the moment the run is stopping."""
    if STOP.wait(max(0.0, seconds)):
        raise StopRun("stopping")


class Unavailable(Exception):
    """A service would not answer: this song's result is unknown - NOT "no match"."""


class StopRun(Exception):
    """A service keeps failing: stop the whole run (it resumes from the manifest)."""


class OutOfTime(StopRun):
    """--max-minutes used up: a clean stop, not a failure."""


GATE = Gate(3.0, 1.5, "iTunes")  # iTunes Search API
YTM_GATE = Gate(0.6, 0.35, "YouTube Music", soft=True)  # YouTube Music search


class JsonlCache:
    """
    Append-only key -> JSON store. Search answers survive restarts, so a re-run (or --redo
    after the scoring changed) re-decides from what it already asked instead of asking again.
    """

    def __init__(self, name):
        self.path = os.path.join(SOURCES, name)
        self.data = {}
        self.lock = threading.Lock()
        self.fh = None
        if os.path.exists(self.path):
            with open(self.path) as f:
                for line in f:
                    try:
                        k, v = json.loads(line)
                    except ValueError:
                        continue
                    self.data[k] = v

    def get(self, key):
        return self.data.get(key)

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            if self.fh is None:
                os.makedirs(SOURCES, exist_ok=True)
                self.fh = open(self.path, "a")
            self.fh.write(json.dumps([key, value], ensure_ascii=False) + "\n")
            self.fh.flush()


ITUNES_SEARCHES = JsonlCache("itunes-search.jsonl")
YTM_SEARCHES = JsonlCache("ytmusic-search.jsonl")

ITUNES = "https://itunes.apple.com"
TRANSIENT = (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError, http.client.HTTPException,
             ssl.SSLError, UnicodeDecodeError, OSError)
KEEP_FIELDS = ("trackId", "artistId", "trackName", "artistName", "collectionName", "trackTimeMillis", "releaseDate", "artworkUrl100")


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def paced_json(gate, make_request, tries=6):
    """One paced, retried call -> parsed JSON. Refusals pause every worker; giving up raises Unavailable."""
    last = "no answer"
    for attempt in range(tries):
        gate.wait()
        try:
            with urllib.request.urlopen(make_request(), timeout=25) as r:
                data = json.loads(r.read())
            gate.ok()
            return data
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (403, 429, 500, 502, 503, 504):
                gate.refused(last)
                nap(0.5 + attempt)  # a stray refusal: a short pause, then the retry goes back through the gate
                continue
            raise Unavailable(last)  # a request the service rejects for good: not a refusal to pace around
        except TRANSIENT as e:
            last = f"{type(e).__name__}: {e}"[:80]
            nap(3 * (attempt + 1))
    gate.failed()
    raise Unavailable(last)


def itunes_call(path, params):
    url = f"{ITUNES}/{path}?" + urllib.parse.urlencode(params)
    return paced_json(GATE, lambda: urllib.request.Request(url, headers={"User-Agent": UA}))


def only_tracks(data):
    return [r for r in data.get("results", []) if r.get("wrapperType") == "track" and r.get("artworkUrl100")]


def itunes_search(term, country, limit=25):
    key = f"{country}|{limit}|{term}"
    hit = ITUNES_SEARCHES.get(key)
    if hit is not None:
        return hit
    data = itunes_call("search", {"term": term, "media": "music", "entity": "song", "limit": limit, "country": country})
    tracks = [{k: r.get(k) for k in KEEP_FIELDS} for r in only_tracks(data)]
    ITUNES_SEARCHES.put(key, tracks)
    return tracks


# ── YouTube Music ────────────────────────────────────────────────────────────

YTM_URL = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false"
YTM_SONGS = "EgWKAQIIAWoKEAkQBRAKEAMQBA=="  # the "Songs" filter: studio recordings, not videos
YTM_CLIENT = {"clientName": "WEB_REMIX", "clientVersion": "1.20241001.01.00", "hl": "en", "gl": "US"}


VIEWS = re.compile(r"\bviews?$", re.I)


def _runs(cell):
    return "".join(r.get("text", "") for r in (cell or {}).get("runs", []))


def parse_ytm(data):
    """Search answer -> candidates shaped like iTunes tracks (what score() reads)."""
    out = []

    def walk(o):
        if isinstance(o, dict):
            r = o.get("musicResponsiveListItemRenderer")
            if r:
                cols = [_runs(c.get("musicResponsiveListItemFlexColumnRenderer", {}).get("text")) for c in r.get("flexColumns", [])]
                thumbs = r.get("thumbnail", {}).get("musicThumbnailRenderer", {}).get("thumbnail", {}).get("thumbnails", [])
                # "Arijit Singh • Aashiqui 2 • 4:22" (the album is absent for some uploads)
                parts = [p.strip() for p in (cols[1] if len(cols) > 1 else "").split(" • ")]
                if any(VIEWS.search(p) for p in parts):
                    return  # a video result ("1.1B views"): its picture is a thumbnail, not the release's art
                secs = None
                if parts and re.fullmatch(r"(?:\d+:)?\d{1,2}:\d{2}", parts[-1]):
                    secs = sum(int(x) * 60**i for i, x in enumerate(reversed(parts.pop().split(":"))))
                if cols and cols[0] and thumbs and parts:
                    out.append({
                        "trackName": cols[0],
                        "artistName": parts[0],
                        "collectionName": parts[1] if len(parts) > 1 else "",
                        "trackTimeMillis": secs * 1000 if secs else None,
                        "videoId": (r.get("playlistItemData") or {}).get("videoId"),
                        "art": re.sub(r"=w\d+-h\d+", "=w600-h600", thumbs[-1]["url"]),
                    })
            else:
                for v in o.values():
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    return out


def ytm_search(query):
    hit = YTM_SEARCHES.get(query)
    if hit is not None:
        return hit
    body = json.dumps({"context": {"client": YTM_CLIENT}, "query": query, "params": YTM_SONGS}).encode()
    headers = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0", "Origin": "https://music.youtube.com"}
    data = paced_json(YTM_GATE, lambda: urllib.request.Request(YTM_URL, data=body, headers=headers))
    items = parse_ytm(data)
    YTM_SEARCHES.put(query, items)
    return items


class LocalIndex:
    """
    Tracks by title: the iTunes answers cached on disk, plus every lookup made this run. Each is
    filed under its exact title and under its spelling-variant skeleton (Pyaar~Pyar), so a
    Hinglish spelling difference still finds its candidates.
    """

    def __init__(self):
        self.by_title = collections.defaultdict(list)
        self.by_skel = collections.defaultdict(list)
        self.known = set()
        self.lock = threading.Lock()
        if os.path.isdir(ITUNES_CACHE):
            for fn in os.listdir(ITUNES_CACHE):
                if fn.startswith("songs-"):
                    try:
                        with open(os.path.join(ITUNES_CACHE, fn)) as f:
                            self.add(only_tracks(json.load(f)))
                    except (OSError, ValueError):
                        continue

    @property
    def size(self):
        return len(self.known)

    def add(self, tracks):
        with self.lock:
            for r in tracks:
                if not r.get("trackName"):
                    continue
                key = r.get("trackId") or (r.get("trackName"), r.get("artistName"), r.get("collectionName"))
                if key in self.known:
                    continue
                self.known.add(key)
                core = title_core(r["trackName"])
                if compact(core):
                    self.by_title[compact(core)].append(r)
                    if skel(core):
                        self.by_skel[skel(core)].append(r)

    def candidates(self, title):
        core = title_core(title)
        if not compact(core):
            return []
        with self.lock:
            found = list(self.by_title.get(compact(core), []))
            seen = {id(r) for r in found}
            found += [r for r in self.by_skel.get(skel(core), []) if id(r) not in seen]
            return found


def artist_catalogue(artist_id, country, local):
    """
    An artist's songs, most popular first (one call, cached where build_collection.py caches them).
    -> True when their songs are in the local index now.
    """
    file = os.path.join(ITUNES_CACHE, f"songs-{artist_id}.json")
    if os.path.exists(file):
        return True
    data = itunes_call("lookup", {"id": artist_id, "entity": "song", "limit": 200, "country": country})
    os.makedirs(ITUNES_CACHE, exist_ok=True)
    tmp = f"{file}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, file)
    local.add(only_tracks(data))
    return True


def art_url(cand, px=600):
    if cand.get("art"):
        return cand["art"]
    return re.sub(r"/\d+x\d+(?:bb|cc|sr)?\.(jpg|png|webp)$", rf"/{px}x{px}bb.jpg", cand["artworkUrl100"])


# ── images ───────────────────────────────────────────────────────────────────


def trim_bars(img):
    """Cut pure-black letterbox / pillarbox bars (symmetric ones only: a dark frame is not a bar)."""
    w, h = img.size
    mask = img.convert("L").point(lambda p: 255 if p > 22 else 0)
    box = mask.getbbox()
    if not box:
        return img, False
    l, t, r, b = box
    left, right, top, bottom = l, w - r, t, h - b

    def sym(x, y, total):
        return x + y >= 0.05 * total and abs(x - y) <= 0.2 * max(x, y, 1) + 4

    keep_w = sym(left, right, w)
    keep_h = sym(top, bottom, h)
    if not (keep_w or keep_h):
        return img, False
    box = (l if keep_w else 0, t if keep_h else 0, r if keep_w else w, b if keep_h else h)
    bw, bh = box[2] - box[0], box[3] - box[1]
    # bars are a minority of the frame: a small centred subject on black is content, not a bar
    if bw < 160 or bh < 160 or bw * bh < 0.45 * w * h or min(bw, bh) < 0.55 * min(w, h):
        return img, False
    return img.crop(box), True


def square_jpeg(raw, bars=False):
    """Decode, optionally trim bars, centre-crop square, 512px JPEG. -> (bytes, (trimmed, aspect, flat))"""
    img = Image.open(io.BytesIO(raw))
    img.load()
    img = img.convert("RGB")
    trimmed = False
    if bars:
        img, trimmed = trim_bars(img)
    w, h = img.size
    aspect = w / h
    side = min(w, h)
    if w != h:
        l, t = (w - side) // 2, (h - side) // 2
        img = img.crop((l, t, l + side, t + side))
    if side != SIZE:
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
    flat = ImageStat.Stat(img.convert("L")).stddev[0] < 7  # a black / blank frame
    out = io.BytesIO()
    img.save(out, "JPEG", quality=86, optimize=True, progressive=True)
    return out.getvalue(), (trimmed, aspect, flat)


def fetch_image(url, tries=3):
    last = None
    for i in range(tries):
        try:
            return http_get(url, timeout=30)
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        nap(1.5 * (i + 1))
    raise last


# the video's own thumbnail first, then frames YouTube cut at 50% / 75% of the video (for a blank first frame)
YT_NAMES = ["maxresdefault", "hq720", "sddefault", "hqdefault", "hq2", "hq3"]


def youtube_cover(video_id):
    """Square JPEG from the video's thumbnail. -> (bytes, kind) or None."""
    for name in YT_NAMES:
        try:
            raw = fetch_image(f"https://i.ytimg.com/vi/{video_id}/{name}.jpg")
        except urllib.error.HTTPError:
            continue
        except Exception:
            return None
        try:
            if len(raw) < 2500:  # the grey "no thumbnail" stub
                continue
            data, (trimmed, aspect, flat) = square_jpeg(raw, bars=True)
        except Exception:
            continue
        if flat:
            continue
        # art-track uploads are a square cover pillarboxed into 16:9: trimming leaves ~1:1
        return data, ("art" if trimmed and 0.9 <= aspect <= 1.1 else "frame")
    return None


# ── per-song work ────────────────────────────────────────────────────────────


def load_keys():
    """id -> ["Artist - Title", ...] as searched when the song was downloaded."""
    keys = collections.defaultdict(list)
    if os.path.exists(DONE_KEYS):
        with open(DONE_KEYS) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("id") and d.get("key"):
                    keys[d["id"]].append(d["key"])
    return keys


def identities_for(row, keys):
    out = [(row.get("artist") or None, row.get("title") or "")]
    for k in keys.get(row["id"], []):
        a, sep, t = k.partition(" - ")
        ident = (a.strip(), t.strip()) if sep else (None, k.strip())
        if ident[1] and ident not in out:
            out.append(ident)
    return out


def countries_for(language):
    return ["IN", "US"] if language in ("hi", "pa") else ["US", "GB"]


def primary_artist(a):
    parts = artist_parts(a or "")
    return parts[0] if parts else ""


def pick(row, identities, cands):
    """Best acceptable candidate -> (tier, composite, candidate) or None."""
    vid = row["id"][3:] if row["id"].startswith("yt-") else None
    dur = row.get("duration")
    best = None
    for c in cands:
        tier, comp = score(identities, dur, row.get("year"), c, vid)
        # ties go to the earlier release: the original's artwork, not a reissue's
        key = (comp, -(itunes_year(c) or 9999))
        if tier and (best is None or key > best[3]):
            best = (tier, comp, c, key)
    if best:
        return best[:3]
    # a label channel (T-Series, Saregama...) names no act, so the title and an exact duration
    # carry the match - and only when every such candidate agrees on who the artist is
    if dur and all(not ia or LABELS.search(ia) for ia, _ in identities):
        mine = " ".join(t or "" for _, t in identities)
        close = []
        for c in cands:
            name = f"{c.get('trackName') or ''} {c.get('artistName') or ''} {c.get('collectionName') or ''}"
            if (title_sim(identities[0][1], c.get("trackName") or "") >= 0.97 and c.get("trackTimeMillis")
                    and abs(dur - c["trackTimeMillis"] / 1000) <= 2 and not BAD_VERSION.search(name)
                    and not (variant_words(c.get("trackName")) - variant_words(mine))):
                close.append(c)
        if close and len({compact(c.get("artistName") or "") for c in close}) == 1:
            return "medium", 5.0, close[0]
    return None


def queries_for(identities):
    """Search terms, best first: primary artist + title for each known identity, then the bare title."""
    queries = []
    for artist, title in identities:
        core = title_core(title)
        if core:
            q = f"{primary_artist(artist)} {core}".strip()
            if q not in queries:
                queries.append(q)
    if identities[0][1]:
        bare = title_core(identities[0][1])
        if bare and bare not in queries:
            queries.append(bare)
    return queries


def find_local(row, identities, local):
    """The iTunes answers already on disk -> (tier, composite, candidate, 'local', 'IN') or None."""
    best = None
    for _, title in identities:
        got = pick(row, identities, local.candidates(title))
        if got and (best is None or got[1] > best[1]):
            best = (*got, "local", "IN")
    return best


def find_remote(row, identities, source, seen_artists=None, max_calls=3):
    """
    One online source's best acceptable candidate -> (tier, composite, candidate, via, country) or None.
    ytmusic: up to two searches. itunes: up to `max_calls` (one storefront, then the other, then an
    alternate query); `seen_artists` collects the artist ids of candidates naming this act so a group
    can fetch their whole catalogue.
    """
    queries = queries_for(identities)
    best = None
    if source == "ytmusic":
        for q in queries[:2]:
            got = pick(row, identities, ytm_search(q))
            if got and (best is None or got[1] > best[1]):
                best = (*got, "ytmusic", "")
            if best and best[0] == "high":
                break
        return best
    countries = countries_for(row.get("language"))
    plan = [(queries[0], c) for c in countries] if queries else []
    plan += [(q, countries[0]) for q in queries[1:3]]
    for q, country in plan[:max_calls]:
        cands = itunes_search(q, country)
        if seen_artists is not None:
            for c in cands:
                if c.get("artistId") and any(artist_sim(ia, c.get("artistName")) >= 0.9 for ia, _ in identities if ia):
                    seen_artists[c["artistId"]] += 1
        got = pick(row, identities, cands)
        if got and (best is None or got[1] > best[1]):
            best = (*got, "search", country)
        if best and best[0] == "high":
            break
    return best


REAL = ("itunes", "ytmusic")  # statuses that are official album art


def render(row, found, args, previous=None, tried=()):
    """Turn a decision into (manifest record, jpeg bytes or None)."""
    cid = row["id"]
    rec = {"id": cid, "t": int(time.time())}
    data = None
    if found:
        tier, comp, cand, via, country = found
        try:
            data, _ = square_jpeg(fetch_image(art_url(cand)))
            rec.update(
                status="ytmusic" if via == "ytmusic" else "itunes", conf=tier, score=round(comp, 2), via=via,
                match={
                    "title": cand.get("trackName"), "artist": cand.get("artistName"),
                    "album": cand.get("collectionName"), "year": itunes_year(cand),
                    "sec": round((cand.get("trackTimeMillis") or 0) / 1000),
                    "trackId": cand.get("trackId"), "videoId": cand.get("videoId"), "art": art_url(cand),
                },
            )
            if country:
                rec["country"] = country
        except Exception as e:
            # the match is real, the download failed: unknown, not a miss - leave the song to be retried
            return {"id": cid, "status": "error", "error": f"art download: {type(e).__name__}: {e}"[:160]}, None
    if data is None and previous and previous.get("status") in ("youtube", "itunes", "ytmusic"):
        # an online pass that found nothing better leaves the cover it has
        keep = {k: v for k, v in previous.items() if k != "itunesMiss"}
        keep.update(miss=sorted(set(previous.get("miss", [])) | set(tried)), t=rec["t"])
        return keep, None
    asked = set(tried)
    if data is None and not args.no_youtube and cid.startswith("yt-"):
        asked.add("youtube")
        got = youtube_cover(cid[3:])
        if got:
            data, kind = got
            rec.update(status="youtube", kind=kind)
    if data is None:
        rec["status"] = "none"
        rec["miss"] = sorted(asked)  # asked everywhere it can: do not ask again every run
        return rec, None
    rec["bytes"] = len(data)
    if tried and rec["status"] == "youtube":
        rec["miss"] = sorted(asked)
    return rec, data


def write_cover(cid, data):
    os.makedirs(COVERS, exist_ok=True)
    dest = os.path.join(COVERS, f"{cid}.jpg")
    tmp = f"{dest}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)


def run_unit(unit, keys, local, done, source, dry, fresh=False):
    """
    One unit of work = songs of one artist (or a single song) -> [(row, record)]; covers are written here.
    source None  = the offline phase: cached iTunes answers, then the YouTube thumbnail.
    source "ytmusic" / "itunes" = that online source (an iTunes artist with 3+ songs gets their
    catalogue fetched first: one lookup settles most of their songs, searches fill the gaps).
    A service that would not answer leaves the song untouched (no manifest row): it stays to do.
    """
    out = []
    prepared = [(r, identities_for(r, keys)) for r in unit]
    max_calls = 3
    if source == "itunes" and len(unit) >= 3:
        try:
            seen = collections.Counter()
            anchor, ids = prepared[0]
            find_remote(anchor, ids, "itunes", seen_artists=seen)
            for artist_id, _ in seen.most_common(2):
                if artist_catalogue(artist_id, countries_for(anchor.get("language"))[0], local):
                    max_calls = 1  # their songs are in the local index now; a search only covers collaborations
        except Unavailable:
            pass  # no catalogue: the songs fall back to plain searches
    for row, ids in prepared:
        try:
            found = find_local(row, ids, local)
            if source and not (found and found[0] == "high"):
                got = find_remote(row, ids, source, max_calls=max_calls)
                if got and (found is None or got[1] > found[1]):
                    found = got
            have = os.path.exists(os.path.join(COVERS, f"{row['id']}.jpg"))
            rec, data = render(row, found, ARGS, previous=done.get(row["id"]) if have and not fresh else None, tried=[source] if source else [])
            if data is not None and not dry:
                write_cover(row["id"], data)
            out.append((row, rec))
        except StopRun:
            raise
        except Exception as e:  # one bad song never stops the run
            out.append((row, {"id": row["id"], "status": "error", "error": f"{type(e).__name__}: {e}"[:160]}))
    return out


# ── main ─────────────────────────────────────────────────────────────────────

ARGS = None


def load_manifest(path):
    last = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                last[d["id"]] = d
    return last


def take_lock():
    """One run at a time: two would double the pace Apple sees and race on the manifest."""
    os.makedirs(SOURCES, exist_ok=True)
    fh = open(os.path.join(SOURCES, ".lock"), "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another fetch_covers.py run holds library/sources/covers/.lock - nothing to do here", flush=True)
        sys.exit(0)
    return fh  # keep it referenced: the lock lives as long as the process


def main():
    global GATE, YTM_GATE, ARGS, COVERS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--online", action="store_true", help="ask iTunes / YouTube Music (paced) to upgrade covers to album art")
    ap.add_argument("--sources", default="ytmusic,itunes", help="online sources, in order (default ytmusic,itunes)")
    ap.add_argument("--ids", nargs="*", help="only these song ids")
    ap.add_argument("--language", help="only songs of this ISO language code")
    ap.add_argument("--limit", type=int, help="stop after N songs per stage")
    ap.add_argument("--sample", type=int, help="N random songs (stratified by language)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--itunes-rate", type=float, default=1.5, help="fastest seconds between iTunes API calls (starts at 3, default 1.5)")
    ap.add_argument("--ytm-rate", type=float, default=0.35, help="fastest seconds between YouTube Music searches (default 0.35; it refuses ~15%% of calls at random, which are retried)")
    ap.add_argument("--redo", action="store_true", help="re-decide songs even if the manifest has a final answer (never downgrades a cover)")
    ap.add_argument("--max-minutes", type=float, help="stop cleanly after this long (resumable; for scheduled runs)")
    ap.add_argument("--revalidate", action="store_true", help="re-score every stored official-art match with the current rules; those that no longer pass drop back to their YouTube thumbnail")
    ap.add_argument("--no-youtube", action="store_true", help="never fall back to the YouTube thumbnail")
    ap.add_argument("--dry-run", action="store_true", help="decide and report, write no cover and no manifest row")
    ap.add_argument("--manifest", default=MANIFEST, help="manifest path (experiments: also pass --covers)")
    ap.add_argument("--covers", default=COVERS, help="where covers are written (default library/covers)")
    args = ap.parse_args()
    ARGS = args
    if min(args.itunes_rate, args.ytm_rate) < 0.2:
        sys.exit("a pace under 0.2s between calls is a flood, not a fetch")
    if os.path.abspath(args.manifest) != os.path.abspath(MANIFEST) and os.path.abspath(args.covers) == os.path.abspath(COVERS) and not args.dry_run:
        sys.exit("an experimental --manifest would still overwrite the real covers: also pass --covers DIR (or --dry-run)")
    COVERS = args.covers

    GATE = Gate(max(3.0, args.itunes_rate), args.itunes_rate, "iTunes")
    YTM_GATE = Gate(max(0.6, args.ytm_rate), args.ytm_rate, "YouTube Music", soft=True)
    os.makedirs(os.path.dirname(args.manifest), exist_ok=True)
    lock = None if args.dry_run else take_lock()

    with open(os.path.join(LIBRARY, "catalog.json")) as f:
        rows = [r for r in json.load(f)["tracks"] if r.get("kind") == "song"]
    if args.ids:
        want = set(args.ids)
        rows = [r for r in rows if r["id"] in want]
    if args.language:
        rows = [r for r in rows if r.get("language") == args.language]

    done = load_manifest(args.manifest)
    keys = load_keys()
    local = LocalIndex()
    out = None if args.dry_run else open(args.manifest, "a")
    tally = collections.Counter()
    sources = [s.strip() for s in args.sources.split(",") if s.strip()] if args.online else [None]
    for s in sources:
        if s not in (None, "ytmusic", "itunes"):
            sys.exit(f"unknown source {s!r} (ytmusic, itunes)")

    def todo_for(r, source):
        d = done.get(r["id"])
        if args.redo or not d:
            return True
        if not os.path.exists(os.path.join(COVERS, f"{r['id']}.jpg")):
            return True  # the file is gone (a restore, a deleted folder): whatever the manifest says
        if d["status"] in REAL:
            return False
        asked = d.get("miss", [])
        if source is None:
            return d["status"] == "none" and "youtube" not in asked  # offline: songs that got nothing, once
        return source not in asked  # a youtube / none cover is still upgradable

    started = time.time()
    deadline = started + args.max_minutes * 60 if args.max_minutes else None
    code = 0
    ex = None
    try:
        for source in sources:
            fresh = False
            if args.revalidate:
                todo, fresh = [], True
                for r in rows:
                    d = done.get(r["id"])
                    m = (d or {}).get("match")
                    if d and d["status"] in REAL and m:
                        # the stored match, as a candidate again: does it still pass?
                        cand = {"trackName": m.get("title"), "artistName": m.get("artist"), "collectionName": m.get("album"),
                                "trackTimeMillis": (m.get("sec") or 0) * 1000 or None,
                                "releaseDate": str(m["year"]) if m.get("year") else None, "videoId": m.get("videoId")}
                        if not pick(r, identities_for(r, keys), [cand]):
                            todo.append(r)
            else:
                todo = [r for r in rows if todo_for(r, source)]
            if args.sample:
                rnd = random.Random(args.seed)
                by_lang = collections.defaultdict(list)
                for r in todo:
                    by_lang[r.get("language") or "?"].append(r)
                picked = []
                for lang, lst in sorted(by_lang.items()):
                    k = max(1, round(args.sample * len(lst) / max(1, len(todo))))
                    picked += rnd.sample(lst, min(k, len(lst)))
                rnd.shuffle(picked)
                todo = picked[: args.sample]
            else:
                # most popular first: the songs people actually hear get their art first
                todo.sort(key=lambda r: -(r.get("popularity") or 0))
            if args.limit:
                todo = todo[: args.limit]

            # an iTunes artist with 3+ songs to do is one unit (their catalogue is fetched once)
            units = []
            if source == "itunes":
                groups = collections.OrderedDict()
                for r in todo:
                    groups.setdefault(compact(primary_artist(r.get("artist"))) or r["id"], []).append(r)
                for g in groups.values():
                    units.extend([g] if len(g) >= 3 else ([r] for r in g))
            else:
                units = [[r] for r in todo]

            label = {None: "offline (cached iTunes answers + YouTube thumbnails)", "ytmusic": "online: YouTube Music", "itunes": "online: iTunes Search API"}[source]
            print(f"{len(rows)} songs, {len(todo)} to do in {len(units)} units, {label}, local index {local.size} tracks, "
                  f"{args.workers} workers{' (dry run)' if args.dry_run else ''}", flush=True)
            stage_n = 0
            stage_start = time.time()
            ex = cf.ThreadPoolExecutor(max_workers=args.workers)
            futures = [ex.submit(run_unit, u, keys, local, done, source, args.dry_run, fresh) for u in units]
            for fut in cf.as_completed(futures):
                if deadline and time.time() > deadline:
                    raise OutOfTime(f"time budget of {args.max_minutes:g} minutes used up")
                try:
                    results = fut.result()
                except StopRun:
                    raise
                except Exception as e:  # a unit that blew up costs only itself
                    print(f"  unit failed: {type(e).__name__}: {e}"[:200], flush=True)
                    continue
                for row, rec in results:
                    stage_n += 1
                    key = rec["status"] + (":" + rec["conf"] if rec.get("conf") else "")
                    if rec.get("miss") and rec["status"] in ("youtube", "none") and rec.get("t") and source:
                        key += " (no better art)"
                    tally[key] += 1
                    if out and rec["status"] != "error":
                        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                        out.flush()
                        done[row["id"]] = rec
                    if rec["status"] == "error":
                        print(f"  {row['id']}: {rec.get('error')}", flush=True)
                    if args.dry_run or args.sample:
                        m = rec.get("match") or {}
                        print(f"  {rec['status']:7} {rec.get('conf') or rec.get('kind') or '':6} "
                              f"{(row.get('artist') or '')[:24]:24} | {(row.get('title') or '')[:30]:30} -> "
                              f"{(m.get('artist') or '')[:22]:22} | {(m.get('title') or '')[:28]:28} | {(m.get('album') or '')[:28]}", flush=True)
                    if stage_n % 100 == 0 or stage_n == len(todo):
                        rate = stage_n / max(1, time.time() - stage_start) * 60
                        gate = ""
                        if source == "itunes":
                            gate = f"  iTunes api {GATE.calls} calls, gate {GATE.interval:.1f}s, refused {GATE.blocks}x"
                        elif source == "ytmusic":
                            gate = f"  YT Music api {YTM_GATE.calls} calls, gate {YTM_GATE.interval:.2f}s, refused {YTM_GATE.blocks}x"
                        print(f"[{stage_n}/{len(todo)}] {dict(tally)}  {rate:.0f}/min{gate}", flush=True)
            ex.shutdown(wait=True)
            ex = None
    except KeyboardInterrupt:
        STOP.set()
        print("interrupted - resumable; re-run to continue", flush=True)
        code = 130
    except OutOfTime as e:
        STOP.set()
        print(f"stopped: {e} (resumable)", flush=True)
    except StopRun as e:
        STOP.set()
        print(f"stopped: {e}", flush=True)
        code = 3
    finally:
        if ex:
            ex.shutdown(wait=False, cancel_futures=True)  # no queued unit runs after Ctrl-C / a stop
        if out:
            out.close()
    print("done" if not code else "stopped", dict(tally), flush=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
