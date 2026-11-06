// Mic lifecycle regression test: node tests/mic.cjs <fakeAudioWav>
const { chromium } = require('playwright');
const assert = require('assert');
const WAV = process.argv[2];
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ permissions: ['microphone'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:8765/');
  await p.waitForFunction(() => window.__app && window.__app.project);
  const n = () => p.evaluate(() => window.__app.project.tracks.length);
  const lastPeak = () => p.evaluate(() => {
    const a = window.__app, tr = a.project.tracks[a.project.tracks.length - 1];
    const d = a.engine.buffers.get(tr.clips[0].audioId).getChannelData(0);
    let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); return m;
  });
  async function take(ms = 5000) {
    const before = await n();
    await p.click('#btnRecord'); await p.waitForTimeout(ms); await p.click('#btnRecord');
    await p.waitForFunction((k) => window.__app.project.tracks.length === k, before + 1, { timeout: 6000 });
  }

  // 1. take 1, then the mic must be released (no call-audio mode while playing back)
  await take();
  await p.waitForTimeout(200);
  let st = await p.evaluate(() => ({ mic: !!window.__app.engine.mic }));
  console.log('after take 1: mic held =', st.mic, 'peak', (await lastPeak()).toFixed(3));
  assert.equal(st.mic, false, 'mic should be released after a take');
  assert((await lastPeak()) > 0.05, 'take 1 should contain sound');

  // 2. second take works and has sound
  await take();
  console.log('take 2 peak', (await lastPeak()).toFixed(3));
  assert((await lastPeak()) > 0.05);

  // 3. stale saved mic id (what happens after a phone restart) falls back to the default mic
  await p.evaluate(() => { window.__app.settings.deviceId = 'stale-id-from-last-launch'; });
  await take();
  const dev = await p.evaluate(() => window.__app.settings.deviceId);
  console.log('stale device id -> take 3 peak', (await lastPeak()).toFixed(3), 'saved id now', JSON.stringify(dev));
  assert((await lastPeak()) > 0.05);

  // 4. mic cut off by the phone while backgrounded: a dead stream must not be reused
  await p.evaluate(async () => {
    const e = window.__app.engine; await e.enableMic();
    e.mic.track.stop(); // simulates the OS killing the stream; 'ended' does not fire for this
  });
  await take();
  console.log('dead stream -> take 4 peak', (await lastPeak()).toFixed(3));
  assert((await lastPeak()) > 0.05, 'take after a dead stream should contain sound');

  // 5. going to the background releases the mic
  await p.evaluate(async () => { await window.__app.engine.enableMic(); });
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  st = await p.evaluate(() => !!window.__app.engine.mic);
  console.log('after backgrounding: mic held =', st);
  assert.equal(st, false);

  console.log('errors', errs); assert.equal(errs.length, 0);
  await b.close(); console.log('MIC TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
