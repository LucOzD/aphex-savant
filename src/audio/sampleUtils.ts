// Sample loading + transient-based auto-slicing.

/** Decode an ArrayBuffer of encoded audio (wav/mp3/etc.) into an AudioBuffer. */
export async function decodeAudio(
  ctx: AudioContext,
  data: ArrayBuffer,
): Promise<AudioBuffer> {
  return await ctx.decodeAudioData(data);
}

/**
 * Detect transients (onsets) in a buffer and return slice boundaries in
 * seconds as [start, end] pairs. Uses a simple energy-based onset detector:
 * we compute short-window RMS and mark points where energy jumps sharply.
 *
 * @param maxSlices cap on number of slices returned.
 */
export function sliceByTransients(
  buffer: AudioBuffer,
  maxSlices = 16,
  sensitivity = 1.6,
): [number, number][] {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const win = Math.floor(0.01 * rate); // 10ms analysis window
  const hop = win;
  const rms: number[] = [];

  for (let i = 0; i + win < data.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const s = data[i + j];
      sum += s * s;
    }
    rms.push(Math.sqrt(sum / win));
  }

  // Onset = a window whose energy rises well above a running average.
  const onsets: number[] = [0];
  const minGapWindows = Math.floor(0.05 / 0.01); // 50ms minimum between slices
  let avg = rms[0] ?? 0;
  let lastOnset = -minGapWindows;
  for (let i = 1; i < rms.length; i++) {
    avg = avg * 0.85 + rms[i] * 0.15;
    if (rms[i] > avg * sensitivity && i - lastOnset >= minGapWindows) {
      onsets.push(i * hop);
      lastOnset = i;
    }
  }

  // Convert onset sample positions to [start,end] second pairs.
  let bounds = onsets.map((s) => s / rate);
  bounds.push(buffer.duration);

  let slices: [number, number][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    slices.push([bounds[i], bounds[i + 1]]);
  }

  // If we found too many, keep the loudest; if too few, fall back to a grid.
  if (slices.length > maxSlices) {
    slices = slices.slice(0, maxSlices);
  } else if (slices.length < 2) {
    slices = sliceByGrid(buffer, maxSlices);
  }
  return slices;
}

/** Divide a buffer into `n` equal slices. */
export function sliceByGrid(buffer: AudioBuffer, n: number): [number, number][] {
  const step = buffer.duration / n;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push([i * step, (i + 1) * step]);
  return out;
}
