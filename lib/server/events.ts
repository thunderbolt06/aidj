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
const EVENTS_DIR = process.env.EVENTS_DIR || path.join(process.cwd(), ".data", "events");
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

export type ListenEvent = SetEvent | PlayEvent | IntentEvent;

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
  await mkdir(EVENTS_DIR, { recursive: true });
  const byMonth = new Map<string, string>();
  for (const e of events) {
    const m = monthOf(e.at);
    byMonth.set(m, (byMonth.get(m) ?? "") + JSON.stringify(e) + "\n");
  }
  for (const [m, lines] of byMonth) await appendFile(path.join(EVENTS_DIR, `${m}.jsonl`), lines);
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
    files = (await readdir(EVENTS_DIR)).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return []; // nothing logged yet
  }
  const from = monthOf(since);
  const texts = await Promise.all(
    files.filter((f) => f.slice(0, 7) >= from).map((f) => readFile(path.join(EVENTS_DIR, f), "utf8"))
  );
  return parseLines(texts.join(""), since).sort((a, b) => a.at - b.at);
}
