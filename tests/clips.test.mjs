import assert from 'node:assert/strict';
import { migrateProject, placeClip, splitClip, repeatClip, clipStart, clipEnd, referencedAudio, findClip } from '../js/clips.js';

let n = 0;
const id = () => 'c' + (++n);
const near = (a, b) => Math.abs(a - b) < 1e-9;
const span = (c) => [+clipStart(c).toFixed(6), +clipEnd(c).toFixed(6)];

// migrate an old single-clip song
{
  const p = { tracks: [{ id: 't', clip: { audioId: 'a', offset: -2, trimStart: 2, trimEnd: 6 }, autotune: { enabled: true, processedAudioId: 'pa' } }] };
  migrateProject(p, id);
  assert.equal(p.tracks[0].clips.length, 1);
  assert.equal(p.tracks[0].clip, undefined);
  assert.deepEqual(span(p.tracks[0].clips[0]), [0, 4]);
  assert.deepEqual(p.tracks[0].autotune.processed, { a: 'pa' });
  assert.deepEqual([...referencedAudio(p)].sort(), ['a', 'pa']);
  migrateProject(p, id); // idempotent
  assert.equal(p.tracks[0].clips.length, 1);
}

// cut
{
  const tr = { clips: [{ id: 'x', audioId: 'a', offset: 1, trimStart: 0, trimEnd: 4 }] }; // plays 1..5
  const right = splitClip(tr, tr.clips[0], 3, id);
  assert.deepEqual(tr.clips.map(span), [[1, 3], [3, 5]]);
  assert.equal(right.audioId, 'a');
  assert.equal(splitClip(tr, tr.clips[0], 1, id), null, 'cut at the very edge does nothing');
}

// overwrite: drop into the middle of a clip splits it around the new one
{
  const tr = { clips: [{ id: 'x', audioId: 'a', offset: 0, trimStart: 0, trimEnd: 8 }] };
  placeClip(tr, { id: 'y', audioId: 'b', offset: 3, trimStart: 0, trimEnd: 2 }, id); // 3..5
  assert.deepEqual(tr.clips.map(span), [[0, 3], [3, 5], [5, 8]]);
  assert.equal(tr.clips[2].audioId, 'a');
  assert(near(tr.clips[2].trimStart, 5), 'right part still plays the right audio');
  // fully covering removes; partial covers trim
  placeClip(tr, { id: 'z', audioId: 'c', offset: 2, trimStart: 0, trimEnd: 4 }, id); // 2..6
  assert.deepEqual(tr.clips.map(span), [[0, 2], [2, 6], [6, 8]]);
  assert(!tr.clips.some(c => c.id === 'y'));
}

// moving a clip within its own track doesn't erase itself
{
  const tr = { clips: [{ id: 'x', audioId: 'a', offset: 0, trimStart: 0, trimEnd: 2 }] };
  tr.clips[0].offset = 1;
  placeClip(tr, tr.clips[0], id);
  assert.deepEqual(tr.clips.map(span), [[1, 3]]);
}

// repeat: one bar of drums (2s) x4, and fill until a time
{
  const tr = { clips: [{ id: 'd', audioId: 'drum', offset: -0.5, trimStart: 0.5, trimEnd: 2.5 }] }; // 0..2
  const added = repeatClip(tr, tr.clips[0], { times: 4 }, id);
  assert.equal(added.length, 3);
  assert.deepEqual(tr.clips.map(span), [[0, 2], [2, 4], [4, 6], [6, 8]]);
  assert(tr.clips.every(c => near(c.trimStart, 0.5) && c.audioId === 'drum'));
  const t2 = { clips: [{ id: 'd', audioId: 'drum', offset: 0, trimStart: 0, trimEnd: 2 }] };
  repeatClip(t2, t2.clips[0], { until: 7 }, id);
  assert.deepEqual(t2.clips.map(span), [[0, 2], [2, 4], [4, 6], [6, 7]], 'last copy trimmed to fit');
  // repeating over existing material overwrites it
  const t3 = { clips: [{ id: 'd', audioId: 'drum', offset: 0, trimStart: 0, trimEnd: 2 }, { id: 'o', audioId: 'old', offset: 0, trimStart: 3, trimEnd: 6 }] };
  repeatClip(t3, t3.clips[0], { times: 2 }, id);
  assert.deepEqual(t3.clips.map(span), [[0, 2], [2, 4], [4, 6]]);
  assert.equal(t3.clips[2].audioId, 'old');
}

{
  const p = { tracks: [{ id: 't1', clips: [{ id: 'q', audioId: 'a', offset: 0, trimStart: 0, trimEnd: 1 }] }] };
  assert.equal(findClip(p, 'q').track.id, 't1');
}
console.log('clip tests passed');
