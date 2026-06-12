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
