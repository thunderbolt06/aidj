"use client";

/**
 * Anonymous listening events for the stats page (app/stats): sets started,
 * songs played and how each one ended. A listener is a random id this browser
 * keeps - no account, nothing personal. Events are batched and sent every few
 * seconds, and with sendBeacon when the page goes away.
 */

const LISTENER_KEY = "everplay:listener";
const FLUSH_MS = 5000;

let listener = "";
let buffer: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function listenerId(): string {
  if (listener) return listener;
  try {
    listener = window.localStorage.getItem(LISTENER_KEY) || "";
    if (!listener) {
      listener = newId();
      window.localStorage.setItem(LISTENER_KEY, listener);
    }
  } catch {
    listener = newId(); // private mode: one id for this tab's life
  }
  return listener;
}

function flush(leaving = false) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!buffer.length) return;
  const body = JSON.stringify({ events: buffer });
  buffer = [];
  try {
    if (leaving && navigator.sendBeacon?.("/api/events", body)) return;
    fetch("/api/events", { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    /* stats are best-effort */
  }
}

/** Queue one event (the listener id and time are added here). */
export function logEvent(e: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  if (!hooked) {
    hooked = true;
    window.addEventListener("pagehide", () => flush(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush(true);
    });
  }
  buffer.push({ ...e, listener: listenerId(), at: Date.now() });
  if (buffer.length >= 20) flush();
  else if (!timer) timer = setTimeout(() => flush(), FLUSH_MS);
}

/** Send what is queued now (the page is going away). */
export function flushEvents() {
  flush(true);
}

export function newSetId(): string {
  return newId();
}
