// Creating / deleting layers: node tests/layers.cjs <outDir> <fakeAudioWav>
const { chromium } = require('playwright');
const assert = require('assert');
const [OUT, WAV] = [process.argv[2], process.argv[3]];
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:8765/');
  await p.waitForFunction(() => window.__app && window.__app.project);
  await p.evaluate(() => { window.__app.project.bpm = 120; window.__app.render(); });
  const L = () => p.evaluate(() => window.__app.project.tracks.map(t => t.name + ':' + t.clips.length));

  // + Layer in the corner, then + Add layer at the bottom of the list
  await p.click('#btnAddLayer');
  await p.click('.add-row button');
  let l = await L();
  console.log('after adding two:', l);
  assert.deepEqual(l, ['Layer 1:0', 'Layer 2:0']);

  // select Layer 1 (empty) and record: the take goes INTO it, no new layer
  await p.click('.track-header:nth-child(1) .th-name');
  await p.screenshot({ path: OUT + '/layers-empty.png' });
  await p.click('#btnRecord'); await p.waitForTimeout(4500); await p.click('#btnRecord');
  await p.waitForFunction(() => window.__app.project.tracks[0].clips.length === 1, null, { timeout: 6000 });
  l = await L();
  console.log('after recording into Layer 1:', l);
  assert.deepEqual(l, ['Layer 1:1', 'Layer 2:0']);

  // select a layer with audio and record: a new layer is made
  await p.click('#btnRecord'); await p.waitForTimeout(4500); await p.click('#btnRecord');
  await p.waitForFunction(() => window.__app.project.tracks.length === 3, null, { timeout: 6000 });
  console.log('after second take:', await L());

  // one-tap delete with Undo in the message
  await p.click('.track-header:nth-child(1) .th-del');
  l = await L();
  assert.equal(l.length, 2);
  assert(await p.isVisible('#toastAction'));
  await p.screenshot({ path: OUT + '/layers-undo.png' });
  await p.click('#toastAction');
  l = await L();
  console.log('after delete + Undo:', l);
  assert.deepEqual(l[0], 'Layer 1:1');

  // headers and lanes stay aligned at the very bottom
  await p.evaluate(() => { document.getElementById('scroller').scrollTop = 99999; });
  await p.waitForTimeout(100);
  const st = await p.evaluate(() => [document.getElementById('scroller').scrollTop, document.getElementById('headersViewport').scrollTop]);
  assert.equal(st[0], st[1]);
  console.log('errors', errs); assert.equal(errs.length, 0);
  await b.close(); console.log('LAYERS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
