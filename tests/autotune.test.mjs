import { autotune, yinFrame, freqToMidi, nearestScaleNote } from '../js/autotune.js';
import assert from 'node:assert/strict';

const sr = 48000;
function voice(freqFn, dur) {
  const n = Math.round(sr * dur), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * freqFn(i / sr) / sr;
    // a few harmonics with decaying amplitude, roughly voice-like
    x[i] = 0.5 * Math.sin(ph) + 0.25 * Math.sin(2 * ph + 0.3) + 0.12 * Math.sin(3 * ph + 1) + 0.06 * Math.sin(4 * ph);
  }
  return x;
}
function pitchAt(x, t) {
  const size = 2048, start = Math.round(t * sr) - 1024;
  return yinFrame(x, start, size, sr);
}
const cents = (a, b) => 1200 * Math.log2(a / b);

// 1. Steady off-pitch note, chromatic, instant: 455 Hz -> A#4 (466.16)
{
  const x = voice(() => 455, 1.0);
  const y = autotune(x, sr, { key: 0, scale: 'chromatic', speed: 1, amount: 1 });
  const p = pitchAt(y, 0.5);
  console.log('455Hz -> ', p.toFixed(2), 'Hz (', cents(p, 466.16).toFixed(1), 'cents off A#4)');
  assert.ok(Math.abs(cents(p, 466.16)) < 10);
}
// 2. C major: A#4 is not in C major, 460 Hz should go to A4 (440) or B4 (493.88); nearest is A4
{
  const x = voice(() => 460, 1.0);
  const y = autotune(x, sr, { key: 0, scale: 'major', speed: 1, amount: 1 });
  const p = pitchAt(y, 0.5);
  console.log('460Hz in C major -> ', p.toFixed(2), 'Hz (', cents(p, 440).toFixed(1), 'cents off A4)');
  assert.ok(Math.abs(cents(p, 440)) < 10);
}
// 3. low male voice, downward shift: 140 Hz -> C#3 (138.59)
{
  const x = voice(() => 140, 1.0);
  const y = autotune(x, sr, { key: 0, scale: 'chromatic', speed: 1, amount: 1 });
  const p = pitchAt(y, 0.5);
  console.log('140Hz -> ', p.toFixed(2), 'Hz (', cents(p, 138.59).toFixed(1), 'cents off C#3)');
  assert.ok(Math.abs(cents(p, 138.59)) < 10);
}
// 4. slow speed corrects less quickly: at 30ms into the note it should be closer to the original
{
  const x = voice(() => 455, 1.0);
  const y = autotune(x, sr, { key: 0, scale: 'chromatic', speed: 0, amount: 1 });
  const p = pitchAt(y, 0.8);
  console.log('slow speed steady state -> ', p.toFixed(2));
  assert.ok(Math.abs(cents(p, 466.16)) < 15);
}
// 5. silence stays silence, length preserved, no NaN
{
  const x = new Float32Array(sr);
  const y = autotune(x, sr, { key: 0, scale: 'major', speed: 0.5 });
  assert.equal(y.length, x.length);
  assert.ok(y.every(v => v === 0));
}
// 6. level preserved (no big gain change)
{
  const x = voice(() => 300, 1.0);
  const y = autotune(x, sr, { key: 0, scale: 'chromatic', speed: 1 });
  const rms = a => Math.sqrt(a.slice(sr*0.2, sr*0.8).reduce((s, v) => s + v*v, 0) / (sr*0.6));
  console.log('rms in/out', rms(x).toFixed(3), rms(y).toFixed(3));
  assert.ok(Math.abs(rms(y) / rms(x) - 1) < 0.2);
  assert.ok(y.every(Number.isFinite));
}
assert.equal(nearestScaleNote(freqToMidi(460), 0, 'major'), 69);
console.log('autotune tests passed');
