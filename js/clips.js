// Clip editing rules. Pure functions on plain data so they can be unit tested.
//
// A layer (track) holds any number of clips:
//   clip = { id, audioId, offset, trimStart, trimEnd }
//   offset    = timeline time (s) of the audio's first sample
//   trimStart = where the audible part begins, in seconds into the audio
//   trimEnd   = where it ends, in seconds into the audio
// Several clips may share one audioId (cuts and copies never duplicate audio).

const MIN_LEN = 0.01; // seconds; shorter slivers are dropped

export const clipStart = (c) => c.offset + c.trimStart;
export const clipEnd = (c) => c.offset + c.trimEnd;
export const clipLen = (c) => c.trimEnd - c.trimStart;

/** Upgrade songs saved before layers could hold several clips. Mutates and returns p. */
export function migrateProject(p, makeId) {
  for (const tr of p.tracks) {
    if (!tr.clips) {
      tr.clips = tr.clip ? [{ id: makeId(), ...tr.clip }] : [];
      delete tr.clip;
    }
    const a = tr.autotune || (tr.autotune = { enabled: false, key: 0, scale: 'major', speed: 60, amount: 100 });
    if (!a.processed) {
      a.processed = {};
      if (a.processedAudioId && tr.clips[0]) a.processed[tr.clips[0].audioId] = a.processedAudioId;
    }
    delete a.processedAudioId;
  }
  return p;
}

export function sortClips(track) {
  track.clips.sort((a, b) => clipStart(a) - clipStart(b));
}

export function findClip(project, clipId) {
  for (const tr of project.tracks) {
    const clip = tr.clips.find(c => c.id === clipId);
    if (clip) return { track: tr, clip };
  }
  return null;
}

/**
 * Overwrite: make room for [start, end) on the track by trimming, splitting or removing
 * any other clip underneath. `keepId` is the clip being placed (left alone).
 */
export function clearRange(track, start, end, makeId, keepId = null) {
  const out = [];
  for (const c of track.clips) {
    if (c.id === keepId) { out.push(c); continue; }
    const s = clipStart(c), e = clipEnd(c);
    if (e <= start + 1e-9 || s >= end - 1e-9) { out.push(c); continue; } // no overlap
    if (s < start && e > end) {
      // the new clip lands in the middle: split this one around it
      out.push({ ...c, trimEnd: start - c.offset });
      out.push({ ...c, id: makeId(), trimStart: end - c.offset });
      continue;
    }
    if (s < start) { out.push({ ...c, trimEnd: start - c.offset }); continue; }   // tail covered
    if (e > end) { out.push({ ...c, trimStart: end - c.offset }); continue; }      // head covered
    // fully covered: dropped
  }
  track.clips = out.filter(c => clipLen(c) >= MIN_LEN);
}

/** Put a clip on a track, overwriting whatever is underneath. */
export function placeClip(track, clip, makeId) {
  clearRange(track, clipStart(clip), clipEnd(clip), makeId, clip.id);
  if (!track.clips.includes(clip)) track.clips.push(clip);
  sortClips(track);
  return clip;
}

/** Cut a clip in two at timeline time t. Returns the new right-hand clip, or null. */
export function splitClip(track, clip, t, makeId) {
  if (t <= clipStart(clip) + MIN_LEN || t >= clipEnd(clip) - MIN_LEN) return null;
  const right = { ...clip, id: makeId(), trimStart: t - clip.offset };
  clip.trimEnd = t - clip.offset;
  track.clips.push(right);
  sortClips(track);
  return right;
}

/**
 * Lay copies of a clip end to end straight after it.
 * opts.times = total number of plays (2 = one extra copy), or opts.until = timeline time to fill up to.
 * Returns the new clips.
 */
export function repeatClip(track, clip, opts, makeId) {
  const len = clipLen(clip);
  if (len < MIN_LEN) return [];
  const added = [];
  let start = clipEnd(clip);
  const limit = opts.until != null ? opts.until : Infinity;
  const count = opts.times != null ? opts.times - 1 : Infinity;
  for (let k = 0; k < count && start < limit - MIN_LEN && k < 512; k++) {
    const copy = { ...clip, id: makeId(), offset: start - clip.trimStart };
    if (start + len > limit) copy.trimEnd = copy.trimStart + (limit - start); // last copy cut to fit
    placeClip(track, copy, makeId);
    added.push(copy);
    start += len;
  }
  return added;
}

/** Every audio id a project needs (raw takes and auto-tuned versions). */
export function referencedAudio(project, into = new Set()) {
  for (const tr of project.tracks) {
    for (const c of (tr.clips || [])) into.add(c.audioId);
    if (tr.clip) into.add(tr.clip.audioId);
    const a = tr.autotune || {};
    if (a.processed) for (const id of Object.values(a.processed)) into.add(id);
    if (a.processedAudioId) into.add(a.processedAudioId);
  }
  return into;
}
