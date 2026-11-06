const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:8765/');
  await p.waitForFunction(() => window.__app && window.__app.project);
  await p.evaluate(async () => {
    const a = window.__app;
    a.engine.setBufferFromRecord({ id: 'n1', sampleRate: 48000, channels: [new Float32Array(48000 * 2).map((_, k) => Math.sin(k / 30) * .3)] });
    await window.__loadProject({ id: 'nudge', name: 'N', bpm: 120, beatsPerBar: 4, countInBars: 1, metronome: false, metronomeVolume: .7, snap: true,
      loop: { enabled: false, startBar: 1, endBar: 5 }, createdAt: 1, updatedAt: 1, tracks: [{ id: 't', name: 'Alto', color: '#2f5d8a', volume: 1, pan: 0, reverb: 0, mute: false, solo: false, isReference: false,
        clips: [{ id: 'c', audioId: 'n1', offset: 1, trimStart: 0, trimEnd: 2, rec: { mic: 'AirPods Pro', latencyMs: 190, measured: false } }], autotune: { enabled: false, key: 0, scale: 'major', speed: 40, amount: 100 } }] });
  });
  await p.click('.track-header .th-gear');
  const slide = (v, ev) => p.$eval('#tdNudge', (el, [v, ev]) => { el.value = v; for (const e of ev) el.dispatchEvent(new Event(e, { bubbles: true })); }, [v, ev]);
  await slide(-40, ['input', 'change']);
  await slide(-60, ['input', 'change']);   // second gesture must not double-count
  const off = await p.evaluate(() => window.__app.project.tracks[0].clips[0].offset);
  console.log('offset after -40 then -60 ms:', off);
  assert(Math.abs(off - 0.94) < 1e-6);
  console.log('hint:', await p.textContent('#tdNudgeText'));
  await p.click('#tdNudgeSave');
  const lat = await p.evaluate(() => window.__app.settings.latByDevice['AirPods Pro']);
  console.log('AirPods Pro latency learned:', lat);
  assert.equal(lat, 250);
  await p.click('#trackDialog footer .btn.primary');
  await p.click('#actUndo'); await p.click('#actUndo');
  assert(Math.abs(await p.evaluate(() => window.__app.project.tracks[0].clips[0].offset) - 1) < 1e-6, 'undo restores timing');
  assert.equal(errs.length, 0, errs.join());
  await b.close(); console.log('NUDGE OK');
})().catch(e => { console.error(e); process.exit(1); });
