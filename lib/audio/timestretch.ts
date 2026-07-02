/**
 * Pitch-preserving time-stretch (key-lock / master tempo).
 *
 * `beatMatch` in the engine glides `playbackRate`, which also shifts pitch ,
 * fighting harmonic mixing. This stretches a buffer's DURATION by `factor`
 * (pitch untouched) so the engine can then play it at rate 1 and have it both
 * tempo-matched AND in its original key.
 *
 * Plain overlap-add with a Hann window at 50% synthesis overlap. Beat-matching
 * only engages within ~8% tempo difference, so `factor` stays in ~0.92–1.08 ,
 * a mild stretch where OLA is essentially transparent and a WSOLA search isn't
 * worth its cost. Runs synchronously on the raw channel data (no
 * OfflineAudioContext), so it's cheap enough to do during prepare-ahead.
 *
 * factor > 1 → longer/slower, factor < 1 → shorter/faster. Pitch is preserved.
 */
export function timeStretchBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  factor: number
): AudioBuffer {
  // near-unity (or nonsensical) factors aren't worth stretching
  if (!isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.005) {
    return buffer;
  }

  const frame = 2048;
  const synthHop = frame / 2; // 50% overlap
  const analysisHop = synthHop / factor;
  const inLen = buffer.length;
  const outLen = Math.max(frame, Math.floor(inLen * factor) + frame);

  const win = hann(frame);
  const out = ctx.createBuffer(buffer.numberOfChannels, outLen, buffer.sampleRate);

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const x = buffer.getChannelData(ch);
    const y = out.getChannelData(ch);
    const norm = new Float32Array(outLen);

    let frameIdx = 0;
    for (let outPos = 0; outPos + frame < outLen; outPos += synthHop) {
      const inStart = Math.floor(frameIdx * analysisHop);
      frameIdx++;
      for (let n = 0; n < frame; n++) {
        const xs = inStart + n;
        const s = xs < inLen ? x[xs] : 0;
        const w = win[n];
        y[outPos + n] += s * w;
        norm[outPos + n] += w;
      }
    }
    // normalize by the summed window so amplitude stays flat across overlaps
    for (let n = 0; n < outLen; n++) {
      if (norm[n] > 1e-6) y[n] /= norm[n];
    }
  }
  return out;
}

function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}
