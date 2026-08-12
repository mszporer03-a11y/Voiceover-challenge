import { toMono } from './audioAnalysis.js';

export { toMono as getMonoSamples };

/**
 * Min/max envelope of `samples` between `startSec`/`endSec`, downsampled to
 * `bucketCount` buckets — cheap enough to recompute on every zoom/resize.
 * @returns {Float32Array} [min0, max0, min1, max1, ...]
 */
export function computePeaks(samples, sampleRate, startSec, endSec, bucketCount) {
  const startIdx = Math.max(0, Math.floor(startSec * sampleRate));
  const endIdx = Math.min(samples.length, Math.ceil(endSec * sampleRate));
  const span = Math.max(1, endIdx - startIdx);
  const samplesPerBucket = Math.max(1, Math.floor(span / bucketCount));

  const peaks = new Float32Array(bucketCount * 2);
  for (let b = 0; b < bucketCount; b++) {
    const bStart = startIdx + b * samplesPerBucket;
    const bEnd = Math.min(startIdx + (b + 1) * samplesPerBucket, endIdx);
    let min = 0;
    let max = 0;
    for (let i = bStart; i < bEnd; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[b * 2] = min;
    peaks[b * 2 + 1] = max;
  }
  return peaks;
}

/** Draws a min/max envelope waveform into `canvas`, sized to its CSS box. */
export function drawWaveform(canvas, peaks, opts = {}) {
  const { color = 'rgba(46, 196, 255, 0.85)', background = null } = opts;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  const bucketCount = peaks.length / 2;
  if (!bucketCount) return;
  const mid = height / 2;
  const barWidth = Math.max(1, width / bucketCount);

  ctx.fillStyle = color;
  for (let i = 0; i < bucketCount; i++) {
    const min = peaks[i * 2];
    const max = peaks[i * 2 + 1];
    const x = (i / bucketCount) * width;
    const y1 = mid - max * mid;
    const y2 = mid - min * mid;
    ctx.fillRect(x, y1, barWidth, Math.max(1, y2 - y1));
  }
}
