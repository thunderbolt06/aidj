"use client";

/**
 * iOS/Safari audio unlock.
 *
 * Two separate things silence Web Audio on iPhones:
 *  1. The AudioContext starts (or gets re-)suspended and may only be resumed
 *     from inside a user gesture.
 *  2. Web Audio alone is treated as "ambient" sound, which the physical
 *     ringer/mute switch silences. Playing ANY <audio> element (even silent)
 *     - or opting in via navigator.audioSession - promotes the page to the
 *     "playback" category, which ignores the mute switch.
 *
 * This module installs capture-phase gesture listeners that do both, plus
 * auto-resume when the tab becomes visible again or iOS interrupts the
 * context (phone call, Siri, control-center pause).
 */

let installed = false;
let silentEl: HTMLAudioElement | null = null;

/** Build a ~0.1s silent WAV as a blob URL (avoids shipping a base64 asset). */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples * 2, true);
  // samples are already zero - silence
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

function beMediaPlayback() {
  // Safari 16.4+: route as media playback so the mute switch doesn't apply
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) nav.audioSession.type = "playback";
  } catch {
    /* older Safari */
  }
  // Belt and braces for iOS versions without audioSession: a playing <audio>
  // element (looped, silent) keeps the media session active.
  if (!silentEl) {
    silentEl = new Audio(silentWavUrl());
    silentEl.loop = true;
    // volume 0 gets optimized away on some iOS versions - keep it inaudible
    silentEl.volume = 0.01;
    silentEl.setAttribute("playsinline", "");
  }
  silentEl.play().catch(() => {
    /* will retry on the next gesture */
  });
}

/** Minimal surface this module needs from the engine - kept generic so it doesn't import DJEngine. */
interface UnlockableEngine {
  ctx: AudioContext;
  autoResume(): Promise<void>;
}

/**
 * Install once per page. `getEngine` is lazy so merely installing the
 * listeners never constructs an AudioContext outside a gesture.
 *
 * Every resume here goes through `autoResume()`, NOT a raw `ctx.resume()`:
 * these listeners fire on ANY click or keypress anywhere on the page (that's
 * the whole point, for iOS unlock), so a raw resume would silently undo an
 * intentional pause the instant the user clicked or typed anything else.
 */
export function installAudioUnlock(getEngine: () => UnlockableEngine) {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const unlock = () => {
    const engine = getEngine();
    const ctx = engine.ctx;
    beMediaPlayback();
    engine.autoResume().catch(() => {});
    // a 1-sample blip through the context nails the unlock on stubborn iOS
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* context not ready yet - the next gesture retries */
    }
  };

  const events: (keyof WindowEventMap)[] = ["touchend", "mousedown", "keydown"];
  for (const ev of events)
    window.addEventListener(ev, unlock, { capture: true, passive: true });

  // iOS suspends the context on interruptions (calls, Siri) and sometimes on
  // tab switches - resume as soon as we're visible/interrupted-ended again
  // (but never fight a deliberate pause - see autoResume).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      getEngine().autoResume().catch(() => {});
    }
  });
}
