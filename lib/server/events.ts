import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Listening events - what people play, skip and ask for - for the stats page
 * (app/stats). Listeners are anonymous: a random id the browser keeps, no
 * names, no IPs.
 *
 * Stored as month files of JSON lines. Locally they go to .data/events/; a
 * deployment has no disk of its own, so when EXTRACTOR_URL is set they go to
 * the Railway extractor's volume instead (POST / GET /events there).
 */
// not traced into the deployment bundle: a deployment logs to the extractor
const EVENTS_DIR =
  process.env.EVENTS_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "events");
const monthFile = (name: string) => path.join(/*turbopackIgnore: true*/ EVENTS_DIR, name);
const EXTRACTOR = (process.env.EXTRACTOR_URL || "").replace(/\/+$/, "");
const EXTRACTOR_TOKEN = process.env.EXTRACTOR_TOKEN || "";

/** Why a song stopped playing. */
export type PlayEnd =
  | "auto" // the DJ moved on at the end of the famous part
  | "skip" // NEXT tapped
  | "drop" // NEXT held and released - leaving on purpose, for the effect
  | "pick" // another song chosen (grid, queue, swipe back)
  | "revibe" // a new vibe asked for mid-set
  | "stop" // set stopped
  | "left"; // tab closed / page left

export const PLAY_ENDS: PlayEnd[] = ["auto", "skip", "drop", "pick", "revibe", "stop", "left"];

/** What set a transition off: how the song before it ended, or BACK. */
export type HopTrigger = "auto" | "skip" | "drop" | "pick" | "back";
export const HOP_TRIGGERS: HopTrigger[] = ["auto", "skip", "drop", "pick", "back"];

interface Base {
  at: number;
  listener: string;
}

/** A set started (or the vibe changed mid-set, which starts a new one). */
export interface SetEvent extends Base {
  type: "set";
  setId: string;
  vibes: string[];
  page: string;
}

/** One song, logged when it stops playing. */
export interface PlayEvent extends Base {
  type: "play";
  setId: string;
  vibes: string[];
  page: string;
  track: string;
  playedSec: number;
  end: PlayEnd;
}

/** A vibe request, logged by the intent route (chip tap or typed). */
export interface IntentEvent extends Base {
  type: "intent";
  prompt: string;
  vibes: string[];
  chip: boolean;
}

/** One transition from song A to song B, logged as it starts. */
export interface HopEvent extends Base {
  type: "hop";
  hopId: string;
  setId: string;
  vibes: string[];
  page: string;
  from: string;
  fromTitle: string;
  fromArtist: string;
  to: string;
  toTitle: string;
  toArtist: string;
  style: string;
  /** where A was left and B came in, seconds into each song */
  outSec: number;
  inSec: number;
  durSec: number;
  trigger: HopTrigger;
  /** A had already ended - B just started, nothing was mixed */
  ranOut: boolean;
  beatMatch: boolean;
  keyLock: boolean;
  /** timed to A's vocals: "handoff" (vocal_handoff), "break" / "line" (a vocal gap), or "" */
  vocal: string;
  bpmFrom: number;
  bpmTo: number;
  keyFrom: string;
  keyTo: string;
}

/** The listener's like / dislike for a transition (the popup after it). */
export interface RateEvent extends Base {
  type: "rate";
  hopId: string;
  setId: string;
  rating: "up" | "down";
}

export type ListenEvent = SetEvent | PlayEvent | IntentEvent | HopEvent | RateEvent;

const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
const strs = (x: unknown) =>
  Array.isArray(x) ? x.slice(0, 5).map((v) => str(v, 80)).filter(Boolean) : [];

