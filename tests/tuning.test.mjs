import assert from 'node:assert/strict';
import { analyze, renderTuned, computeCorrection, styleDefaults, yinFrame, freqToMidi, midiToFreq } from '../js/autotune.js';

const sr = 48000;
// a sung line: three notes, slightly off, with 5.5 Hz vibrato (40 cents) and short gaps
function sing(parts) {
  const total = parts.reduce((s, p) => s + p.dur + (p.gap || 0), 0);
  const x = new Float32Array(Math.round(total * sr));
  let i = 0, ph = 0;
  for (const p of parts) {
    const n = Math.round(p.dur * sr);
    for (let k = 0; k < n; k++, i++) {
      const t = k / sr;
      const m = p.midi + (p.vib || 0) * Math.sin(2 * Math.PI * 5.5 * t);
      ph += 2 * Math.PI * midiToFreq(m) / sr;
      const env = Math.min(1, k / 480, (n - k) / 480);
      x[i] = env * (0.5 * Math.sin(ph) + 0.22 * Math.sin(2 * ph + .4) + 0.1 * Math.sin(3 * ph + 1));
    }
    i += Math.round((p.gap || 0) * sr);
  }
  return x;
}
const pitchAt = (x, t) => freqToMidi(yinFrame(x, Math.round(t * sr) - 1024, 2048, sr));
// average pitch over a window (averages out vibrato)
const avgPitch = (x, t0, t1) => { let s = 0, n = 0; for (let t = t0; t < t1; t += 0.01) { const v = pitchAt(x, t); if (isFinite(v)) { s += v; n++; } } return s / n; };
const spread = (x, t0, t1) => { const v = []; for (let t = t0; t < t1; t += 0.01) v.push(pitchAt(x, t)); return Math.max(...v) - Math.min(...v); };

const x = sing([
  { midi: 57.3, dur: 0.6, vib: 0.4, gap: 0.08 },  // A3 a bit sharp
  { midi: 59.8, dur: 0.6, vib: 0.4 },             // B3-ish flat (no gap: legato)
  { midi: 61.75, dur: 0.7, vib: 0.4, gap: 0.05 }, // C#4/D4 between
]);
const an = analyze(x, sr);
console.log('notes:', an.notes.map(n => `${n.start.toFixed(2)}-${n.end.toFixed(2)} @${n.center.toFixed(2)}`).join(' | '));
assert.equal(an.notes.length, 3, 'three notes detected');
assert(Math.abs(an.notes[0].center - 57.3) < 0.15);
assert(Math.abs(an.notes[1].center - 59.8) < 0.15);
assert(Math.abs(an.notes[2].center - 61.75) < 0.15);

// natural style in A minor: centres pulled onto the scale, vibrato survives
{
  const opts = { key: 9, scale: 'minor', defaults: styleDefaults(0.3, 1) };
  const y = renderTuned(x, sr, an, an.notes, opts);
  const c = [avgPitch(y, 0.2, 0.5), avgPitch(y, 0.9, 1.15), avgPitch(y, 1.5, 1.85)];
  console.log('natural centres:', c.map(v => v.toFixed(2)).join(', '), ' vibrato spread note1:', spread(y, 0.2, 0.5).toFixed(2));
  assert(Math.abs(c[0] - 57) < 0.12 && Math.abs(c[1] - 60) < 0.12 && Math.abs(c[2] - 62) < 0.12);
  assert(spread(y, 0.2, 0.5) > 0.4, 'natural keeps vibrato');
}
// robotic: flat notes
{
  const opts = { key: 9, scale: 'minor', defaults: styleDefaults(1, 1) };
  const y = renderTuned(x, sr, an, an.notes, opts);
  console.log('robotic spread note1:', spread(y, 0.2, 0.5).toFixed(3));
  assert(spread(y, 0.2, 0.5) < 0.12, 'robotic flattens vibrato');
}
// per-note edit: move note 2 up to D4 (62) by hand
{
  const notes = an.notes.map((n, i) => i === 1 ? { ...n, target: 62 } : n);
  const opts = { key: 9, scale: 'minor', defaults: styleDefaults(0.3, 1) };
  const y = renderTuned(x, sr, an, notes, opts);
  const c = avgPitch(y, 0.9, 1.15);
  console.log('note 2 moved to D4:', c.toFixed(2));
  assert(Math.abs(c - 62) < 0.15);
}
// transition: correction changes smoothly between notes with a long transition, abruptly with 0 ms
{
  const slow = computeCorrection(an.f0, an.hop, sr, an.notes, { key: 9, scale: 'minor', defaults: { ...styleDefaults(0.3), transition: 150 } });
  const fast = computeCorrection(an.f0, an.hop, sr, an.notes, { key: 9, scale: 'minor', defaults: { ...styleDefaults(0.3), transition: 0 } });
  const maxStep = (c) => { let m = 0; for (let i = 1; i < c.length; i++) m = Math.max(m, Math.abs(c[i] - c[i - 1])); return m; };
  // compare only the centre-shift part by removing vibrato reshaping: use drift/vibrato neutral
  const neutral = (tr) => computeCorrection(an.f0, an.hop, sr, an.notes, { key: 9, scale: 'minor', defaults: { amount: 1, drift: 0, vibrato: 1, fine: 0, transition: tr } }).corr;
  console.log('largest frame-to-frame jump: 150 ms =', maxStep(neutral(150)).toFixed(3), ' 0 ms =', maxStep(neutral(0)).toFixed(3));
  assert(maxStep(neutral(150)) < maxStep(neutral(0)) / 3);
  void slow; void fast;
}
// leave-alone: amount 0, drift 0, vibrato 1 = untouched
{
  const { corr } = computeCorrection(an.f0, an.hop, sr, an.notes, { key: 0, scale: 'major', defaults: { amount: 0, drift: 0, vibrato: 1, fine: 0, transition: 50 } });
  assert(corr.every(v => Math.abs(v) < 1e-6));
}
console.log('tuning tests passed');
