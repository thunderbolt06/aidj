import type { LoadedTrack } from "@/lib/client/dj";

/**
 * Offline-render a reel: each track's famous part, equal-power crossfaded,
 * rendered faster than realtime with OfflineAudioContext.
 */
export async function renderReel(
  tracks: LoadedTrack[],
  clipSec = 18,
  fadeSec = 1.5
): Promise<AudioBuffer> {
  const sr = 44100;
  const total = tracks.length * clipSec - (tracks.length - 1) * fadeSec;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sr), sr);

  let cursor = 0;
  tracks.forEach((t, i) => {
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    const gain = ctx.createGain();
    src.connect(gain).connect(ctx.destination);

    const start = Math.max(0, (t.meta.famousStart ?? 40) - 3);
    const g = gain.gain;
    if (i === 0) {
      g.setValueAtTime(1, 0);
    } else {
      g.setValueAtTime(0, cursor);
      for (let s = 0; s <= 10; s++) {
        g.setValueAtTime(
          Math.sin(((s / 10) * Math.PI) / 2),
          cursor + (s / 10) * fadeSec
        );
      }
    }
    const end = cursor + clipSec;
    if (i < tracks.length - 1) {
      for (let s = 0; s <= 10; s++) {
        g.setValueAtTime(
          Math.cos(((s / 10) * Math.PI) / 2),
          end - fadeSec + (s / 10) * fadeSec
        );
      }
    }
    src.start(cursor, start, clipSec + 0.1);
    cursor = end - fadeSec;
  });

  return ctx.startRendering();
}

/**
 * Render a standalone "wordplay edit" clip (the 50 Cent → Usher "Shorty"
 * format): a few bars of A leading into the shared word, the word stuttered on
 * the beat with a rising echo, then B slamming in on its own word. Offline,
 * faster than realtime. Returns a 2ch AudioBuffer ready for WAV/video export.
 */
export async function renderWordplayClip(
  a: { buffer: AudioBuffer; bpm: number },
  b: { buffer: AudioBuffer; bpm: number },
  h: { aWordTime: number; aWordEnd: number; bWordTime: number },
  opts: { leadBeats?: number; repeats?: number; tailSec?: number } = {}
): Promise<AudioBuffer> {
  const sr = 44100;
  const bpmA = a.bpm > 0 ? a.bpm : 120;
  const beatA = 60 / bpmA;
  const wordDur = Math.max(0.12, h.aWordEnd - h.aWordTime);
  const loopLen = Math.min(
    0.9,
    [beatA / 4, beatA / 2, beatA, beatA * 2].find((d) => d >= wordDur * 0.85) ??
      beatA * 2
  );
  const repeats = opts.repeats ?? 4;
  const leadBeats = opts.leadBeats ?? 16;
  const tailSec = opts.tailSec ?? 10;

  const leadStart = Math.max(0, h.aWordTime - leadBeats * beatA);
  const tWord = h.aWordTime - leadStart; // clip-time when the stutter begins
  const stutterDur = loopLen * repeats;
  const dropAt = tWord + stutterDur;
  const total = dropAt + tailSec;

  const ctx = new OfflineAudioContext(2, Math.ceil(total * sr), sr);

  // echo bus for the stutter swell
  const echo = ctx.createDelay(1);
  echo.delayTime.value = beatA * 0.375;
  const fb = ctx.createGain();
  fb.gain.value = 0.45;
  echo.connect(fb).connect(echo);
  echo.connect(ctx.destination);
  const echoSend = ctx.createGain();
  echoSend.gain.value = 0;
  echoSend.connect(echo);

  // A — lead-in up to the word
  const lead = ctx.createBufferSource();
  lead.buffer = a.buffer;
  const gLead = ctx.createGain();
  lead.connect(gLead).connect(ctx.destination);
  lead.start(0, leadStart);
  lead.stop(tWord + 0.03);

  // A — stutter loop of the word, echo rising into the drop
  const loop = ctx.createBufferSource();
  loop.buffer = a.buffer;
  loop.loop = true;
  loop.loopStart = h.aWordTime;
  loop.loopEnd = h.aWordTime + loopLen;
  const gLoop = ctx.createGain();
  loop.connect(gLoop).connect(ctx.destination);
  gLoop.connect(echoSend);
  echoSend.gain.setValueAtTime(0.15, tWord);
  echoSend.gain.linearRampToValueAtTime(0.7, dropAt);
  gLoop.gain.setValueAtTime(1, tWord);
  gLoop.gain.setValueAtTime(1, dropAt - 0.02);
  gLoop.gain.linearRampToValueAtTime(0, dropAt + 0.06);
  loop.start(tWord, h.aWordTime);
  loop.stop(dropAt + 0.06);

  // B — slams in on its own word
  const bSrc = ctx.createBufferSource();
  bSrc.buffer = b.buffer;
  const gB = ctx.createGain();
  bSrc.connect(gB).connect(ctx.destination);
  gB.gain.setValueAtTime(0, dropAt - 0.05);
  gB.gain.setValueAtTime(1, dropAt);
  bSrc.start(dropAt - 0.05, Math.max(0, h.bWordTime - 0.05));

  return ctx.startRendering();
}

/** Copy a [startSec, startSec+lenSec) slice of a buffer into a new AudioBuffer. */
export function sliceAudioBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  startSec: number,
  lenSec: number
): AudioBuffer {
  const sr = buffer.sampleRate;
  const start = Math.max(0, Math.floor(startSec * sr));
  const len = Math.min(Math.floor(lenSec * sr), buffer.length - start);
  const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, len), sr);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(start, start + len));
  }
  return out;
}

/** PCM16 WAV encoder. */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numCh = Math.min(buffer.numberOfChannels, 2);
  const sr = buffer.sampleRate;
  const len = buffer.length * numCh * 2;
  const ab = new ArrayBuffer(44 + len);
  const view = new DataView(ab);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + len, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, len, true);

  const chans = Array.from({ length: numCh }, (_, c) => buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}
