// End-to-end smoke test: node tests/e2e.cjs <outDir> <fakeAudioWav>
const { chromium } = require('playwright');
const assert = require('assert');
const OUT = process.argv[2], WAV = process.argv[3];
const URL = 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(URL);
  await page.waitForFunction(() => window.__app && window.__app.project);
  await page.fill('#projectName', 'Test Song'); await page.press('#projectName', 'Enter');
  await page.fill('#bpm', '120'); await page.press('#bpm', 'Enter');

  const tracks = () => page.evaluate(() => window.__app.project.tracks.length);

  // Layer 1: free recording ~3s
  await page.click('#btnRecord');
  await page.waitForTimeout(4500);
  const counter = await page.textContent('#lcd');
  await page.click('#btnRecord');
  await page.waitForFunction(n => window.__app.project.tracks.length === n, 1, { timeout: 5000 });
  console.log('layer 1 recorded; counter during rec:', counter.replace(/\s+/g, ' ').trim());

  // Layer 2: punch-record a 2-bar loop (bars 1-2) -> auto-stops
  await page.evaluate(() => { window.__app.setLoop(1, 3, true); });
  await page.click('#btnRecord');
  await page.waitForFunction(() => window.__app.project.tracks.length === 2, null, { timeout: 12000 });
  const t2 = await page.evaluate(() => window.__app.project.tracks[1].clip);
  console.log('loop take clip:', t2);
  assert(Math.abs((t2.trimEnd - t2.trimStart) - 4) < 0.01, 'loop take should be exactly 2 bars (4s @120bpm 4/4)');
  assert(Math.abs(t2.offset + t2.trimStart) < 1e-6, 'loop take should start at bar 1');
  await page.click('#btnLoop'); // loop off

  // Play back briefly
  await page.click('#btnPlay'); await page.waitForTimeout(800);
  const playing = await page.evaluate(() => window.__app.engine.isRunning);
  await page.click('#btnPlay');
  assert(playing, 'should be playing');

  // Mute layer 1, open settings for layer 2 and apply auto-tune
  await page.click('.track-header:nth-child(1) .ms.m');
  await page.click('.track-header:nth-child(2) .th-gear');
  await page.selectOption('#atScale', 'chromatic');
  await page.click('#atApply');
  await page.waitForFunction(() => window.__app.project.tracks[1].autotune.processedAudioId, null, { timeout: 15000 });
  console.log('autotune status:', await page.textContent('#atStatus'));
  await page.screenshot({ path: OUT + '/track-dialog.png' });
  await page.click('#trackDialog footer .btn.primary');

  // Export
  await page.click('#btnExport');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDoExport')]);
  const p = await dl.path();
  const size = require('fs').statSync(p).size;
  console.log('export:', dl.suggestedFilename(), size, 'bytes');
  assert(size > 100000);
  await page.click('#exportDialog header button');

  await page.screenshot({ path: OUT + '/desktop.png' });

  // Persistence across reload
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.project && window.__app.project.tracks.length === 2);
  const persisted = await page.evaluate(() => ({ name: window.__app.project.name, bpm: window.__app.project.bpm,
    mute: window.__app.project.tracks[0].mute, tuned: !!window.__app.engine.bufferForTrack(window.__app.project.tracks[1]) }));
  console.log('after reload:', persisted);
  assert.equal(persisted.name, 'Test Song'); assert.equal(persisted.bpm, 120); assert(persisted.mute);

  // Mobile layout
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  await mp.goto(URL);
  await mp.waitForFunction(() => window.__app && window.__app.project);
  await mp.screenshot({ path: OUT + '/mobile-empty.png' });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('mobile horizontal overflow:', overflow);

  console.log('errors:', errors);
  assert.equal(errors.length, 0);
  await browser.close();
  console.log('E2E PASSED');
})().catch(e => { console.error(e); process.exit(1); });
