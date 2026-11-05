// Auto-tune DSP: YIN pitch detection + TD-PSOLA pitch shifting.
// Pure functions with no DOM dependencies, so this runs in a Web Worker and in Node tests.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const MIN_F0 = 70;   // Hz - low bass voice
const MAX_F0 = 1000; // Hz - high soprano

/**
 * YIN pitch detector on a single frame.
 * Returns frequency in Hz, or 0 if the frame is unvoiced.
 */
export function yinFrame(x, start, size, sampleRate, threshold = 0.15) {
  const maxTau = Math.min(Math.floor(sampleRate / MIN_F0), Math.floor(size / 2));
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_F0));
  const W = size - maxTau;
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) {
      const diff = x[start + i] - x[start + i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  // cumulative mean normalized difference
  let running = 0;
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return 0;
  // parabolic interpolation for sub-sample accuracy
  let betterTau = tau;
  if (tau > 1 && tau < maxTau) {
    const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
  }
  return sampleRate / betterTau;
}

/**
 * Track pitch across a whole signal.
 * Pitch is detected on a ~12 kHz downsampled copy for speed (voices top out well below 6 kHz
 * fundamentals), then reported per hop of the original signal.
 * Returns { hop, f0: Float32Array } where f0[i] is the pitch centred at sample i*hop (0 = unvoiced).
 */
export function trackPitch(x, sampleRate, onProgress) {
  const dec = Math.max(1, Math.round(sampleRate / 12000));
  const dsr = sampleRate / dec;
  // decimate with a simple boxcar low-pass
  const dn = Math.floor(x.length / dec);
  const xd = new Float32Array(dn);
  for (let i = 0; i < dn; i++) {
    let s = 0;
    for (let k = 0; k < dec; k++) s += x[i * dec + k];
    xd[i] = s / dec;
  }
  const size = Math.pow(2, Math.round(Math.log2(dsr * 0.04))); // ~40ms window
  const hop = dec * Math.round(dsr * 0.005); // ~5ms hop, in original samples
  const dhop = hop / dec;
  const frames = Math.max(1, Math.floor(x.length / hop));
  const f0 = new Float32Array(frames);
  const half = size >> 1;

  // level gate so silence/breath noise is left alone
  let peak = 0;
  for (let i = 0; i < dn; i++) peak = Math.max(peak, Math.abs(xd[i]));
  const gate = Math.max(1e-4, peak * 0.03);

  for (let f = 0; f < frames; f++) {
    const start = f * dhop - half;
    if (start < 0 || start + size > dn) { f0[f] = 0; continue; }
    let e = 0;
    for (let i = start; i < start + size; i += 2) e += xd[i] * xd[i];
    const rms = Math.sqrt(e / (size / 2));
    f0[f] = rms < gate ? 0 : yinFrame(xd, start, size, dsr);
    if (onProgress && f % 1000 === 0) onProgress(0.5 * f / frames);
  }
  return { hop, f0: cleanPitch(f0) };
}

// Median filter + removal of very short voiced blips; fixes most octave glitches.
function cleanPitch(f0) {
  const out = new Float32Array(f0.length);
  const win = [];
  for (let i = 0; i < f0.length; i++) {
    win.length = 0;
    for (let k = -2; k <= 2; k++) {
      const v = f0[i + k];
      if (v > 0) win.push(v);
    }
    if (f0[i] === 0 || win.length < 3) { out[i] = 0; continue; }
    win.sort((a, b) => a - b);
    out[i] = win[win.length >> 1];
  }
  return out;
}

export function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** Nearest note (as midi number) in the given key/scale. */
export function nearestScaleNote(midi, key, scale) {
  const degrees = SCALES[scale] || SCALES.chromatic;
  let best = Math.round(midi), bestDist = Infinity;
  const base = Math.floor(midi) - 12;
  for (let n = base; n <= base + 25; n++) {
    const pc = ((n - key) % 12 + 12) % 12;
    if (!degrees.includes(pc)) continue;
    const dist = Math.abs(n - midi);
    if (dist < bestDist) { bestDist = dist; best = n; }
  }
  return best;
}

/**
 * Compute per-frame pitch ratio (target/actual).
 * speed: 0 (slow, natural glide) .. 1 (instant, robotic)
 * amount: 0..1 how much correction to apply
 */
export function computeRatios(f0, hop, sampleRate, { key = 0, scale = 'major', speed = 0.5, amount = 1 }) {
  const ratios = new Float32Array(f0.length).fill(1);
  // time constant: speed 1 -> instant, speed 0 -> 250ms
  const tau = (1 - speed) * 0.25;
  const frameDur = hop / sampleRate;
  const alpha = tau <= 0.0005 ? 1 : 1 - Math.exp(-frameDur / tau);
  let smoothed = 0;
  let prevTarget = null;
  let wasVoiced = false;
  for (let i = 0; i < f0.length; i++) {
    if (f0[i] <= 0) { wasVoiced = false; prevTarget = null; ratios[i] = 1; continue; }
    const midi = freqToMidi(f0[i]);
    let target = nearestScaleNote(midi, key, scale);
    // hysteresis: stay on the previous note unless clearly closer to another one
    if (prevTarget !== null && target !== prevTarget && Math.abs(midi - prevTarget) < 0.65 &&
        Math.abs(midi - target) > 0.35) {
      target = prevTarget;
    }
    prevTarget = target;
    const correction = (target - midi) * amount; // semitones
    if (!wasVoiced) smoothed = alpha === 1 ? correction : correction * Math.min(1, alpha * 4);
    else smoothed += (correction - smoothed) * alpha;
    wasVoiced = true;
    ratios[i] = Math.pow(2, smoothed / 12);
  }
  return ratios;
}

/**
 * TD-PSOLA pitch shift with time-varying ratio.
 * x: input samples; f0/ratios per frame of `hop` samples.
 */
export function psola(x, sampleRate, f0, ratios, hop, onProgress) {
  const N = x.length;
  const out = new Float32Array(N);
  const wsum = new Float32Array(N);
  const frameAt = (i) => Math.min(f0.length - 1, Math.max(0, Math.round(i / hop)));
  const unvoicedPeriod = Math.round(sampleRate / 200);

  // 1. analysis pitch marks in voiced regions
  const marks = []; // {pos, period}
  let i = 0;
  while (i < N) {
    const fi = frameAt(i);
    if (f0[fi] <= 0) { i += hop; continue; }
    // start of a voiced run: find the first peak within one period
    let P = Math.round(sampleRate / f0[fi]);
    let best = i, bestVal = -Infinity;
    for (let k = i; k < Math.min(N, i + P); k++) if (x[k] > bestVal) { bestVal = x[k]; best = k; }
    let m = best;
    while (m < N) {
      const fm = frameAt(m);
      if (f0[fm] <= 0) break;
      P = Math.round(sampleRate / f0[fm]);
      marks.push({ pos: m, period: P });
      const pred = m + P;
      const r = Math.max(1, Math.floor(P / 4));
      let nb = pred, nv = -Infinity;
      for (let k = pred - r; k <= pred + r && k < N; k++) if (k > m && x[k] > nv) { nv = x[k]; nb = k; }
      if (nb >= N) break;
      m = nb;
    }
    i = m + hop;
  }

  // 2. synthesis: walk output time (fractional, so pitch has no rounding error),
  //    overlap-adding Hann-windowed grains taken from the nearest analysis mark.
  let mi = 0; // index into marks (monotonic)
  let t = 0;
  let lastReport = 0;
  while (t < N) {
    const ti = Math.round(t);
    const fi = frameAt(ti);
    let centre = ti, L = unvoicedPeriod, step = unvoicedPeriod;
    if (f0[fi] > 0 && marks.length) {
      while (mi + 1 < marks.length && Math.abs(marks[mi + 1].pos - t) <= Math.abs(marks[mi].pos - t)) mi++;
      const mk = marks[mi];
      if (Math.abs(mk.pos - t) <= mk.period) {
        centre = mk.pos;
        L = mk.period;
        step = (sampleRate / f0[fi]) / ratios[fi];
      }
    }
    for (let k = -L; k < L; k++) {
      const src = centre + k, dst = ti + k;
      if (src < 0 || src >= N || dst < 0 || dst >= N) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / L);
      out[dst] += x[src] * w;
      wsum[dst] += w;
    }
    t += Math.max(1, step);
    if (onProgress && t - lastReport > 20000) { lastReport = t; onProgress(0.5 + 0.5 * t / N); }
  }
  for (let k = 0; k < N; k++) {
    // weighted average of overlapping grains => no amplitude ripple
    out[k] = wsum[k] > 1e-6 ? out[k] / wsum[k] : x[k];
  }
  return out;
}

/** Full auto-tune: returns a new Float32Array. */
export function autotune(x, sampleRate, params, onProgress) {
  const { hop, f0 } = trackPitch(x, sampleRate, onProgress);
  const ratios = computeRatios(f0, hop, sampleRate, params);
  return psola(x, sampleRate, f0, ratios, hop, onProgress);
}