/** Keep only well-formed events, with only the fields we know. */
export function cleanEvent(raw: unknown, now = Date.now()): ListenEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const listener = str(e.listener, 40);
  // a client clock can be off; never trust it past "now"
  const at = typeof e.at === "number" && e.at > 0 ? Math.min(e.at, now) : now;
  if (!listener && e.type !== "intent") return null;
  if (e.type === "set") {
    const setId = str(e.setId, 40);
    if (!setId) return null;
    return { type: "set", at, listener, setId, vibes: strs(e.vibes), page: str(e.page, 40) };
  }
  if (e.type === "play") {
    const setId = str(e.setId, 40);
    const track = str(e.track, 60);
    const end = PLAY_ENDS.find((x) => x === e.end);
    if (!setId || !track || !end) return null;
    const playedSec = Math.max(0, Math.min(3600, Number(e.playedSec) || 0));
    return {
      type: "play",
      at,
      listener,
      setId,
      vibes: strs(e.vibes),
      page: str(e.page, 40),
      track,
      playedSec: Math.round(playedSec),
      end,
    };
  }
  if (e.type === "hop") {
    const hopId = str(e.hopId, 40);
    const from = str(e.from, 60);
    const to = str(e.to, 60);
    const style = str(e.style, 30);
    const trigger = HOP_TRIGGERS.find((x) => x === e.trigger);
    if (!hopId || !from || !to || !style || !trigger) return null;
    const sec = (x: unknown, max: number) => Math.round(Math.max(0, Math.min(max, Number(x) || 0)) * 10) / 10;
    return {
      type: "hop",
      at,
      listener,
      hopId,
      setId: str(e.setId, 40),
      vibes: strs(e.vibes),
      page: str(e.page, 40),
      from,
      fromTitle: str(e.fromTitle, 120),
      fromArtist: str(e.fromArtist, 120),
      to,
      toTitle: str(e.toTitle, 120),
      toArtist: str(e.toArtist, 120),
      style,
      outSec: sec(e.outSec, 3600),
      inSec: sec(e.inSec, 3600),
      durSec: sec(e.durSec, 120),
      trigger,
      ranOut: !!e.ranOut,
      beatMatch: !!e.beatMatch,
      keyLock: !!e.keyLock,
      vocal: str(e.vocal, 10),
      bpmFrom: sec(e.bpmFrom, 300),
      bpmTo: sec(e.bpmTo, 300),
      keyFrom: str(e.keyFrom, 4),
      keyTo: str(e.keyTo, 4),
    };
  }
  if (e.type === "rate") {
    const hopId = str(e.hopId, 40);
    if (!hopId || (e.rating !== "up" && e.rating !== "down")) return null;
    return { type: "rate", at, listener, hopId, setId: str(e.setId, 40), rating: e.rating };
  }
  if (e.type === "intent") {
    return { type: "intent", at, listener, prompt: str(e.prompt, 200), vibes: strs(e.vibes), chip: !!e.chip };
  }
  return null;
}

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export async function recordEvents(events: ListenEvent[]): Promise<void> {
  if (!events.length) return;
  if (EXTRACTOR) {
    const res = await fetch(`${EXTRACTOR}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(EXTRACTOR_TOKEN ? { Authorization: `Bearer ${EXTRACTOR_TOKEN}` } : {}),
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) throw new Error(`event store answered ${res.status}`);
    return;
  }
  await mkdir(/*turbopackIgnore: true*/ EVENTS_DIR, { recursive: true });
  const byMonth = new Map<string, string>();
  for (const e of events) {
    const m = monthOf(e.at);
    byMonth.set(m, (byMonth.get(m) ?? "") + JSON.stringify(e) + "\n");
  }
  for (const [m, lines] of byMonth) await appendFile(/*turbopackIgnore: true*/ monthFile(`${m}.jsonl`), lines);
}

function parseLines(text: string, since: number): ListenEvent[] {
  const out: ListenEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as ListenEvent;
      if (e.at >= since) out.push(e);
    } catch {
      /* a torn last line from a crash - skip it */
    }
  }
  return out;
}

/** Every event at or after `since` (ms), oldest first. */
export async function readEvents(since = 0): Promise<ListenEvent[]> {
  if (EXTRACTOR) {
    const res = await fetch(`${EXTRACTOR}/events?since=${since}`, {
      headers: EXTRACTOR_TOKEN ? { Authorization: `Bearer ${EXTRACTOR_TOKEN}` } : {},
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`event store answered ${res.status}`);
    return parseLines(await res.text(), since);
  }
  let files: string[];
  try {
    files = (await readdir(/*turbopackIgnore: true*/ EVENTS_DIR)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return []; // nothing logged yet
  }
  const from = monthOf(since);
  const texts = await Promise.all(
    files.filter((f) => f.slice(0, 7) >= from).map((f) => readFile(/*turbopackIgnore: true*/ monthFile(f), "utf8"))
  );
  return parseLines(texts.join(""), since).sort((a, b) => a.at - b.at);
}
