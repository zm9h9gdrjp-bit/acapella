// Tune editor + sync test + sound settings: node tests/tune.cjs <outDir> <fakeAudioWav>
const { chromium } = require('playwright');
const assert = require('assert');
const [OUT, WAV] = [process.argv[2], process.argv[3]];
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8765/');
  await p.waitForFunction(() => window.__app && window.__app.project);

  // a sung line: A3 a bit sharp, B3 flat, C#4/D4 in between (with vibrato), at 120 bpm
  await p.evaluate(async () => {
    const a = window.__app, sr = 48000;
    const parts = [[57.3, .6, .08], [59.8, .6, 0], [61.75, .7, .05]];
    const total = parts.reduce((s, q) => s + q[1] + q[2], 0) + 0.3;
    const x = new Float32Array(Math.round(total * sr));
    let i = Math.round(0.15 * sr), ph = 0;
    for (const [m, dur, gap] of parts) {
      const n = Math.round(dur * sr);
      for (let k = 0; k < n; k++, i++) {
        const mm = m + 0.4 * Math.sin(2 * Math.PI * 5.5 * k / sr);
        ph += 2 * Math.PI * 440 * Math.pow(2, (mm - 69) / 12) / sr;
        const env = Math.min(1, k / 480, (n - k) / 480);
        x[i] = env * (0.5 * Math.sin(ph) + 0.22 * Math.sin(2 * ph + .4) + 0.1 * Math.sin(3 * ph + 1));
      }
      i += Math.round(gap * sr);
    }
    a.engine.setBufferFromRecord({ id: 'melody', sampleRate: sr, channels: [x] });
    await window.__loadProject({ id: 'tunesong', name: 'Tune song', bpm: 120, beatsPerBar: 4, countInBars: 1, metronome: false, metronomeVolume: .7, snap: true,
      loop: { enabled: false, startBar: 1, endBar: 5 }, createdAt: 1, updatedAt: 1, tracks: [
        { id: 'lead', name: 'Lead', color: '#b8452b', volume: 1, pan: 0, reverb: 0.2, mute: false, solo: false, isReference: false, includeInExport: false,
          clips: [{ id: 'c1', audioId: 'melody', offset: 0.5, trimStart: 0, trimEnd: total }],
          autotune: { enabled: false, key: 9, scale: 'minor', speed: 40, amount: 100, processed: {}, sig: {} } }] });
    a.selectClip('lead', 'c1');
  });

  // open from the toolbar
  await p.click('#actTune');
  await p.waitForFunction(() => { const t = window.__app.project.tuning.melody; return t && t.notes.length === 3; }, null, { timeout: 15000 });
  await p.waitForFunction(() => { const a = window.__app.project.tracks[0].autotune; return a.enabled && a.processed.melody; }, null, { timeout: 20000 });
  const notes = () => p.evaluate(() => window.__app.project.tuning.melody.notes.map(n => ({ c: n.center, t: n.target, v: n.vibrato, a: n.amount, tr: n.transition })));
  console.log('notes found:', JSON.stringify(await notes()));
  await p.waitForTimeout(300);
  await p.screenshot({ path: OUT + '/tune.png' });

  const cv = await p.locator('#teCanvas').boundingBox();
  const at = (i) => p.evaluate((i) => { const te = window.__te, e = te.entries()[i]; return { x: te.x((e.t0 + e.t1) / 2), y: te.y(te.shownPitch(e.note)), semi: te.semi }; }, i);

  // 1. tap note 2, drag it up two scale steps (A minor: B3 -> C4 -> D4)
  let q = await at(1);
  await p.mouse.move(cv.x + q.x, cv.y + q.y); await p.mouse.down();
  await p.mouse.move(cv.x + q.x, cv.y + q.y - q.semi * 3, { steps: 6 }); await p.mouse.up();
  let n = await notes();
  console.log('note 2 after drag:', n[1]);
  assert(n[1].t >= 61 && n[1].t <= 62, 'dragged up to C#4/D4 area');
  assert.equal(await p.textContent('#teNote'), require('util').format('%s', await p.evaluate(() => { const t = window.__app.project.tuning.melody.notes[1].target; return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][t % 12] + (Math.floor(t / 12) - 1); })));

  // 2. undo / redo
  await p.click('#teUndo');
  n = await notes(); assert.equal(n[1].t, undefined, 'undo restores the note');
  await p.click('#teRedo');
  n = await notes(); assert(n[1].t >= 61);

  // 3. inspector: flatten vibrato on note 2, copy that tuning, multi-select notes 1 & 3, paste
  await p.$eval('#teVibrato', el => { el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.$eval('#teTrans', el => { el.value = 0; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.click('#teCopy');
  await p.click('#teMulti');
  q = await at(1); await p.mouse.click(cv.x + q.x, cv.y + q.y); // deselect note 2
  q = await at(0); await p.mouse.click(cv.x + q.x, cv.y + q.y);
  q = await at(2); await p.mouse.click(cv.x + q.x, cv.y + q.y);
  await p.click('#tePaste');
  await p.click('#teMulti');
  n = await notes();
  console.log('after paste:', JSON.stringify(n.map(x => [x.v, x.tr])));
  assert.equal(n[0].v, 0); assert.equal(n[2].v, 0); assert.equal(n[0].tr, 0);

  // 4. cut tool splits note 1
  await p.click('[data-te-tool="cut"]');
  q = await at(0); await p.mouse.click(cv.x + q.x, cv.y + q.y);
  assert.equal((await notes()).length, 4, 'note split in two');
  await p.click('#teUndo');
  assert.equal((await notes()).length, 3);
  await p.click('[data-te-tool="select"]');

  // 5. the rendered sound follows the edits: note 2 comes out at its new target, flat (no vibrato)
  await p.waitForFunction(() => !window.__te.h.tuning.busy('lead') && window.__te.h.tuning.stale(window.__app.project.tracks[0]).length === 0, null, { timeout: 20000 });
  const res = await p.evaluate(async () => {
    const { yinFrame, freqToMidi } = await import('/js/autotune.js');
    const a = window.__app, tr = a.project.tracks[0];
    const buf = a.engine.buffers.get(tr.autotune.processed.melody), x = buf.getChannelData(0), sr = buf.sampleRate;
    const nt = a.project.tuning.melody.notes[1];
    const vals = [];
    for (let t = nt.start + 0.12; t < nt.end - 0.1; t += 0.01) vals.push(freqToMidi(yinFrame(x, Math.round(t * sr) - 1024, 2048, sr)));
    return { target: nt.target, mean: vals.reduce((s, v) => s + v, 0) / vals.length, spread: Math.max(...vals) - Math.min(...vals) };
  });
  console.log('rendered note 2:', res);
  assert(Math.abs(res.mean - res.target) < 0.15, 'note lands on its new target');
  assert(res.spread < 0.2, 'vibrato flattened as set');

  // 6. A/B
  await p.click('#teAB');
  assert.equal(await p.evaluate(() => window.__app.project.tracks[0].autotune.enabled), false);
  await p.click('#teAB');
  await p.click('#tePlay'); await p.waitForTimeout(400); await p.click('#tePlay');
  await p.screenshot({ path: OUT + '/tune-edited.png' });
  await p.click('#teDone');

  // 7. sound presets + export with the new chain
  await p.click('.track-header .th-gear');
  await p.click('#mixPresets [data-preset="lead"]');
  const mix = await p.evaluate(() => window.__app.project.tracks[0].mix);
  assert.equal(mix.presence, 3);
  await p.screenshot({ path: OUT + '/sound.png' });
  await p.click('#trackDialog footer .btn.primary');
  const len = await p.evaluate(async () => { const m = await window.__app.engine.renderMix(window.__app.project); let pk = 0; for (const v of m.channels[0]) pk = Math.max(pk, Math.abs(v)); return [m.channels[0].length / m.sampleRate, pk]; });
  console.log('export with sound settings:', len);
  assert(len[0] > 2 && len[1] > 0.05 && len[1] <= 1);

  // 8. Bluetooth estimate + clap-along sync test (claps simulated 215 ms after each click)
  const est = await p.evaluate(async () => { await window.__app.engine.init(); return [window.__app.engine.estimatedLatency('AirPods Pro'), window.__app.engine.estimatedLatency('iPhone Microphone')]; });
  console.log('estimates AirPods / built-in:', est.map(v => Math.round(v * 1000)));
  assert(est[0] - est[1] > 0.15);
  await p.evaluate(() => {
    const e = window.__app.engine;
    e._startCapture = function () {
      const sr = this.ctx.sampleRate, x = new Float32Array(Math.round(sr * 8.4));
      for (let i = 0; i < x.length; i++) x[i] = (Math.random() - 0.5) * 0.004;
      for (let b = 4; b < 12; b++) { const s = Math.round((b * 0.6 + 0.215 + (Math.random() - 0.5) * 0.02) * sr); for (let k = 0; k < 900; k++) x[s + k] += (Math.random() - 0.5) * 1.2 * Math.exp(-k / 250); }
      return new Promise(r => setTimeout(() => r(x), 300));
    };
    e._stopCapture = () => {};
  });
  await p.click('#btnSettings');
  await p.click('#btnSyncTest');
  await p.waitForFunction(() => /Done:/.test(document.getElementById('calibResult').textContent), null, { timeout: 15000 });
  const result = await p.textContent('#calibResult');
  const saved = await p.evaluate(() => window.__app.settings.latByDevice);
  console.log('sync test:', result, saved);
  const ms = Object.values(saved)[0];
  assert(Math.abs(ms - 215) < 15, 'measured about 215 ms');
  await p.screenshot({ path: OUT + '/sync.png' });
  await p.click('#settingsDialog footer .btn.primary');

  // 9. phone + dark layout of the editor
  await p.setViewportSize({ width: 390, height: 844 });
  await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.resolved = 'dark'; });
  await p.click('#actTune');
  await p.waitForTimeout(600);
  q = await at(1); await p.mouse.click((await p.locator('#teCanvas').boundingBox()).x + q.x, (await p.locator('#teCanvas').boundingBox()).y + q.y);
  await p.screenshot({ path: OUT + '/tune-mobile-dark.png' });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow);

  console.log('errors', errs); assert.equal(errs.length, 0);
  await b.close(); console.log('TUNE PASSED');
})().catch(e => { console.error(e); process.exit(1); });
