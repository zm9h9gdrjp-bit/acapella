// Edit tools end-to-end: cut, move across layers, new layer by drag, copy/paste, repeat, undo/redo, migration.
// node tests/tools.cjs <outDir>
const { chromium } = require('playwright');
const assert = require('assert');
const OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('http://localhost:8765/');
  await p.waitForFunction(() => window.__app && window.__app.project);

  // seed: an OLD-format song (single clip per layer) to prove migration, at 120 bpm (bar = 2 s)
  await p.evaluate(async () => {
    const a = window.__app;
    const mk = (id, n, f) => a.engine.setBufferFromRecord({ id, sampleRate: 48000, channels: [new Float32Array(48000 * n).map((_, k) => Math.sin(k / f) * 0.4)] });
    mk('drums', 2, 9); mk('bass', 8, 40);
    const old = { id: 'oldsong', name: 'Old song', bpm: 120, beatsPerBar: 4, countInBars: 1, metronome: true, metronomeVolume: .7, snap: true,
      loop: { enabled: false, startBar: 1, endBar: 5 }, createdAt: 1, updatedAt: 1, tracks: [
        { id: 'tb', name: 'Bass', color: '#2f5d8a', volume: 1, pan: 0, reverb: 0, mute: false, solo: false, isReference: false, includeInExport: false,
          clip: { audioId: 'bass', offset: 0, trimStart: 0, trimEnd: 8 }, autotune: { enabled: false, key: 0, scale: 'major', speed: 60, amount: 100, processedAudioId: null } },
        { id: 'td', name: 'Drums', color: '#b8452b', volume: 1, pan: 0, reverb: 0, mute: false, solo: false, isReference: false, includeInExport: false,
          clip: { audioId: 'drums', offset: 0, trimStart: 0, trimEnd: 2 }, autotune: { enabled: false, key: 0, scale: 'major', speed: 60, amount: 100, processedAudioId: null } },
      ] };
    await window.__loadProject(old);
  });
  const T = () => p.evaluate(() => window.__app.project.tracks.map(t => ({ name: t.name, clips: t.clips.map(c => [+(c.offset + c.trimStart).toFixed(3), +(c.offset + c.trimEnd).toFixed(3), c.audioId]) })));
  let t = await T();
  console.log('migrated:', JSON.stringify(t));
  assert.equal(t[0].clips.length, 1); assert.equal(t[1].clips.length, 1);

  const lanes = await p.locator('#lanesCanvas').boundingBox();
  const geo = () => p.evaluate(() => ({ pps: window.__tl.pps, sl: document.getElementById('scroller').scrollLeft, st: document.getElementById('scroller').scrollTop }));
  const X = async (time) => { const g = await geo(); return lanes.x + time * g.pps - g.sl; };
  const Y = async (row) => { const g = await geo(); return lanes.y + row * 76 + 38 - g.st; };

  // 1. scissors: cut the bass at bar 3 (t = 4 s)
  await p.click('[data-tool="cut"]');
  await p.mouse.click(await X(4.03), await Y(0));
  t = await T();
  console.log('after cut:', JSON.stringify(t[0].clips));
  assert.deepEqual(t[0].clips.map(c => [c[0], c[1]]), [[0, 4], [4, 8]]);

  // 2. move tool: drag the right half of the bass down onto a NEW layer (row 2 = below the last)
  await p.click('[data-tool="move"]');
  await p.mouse.move(await X(6), await Y(0)); await p.mouse.down();
  await p.mouse.move(await X(6), await Y(1), { steps: 5 });
  await p.mouse.move(await X(6), await Y(2), { steps: 5 });
  await p.screenshot({ path: OUT + '/tools-drag.png' });
  await p.mouse.up();
  t = await T();
  console.log('after drag to new layer:', JSON.stringify(t.map(x => [x.name, x.clips])));
  assert.equal(t.length, 3); assert.deepEqual(t[2].clips.map(c => [c[0], c[1]]), [[4, 8]]);
  assert.deepEqual(t[0].clips.map(c => [c[0], c[1]]), [[0, 4]]);

  // 3. drag it back up onto the Drums layer, onto bar 1 -> overwrites the drum clip (0..2)
  await p.mouse.move(await X(5), await Y(2)); await p.mouse.down();
  await p.mouse.move(await X(1), await Y(1), { steps: 8 }); await p.mouse.up();
  t = await T();
  console.log('after drag onto drums (overwrite):', JSON.stringify(t[1].clips));
  assert.deepEqual(t[1].clips.map(c => [c[0], c[1], c[2]]), [[0, 4, 'bass']], 'drum clip overwritten');

  // 4. undo twice -> drums back, bass half back on the new layer; redo once
  await p.click('#actUndo');
  t = await T();
  assert.deepEqual(t[1].clips.map(c => c[2]), ['drums']);
  await p.click('#actUndo');
  t = await T();
  assert.equal(t.length, 2, 'new layer undone'); assert.deepEqual(t[0].clips.map(c => [c[0], c[1]]), [[0, 4], [4, 8]]);
  await p.click('#actRedo');
  t = await T();
  assert.equal(t.length, 3);
  await p.click('#actUndo');

  // 5. select the drum bar, Repeat 4x -> four bars of drums
  await p.mouse.click(await X(1), await Y(1));
  await p.click('#actRepeat');
  await p.click('#repeatDialog [data-times="4"]');
  t = await T();
  console.log('after repeat x4:', JSON.stringify(t[1].clips));
  assert.deepEqual(t[1].clips.map(c => [c[0], c[1]]), [[0, 2], [2, 4], [4, 6], [6, 8]]);

  // 6. fill to the end of bar 8 (t = 16 s)
  await p.click('#actRepeat');
  for (let i = 0; i < 20; i++) { if (+(await p.textContent('#fillBar')) === 8) break; await p.click(`#repeatDialog [data-fill-step="${+(await p.textContent('#fillBar')) > 8 ? -1 : 1}"]`); }
  await p.click('#btnFill');
  t = await T();
  assert.equal(t[1].clips.length, 8); assert.equal(t[1].clips[7][1], 16);

  // 7. copy + paste at the playhead on another layer, paste twice in a row lands end to end
  await p.mouse.click(await X(1), await Y(1));         // select first drum bar
  await p.keyboard.press('Control+c');
  await p.mouse.click(await X(9.5), await Y(0));        // empty space on Bass row: select layer + move playhead (snaps to beat)
  await p.click('#actPaste'); await p.click('#actPaste');
  t = await T();
  console.log('bass after 2 pastes:', JSON.stringify(t[0].clips));
  assert.deepEqual(t[0].clips.slice(-2).map(c => [c[0], c[1], c[2]]), [[9.5, 11.5, 'drums'], [11.5, 13.5, 'drums']]);

  // 8. delete key removes the selected clip; playback/export still work
  await p.keyboard.press('Delete');
  t = await T();
  assert.equal(t[0].clips.length, 3, 'two bass halves + one paste left');
  await p.click('#btnPlay'); await p.waitForTimeout(500); await p.click('#btnPlay');
  const mix = await p.evaluate(async () => { const m = await window.__app.engine.renderMix(window.__app.project); return m.channels[0].length / m.sampleRate; });
  console.log('export length', mix.toFixed(2), 's');
  assert(mix > 15);

  // 8b. a clip moved onto an auto-tuned layer gets tuned too
  await p.evaluate(() => { const d = window.__app.project.tracks[1].autotune; d.enabled = true; d.scale = 'chromatic'; d.processed = {}; d.sig = {}; });
  await p.mouse.move(await X(1), await Y(0)); await p.mouse.down();
  await p.mouse.move(await X(1), await Y(1), { steps: 6 }); await p.mouse.up();
  await p.waitForFunction(() => { const d = window.__app.project.tracks[1].autotune.processed; return d.bass && d.drums; }, null, { timeout: 20000 });
  console.log('moved clip got tuned on its new layer:', await p.evaluate(() => Object.keys(window.__app.project.tracks[1].autotune.processed).sort().join(',')));
  await p.click('#actUndo');

  // 9. persists after reload
  await p.evaluate(() => window.__app.saveNow());
  await p.reload();
  await p.waitForFunction(() => window.__app && window.__app.project && window.__app.project.id === 'oldsong');
  t = await T();
  assert.equal(t[1].clips.length, 8);
  await p.mouse.click(await X(3), await Y(1));
  await p.screenshot({ path: OUT + '/tools.png' });

  // phone layout of the toolbar
  await p.setViewportSize({ width: 390, height: 844 });
  const mp = p;
  await mp.waitForTimeout(300);
  await mp.evaluate(() => { const a = window.__app; const tr = a.project.tracks[1]; a.selectClip(tr.id, tr.clips[0].id); });
  await mp.screenshot({ path: OUT + '/tools-mobile.png' });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'no sideways page scroll on phones');

  console.log('errors', errs); assert.equal(errs.length, 0);
  await b.close(); console.log('TOOLS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
