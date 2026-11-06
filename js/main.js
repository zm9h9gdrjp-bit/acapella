import { AudioEngine, isBluetooth, MIX_DEFAULT, MIX_PRESETS } from './audio-engine.js';
import { Timeline } from './timeline.js';
import { db, uid, requestPersistence } from './storage.js';
import { encodeWav } from './wav.js';
import { Tuning } from './tuning.js';
import { TuneEditor } from './tune-editor.js';
import { NOTE_NAMES } from './autotune.js';
import { displayColor, applyTheme, onThemeChange } from './theme.js';
import { migrateProject, placeClip, splitClip, repeatClip, findClip, clipStart, clipEnd, clipLen, referencedAudio, sortClips } from './clips.js';

const $ = (id) => document.getElementById(id);
// marker-ink colours, picked by hand to sit on cream paper
const COLORS = ['#2f5d8a', '#b8452b', '#3f7a4f', '#7d4f93', '#b07d12', '#1f7373', '#8a3a2c', '#5b6b2e', '#9b4a72', '#44546a'];
const SETTINGS_KEY = 'acapella.settings';
const LAST_PROJECT_KEY = 'acapella.lastProject';

// ---------- device settings (per device, not per song) ----------
function loadSettings() {
  const def = { latAuto: true, latMs: 30, deviceId: '', monitor: false, theme: 'auto', latByDevice: {}, lastMicLabel: '' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return def; }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(app.settings)); } catch { /* */ } }

function newProjectData(name = 'Untitled song') {
  return {
    id: uid(), name, bpm: 90, beatsPerBar: 4, countInBars: 1,
    metronome: true, metronomeVolume: 0.7, snap: true,
    loop: { enabled: false, startBar: 1, endBar: 5 },
    tracks: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
}

const app = {
  engine: new AudioEngine(),
  project: null,
  playhead: 0,
  playStart: 0,
  recording: false,
  selectedTrackId: null,
  selectedClipId: null,
  tool: 'move',          // 'move' | 'cut'
  clipboard: null,       // { clip, fromTrackId }
  undoStack: [],
  redoStack: [],
  settings: loadSettings(),
  saveTimer: null,

  newId() { return uid(); },
  // ----- undo: whole-layer snapshots taken before each edit -----
  snapshot() { return structuredClone({ tracks: this.project.tracks, tuning: this.project.tuning || {} }); },
  restore(s) { this.project.tracks = s.tracks; this.project.tuning = s.tuning; },
  commit(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
    afterEdit();
  },
  undo() {
    if (!this.undoStack.length || this.recording) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    afterEdit(true);
  },
  redo() {
    if (!this.redoStack.length || this.recording) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    afterEdit(true);
  },

  // ----- selection -----
  selectClip(trackId, clipId) {
    this.selectedClipId = clipId;
    this.selectTrack(trackId);
    renderToolbar();
  },

  // ----- clip edits (each one undoable) -----
  cutClip(track, clip, t) {
    const before = this.snapshot();
    const right = splitClip(track, clip, t, uid);
    if (!right) return;
    this.selectedClipId = right.id;
    this.selectedTrackId = track.id;
    this.commit(before);
  },
  moveClip(fromTrack, clip, targetRow, targetStart, before) {
    const p = this.project;
    let dest = p.tracks[targetRow];
    if (!dest) {
      // dropped below the last layer: give it a layer of its own
      dest = makeTrack({ name: nextLayerName(), clips: [] });
      dest.autotune = structuredClone(fromTrack.autotune);
      dest.volume = fromTrack.volume; dest.pan = fromTrack.pan; dest.reverb = fromTrack.reverb;
      p.tracks.push(dest);
    }
    fromTrack.clips = fromTrack.clips.filter(c => c !== clip);
    clip.offset = targetStart - clip.trimStart;
    placeClip(dest, clip, uid);
    this.selectedClipId = clip.id;
    this.selectedTrackId = dest.id;
    if (dest !== fromTrack) ensureTuned(dest);
    this.commit(before);
  },
  trimClip(track, clip, before) {
    placeClip(track, clip, uid); // trimming over a neighbour overwrites it
    this.commit(before);
  },

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  },
  async saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.project) return;
    this.project.updatedAt = Date.now();
    try { await db.saveProject(this.project); } catch (e) { toast('Could not save: ' + e.message, true); }
  },
  seek(t) {
    if (this.engine.isRunning) {
      if (this.recording) return;
      this.playhead = Math.max(0, t);
      startPlayback();
      return;
    }
    this.playhead = Math.max(0, t);
    timeline.playhead = this.playhead;
    timeline.invalidate();
    updateCounter(this.playhead);
  },
  selectTrack(id) {
    this.selectedTrackId = id;
    timeline.selectedTrackId = id;
    document.querySelectorAll('.track-header').forEach(el => el.classList.toggle('selected', el.dataset.id === id));
    timeline.invalidate();
  },
  setLoop(startBar, endBar, enable) {
    const p = this.project;
    p.loop.startBar = startBar;
    p.loop.endBar = endBar;
    if (enable) p.loop.enabled = true;
    renderTransport();
    timeline.invalidate();
  },
  clipChanged() {
    this.saveSoon();
    timeline.invalidate();
  },
  loopChanged() {
    this.saveSoon();
    if (loopDialogOpen()) syncLoopDialog();
    restartIfPlaying();
  },
};

const timeline = new Timeline({
  scroller: $('scroller'), spacer: $('spacer'), ruler: $('rulerCanvas'), lanes: $('lanesCanvas'),
  headersViewport: $('headersViewport'), app,
});

// ---------- toast ----------
let toastTimer;
function toast(msg, isError = false, ms = 3200, action = null) {
  const el = $('toast');
  $('toastMsg').textContent = msg;
  const btn = $('toastAction');
  btn.hidden = !action;
  el.classList.toggle('has-action', !!action);
  btn.onclick = action ? () => { el.classList.remove('show'); action.fn(); } : null;
  if (action) btn.textContent = action.label;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- project loading ----------
async function loadProject(p) {
  if (app.engine.isRunning) app.engine.stop();
  migrateProject(p, uid);
  app.project = p;
  app.playhead = 0;
  app.selectedTrackId = null;
  app.selectedClipId = null;
  app.undoStack = []; app.redoStack = [];
  timeline.peaks.clear();
  try { localStorage.setItem(LAST_PROJECT_KEY, p.id); } catch { /* */ }
  const ids = referencedAudio(p);
  for (const id of ids) {
    if (app.engine.buffers.has(id)) continue;
    const rec = await db.getAudio(id);
    if (rec) app.engine.setBufferFromRecord(rec);
  }
  timeline.playhead = 0;
  timeline.scroller.scrollLeft = 0;
  renderAll();
}

async function createProject() {
  const p = newProjectData();
  await db.saveProject(p);
  await loadProject(p);
  return p;
}

// ---------- rendering ----------
function renderAll() {
  renderTransport();
  renderHeaders();
  renderToolbar();
  timeline.selectedTrackId = app.selectedTrackId;
  timeline.invalidate();
  updateCounter(app.playhead);
}

function renderTransport() {
  const p = app.project;
  $('projectName').value = p.name;
  if (document.activeElement !== $('bpm')) $('bpm').value = p.bpm;
  $('timeSig').value = String(p.beatsPerBar);
  $('countIn').value = String(p.countInBars);
  $('metVol').value = p.metronomeVolume;
  $('btnMetronome').setAttribute('aria-pressed', String(p.metronome));
  $('btnLoop').setAttribute('aria-pressed', String(p.loop.enabled));
  $('btnSnap').setAttribute('aria-pressed', String(p.snap));
  $('loopLabel').textContent = p.loop.endBar - p.loop.startBar === 1 ? `Bar ${p.loop.startBar}` : `Bars ${p.loop.startBar}–${p.loop.endBar - 1}`;
  $('loopLabel').disabled = app.recording;
  const dots = $('beatDots');
  if (dots.children.length !== p.beatsPerBar) {
    dots.innerHTML = '';
    for (let i = 0; i < p.beatsPerBar; i++) dots.appendChild(document.createElement('span'));
  }
  const running = app.engine.isRunning;
  $('btnPlay').classList.toggle('playing', running);
  $('btnPlay').setAttribute('aria-label', running ? 'Stop' : 'Play');
  $('playLabel').textContent = running ? 'Stop' : 'Play';
  $('btnRecord').classList.toggle('recording', app.recording);
  for (const id of ['bpm', 'bpmUp', 'bpmDown', 'btnTap', 'timeSig', 'countIn']) $(id).disabled = app.recording;
  renderToolbar();
}

function renderHeaders() {
  const p = app.project;
  const wrap = $('trackHeaders');
  wrap.innerHTML = '';
  p.tracks.forEach((tr) => {
    const el = document.createElement('div');
    el.className = 'track-header' + (tr.id === app.selectedTrackId ? ' selected' : '') + (tr.clips.length ? '' : ' empty-layer');
    el.dataset.id = tr.id;
    const tuned = tr.autotune && tr.autotune.enabled && Object.keys(tr.autotune.processed || {}).length > 0;
    el.innerHTML = `
      <div class="swatch" style="background:${displayColor(tr.color)}"></div>
      <div>
        <div class="th-top">
          <div class="th-name" title="${escapeHtml(tr.name)}">${tr.isReference ? '<span class="badge">REF</span>' : ''}${escapeHtml(tr.name)}</div>
          <button class="th-gear" title="Volume, pan, reverb, auto-tune">Edit</button>
        </div>
        <div class="th-bottom">
          <button class="ms m" aria-pressed="${tr.mute}" title="Mute">M</button>
          <button class="ms s" aria-pressed="${tr.solo}" title="Solo">S</button>
          <input type="range" min="0" max="1.5" step="0.01" value="${tr.volume}" aria-label="Volume">
          ${tuned ? '<span class="th-tuned" title="Auto-tune on">AT</span>' : ''}
          <button class="th-del" title="Delete this layer (Undo brings it back)" aria-label="Delete layer ${escapeHtml(tr.name)}">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/></g></svg>
          </button>
        </div>
      </div>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      app.selectClip(tr.id, null);
    });
    el.querySelector('.th-name').addEventListener('dblclick', () => openTrackDialog(tr));
    el.querySelector('.th-gear').addEventListener('click', () => { app.selectTrack(tr.id); openTrackDialog(tr); });
    el.querySelector('.m').addEventListener('click', (e) => {
      tr.mute = !tr.mute; e.currentTarget.setAttribute('aria-pressed', String(tr.mute)); mixChanged();
    });
    el.querySelector('.s').addEventListener('click', (e) => {
      tr.solo = !tr.solo; e.currentTarget.setAttribute('aria-pressed', String(tr.solo)); mixChanged();
    });
    el.querySelector('input[type=range]').addEventListener('input', (e) => { tr.volume = +e.target.value; mixChanged(); });
    el.querySelector('.th-del').addEventListener('click', () => deleteLayer(tr));
    wrap.appendChild(el);
  });
  const add = document.createElement('div');
  add.className = 'add-row';
  add.innerHTML = '<button type="button">+ Add layer</button>';
  add.querySelector('button').addEventListener('click', addLayer);
  wrap.appendChild(add);
  $('trackCount').textContent = `${p.tracks.length} layer${p.tracks.length === 1 ? '' : 's'}`;
  $('emptyState').hidden = p.tracks.length > 0 || app.recording;
  timeline.invalidate();
}

function mixChanged() {
  app.engine.updateMix(app.project);
  app.saveSoon();
  timeline.invalidate();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- counter ----------
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
const SIG_LABEL = { 2: '2/4', 3: '3/4', 4: '4/4', 5: '5/4', 6: '6/8', 7: '7/8' };

function updateCounter(t, countIn = null) {
  const p = app.project;
  const spb = 60 / p.bpm, barDur = spb * p.beatsPerBar;
  const lcd = $('lcd');
  let beat;
  if (countIn) {
    // count-in: the bar field shows how many bars are left, the beat field counts 1..N
    lcd.classList.add('countin');
    const barsLeft = Math.floor((countIn.total - countIn.beat - 1) / p.beatsPerBar) + 1;
    beat = countIn.beat % p.beatsPerBar;
    $('cBar').textContent = '-' + barsLeft;
    $('cBeat').textContent = String(beat + 1);
    $('cLabel').textContent = 'Count-in';
  } else {
    lcd.classList.remove('countin');
    const tt = t + 1e-6;
    const bar = Math.floor(tt / barDur);
    beat = Math.floor((tt - bar * barDur) / spb);
    $('cBar').textContent = String(bar + 1);
    $('cBeat').textContent = String(beat + 1);
    $('cLabel').textContent = app.recording ? 'Rec' : app.engine.isRunning ? (p.loop.enabled ? 'Loop' : 'Play') : '';
  }
  $('cLabel').classList.toggle('rec', app.recording);
  $('lcdTempo').textContent = p.bpm;
  $('lcdSig').textContent = SIG_LABEL[p.beatsPerBar] || p.beatsPerBar + '/4';
  $('cTime').textContent = fmtTime(Math.max(0, t));
  const running = app.engine.isRunning;
  [...$('beatDots').children].forEach((d, i) => {
    d.classList.toggle('on', running && i === beat);
    d.classList.toggle('accent', i === 0);
  });
}

function frame() {
  const pos = app.engine.position();
  if (pos) {
    if (pos.countIn) {
      const tp = app.engine.transport;
      updateCounter(pos.time, { beat: pos.beat, total: tp.countInBeats });
    } else {
      app.playhead = pos.time;
      timeline.playhead = pos.time;
      if (timeline.recording) timeline.recording.to = Math.max(timeline.recording.from, pos.time);
      timeline.scrollToTime(pos.time);
      timeline.invalidate();
      updateCounter(pos.time);
    }
  }
  requestAnimationFrame(frame);
}

// ---------- transport actions ----------
// ----- timing: each pair of earphones / mic remembers its own delay -----
const micKey = (label) => (label || '').trim() || 'Built-in mic';
function latencyInfo(label = app.engine.mic ? app.engine.mic.label : app.settings.lastMicLabel) {
  const key = micKey(label);
  const saved = app.settings.latByDevice[key];
  if (saved != null) return { key, sec: saved / 1000, measured: true };
  if (!app.settings.latAuto) return { key, sec: (app.settings.latMs || 0) / 1000, measured: true }; // old manual value
  return { key, sec: app.engine.estimatedLatency(label), measured: false };
}
function latencySeconds() { return latencyInfo().sec; }
function rememberMic() {
  if (app.engine.mic) { app.settings.lastMicLabel = app.engine.mic.label || ''; saveSettings(); }
}

async function startPlayback() {
  try {
    await app.engine.play({
      project: app.project,
      from: app.playhead,
      onEnded: onTransportEnded,
    });
    app.playStart = app.engine.transport ? app.engine.transport.from : app.playhead;
  } catch (e) {
    toast('Audio error: ' + e.message, true);
  }
  renderTransport();
}

function stopTransport() {
  app.engine.stop();
}

function onTransportEnded() {
  const wasRecording = app.recording;
  app.recording = false;
  timeline.recording = null;
  // return to where playback started, ready for the next take
  app.playhead = app.playStart;
  timeline.playhead = app.playhead;
  updateCounter(app.playhead);
  renderTransport();
  if (wasRecording) $('emptyState').hidden = app.project.tracks.length > 0;
  timeline.invalidate();
}

function togglePlay() {
  if (app.engine.isRunning) stopTransport();
  else startPlayback();
}

async function toggleRecord() {
  if (app.recording) { stopTransport(); return; }
  if (app.engine.isRunning) stopTransport();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Recording needs a secure (https) page and a modern browser.', true, 6000);
    return;
  }
  try {
    const { usedFallback } = await openMic();
    if (usedFallback) toast('The chosen microphone wasn\u2019t found, so the built-in one is being used.', false, 4500);
  } catch (e) {
    toast(e.name === 'NotAllowedError'
      ? 'Microphone access is blocked. Allow it for this app in your phone\u2019s settings, then try again.'
      : 'Could not open the microphone: ' + e.message, true, 6000);
    return;
  }
  rememberMic();
  const recLat = latencyInfo();
  const project = app.project;
  const projectId = project.id;
  // a selected empty layer gets the take; otherwise the take gets a new layer
  const target = project.tracks.find(t => t.id === app.selectedTrackId && !t.clips.length && !t.isReference) || null;
  const row = target ? project.tracks.indexOf(target) : project.tracks.length;
  try {
    app.recording = true;
    await app.engine.play({
      project,
      from: app.playhead,
      record: true,
      latency: recLat.sec,
      onEnded: onTransportEnded,
      onRecorded: (samples, info) => saveTake(projectId, samples, info, target && target.id, recLat),
    });
  } catch (e) {
    app.recording = false;
    toast('Audio error: ' + e.message, true);
    renderTransport();
    return;
  }
  const from = app.engine.transport.from;
  app.playStart = from;
  timeline.recording = { row, from, to: from, newRow: !target };
  $('emptyState').hidden = true;
  renderTransport();
}

async function saveTake(projectId, samples, info, targetId = null, lat = null) {
  if (!app.project || app.project.id !== projectId) return;
  const p = app.project;
  const sr = info.sampleRate;
  const dur = samples.length / sr;
  const trimStart = Math.max(0, info.visibleFrom - info.startTl);
  let trimEnd = info.loopLen != null ? trimStart + info.loopLen : dur;
  trimEnd = Math.min(trimEnd, dur);
  if (trimEnd - trimStart < 0.25) { toast('Too short to keep.'); return; }
  const audio = { id: uid(), sampleRate: sr, channels: [samples] };
  try {
    await db.saveAudio(audio);
  } catch (e) {
    toast('Could not save the recording (storage full?): ' + e.message, true, 6000);
    return;
  }
  app.engine.setBufferFromRecord(audio);
  const before = app.snapshot();
  const clip = { id: uid(), audioId: audio.id, offset: info.startTl, trimStart, trimEnd,
    rec: lat ? { mic: lat.key, latencyMs: Math.round(lat.sec * 1000), measured: lat.measured } : null };
  let tr = targetId && p.tracks.find(t => t.id === targetId && !t.clips.length);
  if (tr) { tr.clips.push(clip); ensureTuned(tr); }
  else { tr = makeTrack({ name: nextLayerName(), clips: [clip] }); p.tracks.push(tr); }
  app.selectedTrackId = tr.id;
  app.selectedClipId = clip.id;
  app.commit(before);
  timeline.scrollToRow(p.tracks.indexOf(tr));
  if (lat && !lat.measured && isBluetooth(lat.key)) {
    toast(`${tr.name} saved. Timing for ${lat.key} is only a guess: run the sync test once.`, false, 7000,
      { label: 'Sync test', fn: () => openSettings(true) });
  } else toast(`${tr.name} saved.`);
}

async function openMic() {
  const wanted = app.settings.deviceId || undefined;
  const res = await app.engine.enableMic(wanted);
  // phones hand out new mic IDs after a restart; forget one that no longer matches
  if (wanted && (res.usedFallback || (res.mic.deviceId && res.mic.deviceId !== wanted))) {
    res.usedFallback = true;
    app.settings.deviceId = ''; saveSettings();
  }
  return res;
}

function nextLayerName() {
  const used = new Set(app.project.tracks.map(t => t.name));
  let n = app.project.tracks.filter(t => !t.isReference).length + 1;
  while (used.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

function makeTrack({ name, clips = [], isReference = false }) {
  const used = new Set(app.project.tracks.map(t => t.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[app.project.tracks.length % COLORS.length];
  return {
    id: uid(), name, color,
    volume: isReference ? 0.7 : 1, pan: 0, reverb: isReference ? 0 : 0.2,
    mute: false, solo: false,
    isReference, includeInExport: false,
    clips,
    autotune: { enabled: false, key: 0, scale: 'major', speed: 40, amount: 100, processed: {}, sig: {} },
  };
}

function restartIfPlaying() {
  if (app.engine.isRunning && !app.recording) {
    const pos = app.engine.position();
    if (pos && !pos.countIn) app.playhead = pos.time;
    startPlayback();
  }
}

// ---------- transport controls ----------
$('btnPlay').addEventListener('click', togglePlay);
$('btnRecord').addEventListener('click', toggleRecord);
$('btnHome').addEventListener('click', () => { app.seek(0); timeline.scroller.scrollLeft = 0; });

function setBpm(v) {
  const bpm = Math.max(30, Math.min(300, Math.round(+v || 90)));
  app.project.bpm = bpm;
  $('bpm').value = bpm;
  app.saveSoon();
  timeline.invalidate();
  updateCounter(app.playhead);
  restartIfPlaying();
}
$('bpm').addEventListener('change', (e) => setBpm(e.target.value));
$('bpmUp').addEventListener('click', () => setBpm(app.project.bpm + 1));
$('bpmDown').addEventListener('click', () => setBpm(app.project.bpm - 1));
let taps = [];
$('btnTap').addEventListener('click', () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 3) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setBpm(60000 / iv);
  }
});
$('timeSig').addEventListener('change', (e) => {
  app.project.beatsPerBar = +e.target.value;
  app.saveSoon(); renderTransport(); timeline.invalidate(); updateCounter(app.playhead); restartIfPlaying();
});
$('countIn').addEventListener('change', (e) => { app.project.countInBars = +e.target.value; app.saveSoon(); });
$('btnMetronome').addEventListener('click', () => {
  const p = app.project;
  p.metronome = !p.metronome;
  app.engine.setMetronome(p.metronome, p.metronomeVolume);
  app.saveSoon(); renderTransport();
});
$('metVol').addEventListener('input', (e) => {
  const p = app.project;
  p.metronomeVolume = +e.target.value;
  if (app.engine.isRunning) app.engine.setMetronome(p.metronome, p.metronomeVolume);
  app.saveSoon();
});
$('btnLoop').addEventListener('click', () => {
  if (app.recording) return;
  app.project.loop.enabled = !app.project.loop.enabled;
  if (app.project.loop.enabled) toast('Loop on. Drag the yellow bar\u2019s ends to change the bars. REC records one pass.', false, 4000);
  app.saveSoon(); renderTransport(); timeline.invalidate(); restartIfPlaying();
});
$('btnSnap').addEventListener('click', () => { app.project.snap = !app.project.snap; app.saveSoon(); renderTransport(); });
$('zoomIn').addEventListener('click', () => timeline.zoomAt(1.4, timeline.scroller.clientWidth / 2));
$('zoomOut').addEventListener('click', () => timeline.zoomAt(1 / 1.4, timeline.scroller.clientWidth / 2));
$('projectName').addEventListener('change', (e) => {
  app.project.name = e.target.value.trim() || 'Untitled song';
  e.target.value = app.project.name;
  app.saveSoon();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? app.redo() : app.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); app.redo(); return; }
  if (mod && k === 'c') { e.preventDefault(); copyClip(); return; }
  if (mod && k === 'v') { e.preventDefault(); pasteClip(); return; }
  if (mod && k === 'd') { e.preventDefault(); doRepeat({ times: 2 }); return; }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (selectedClip()) deleteClip();
    else { const tr = app.project.tracks.find(t => t.id === app.selectedTrackId); if (tr) deleteLayer(tr); }
    return;
  }
  if (k === 'v') { setTool('move'); return; }
  if (k === 'n') { addLayer(); return; }
  if (k === 't') { $('actTune').click(); return; }
  if (k === 'c') { setTool('cut'); return; }
  if (e.key === 'Escape') { app.selectClip(app.selectedTrackId, null); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleRecord(); }
  else if (e.key === 'Home') { app.seek(0); timeline.scroller.scrollLeft = 0; }
  else if (e.key === 'l' || e.key === 'L') $('btnLoop').click();
});

// mic level meter
app.engine.onLevel = (peak) => {
  const db = 20 * Math.log10(Math.max(peak, 1e-5));
  const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
  $('meterFill').style.height = pct + '%';
};

// ---------- edit tools ----------
function selectedClip() {
  if (!app.selectedClipId) return null;
  return findClip(app.project, app.selectedClipId);
}

/** Everything that has to happen after any edit or undo/redo. */
function afterEdit(fromHistory = false) {
  const p = app.project;
  if (app.selectedClipId && !findClip(p, app.selectedClipId)) app.selectedClipId = null;
  if (app.selectedTrackId && !p.tracks.some(t => t.id === app.selectedTrackId)) app.selectedTrackId = null;
  if (fromHistory && dlgTrack) $('trackDialog').close();
  renderHeaders();
  timeline.selectedTrackId = app.selectedTrackId;
  document.querySelectorAll('.track-header').forEach(el => el.classList.toggle('selected', el.dataset.id === app.selectedTrackId));
  renderToolbar();
  timeline.invalidate();
  app.saveSoon();
  tuneEditor.onEdit();
  for (const t of p.tracks) if (t.autotune.enabled) ensureTunedSoon(t);
  restartIfPlaying();
}

function renderToolbar() {
  if (!app.project) return;
  const busy = app.recording;
  document.querySelectorAll('#toolbar [data-tool]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === app.tool));
  });
  const sel = !!selectedClip();
  $('actCopy').disabled = busy || !sel;
  $('actRepeat').disabled = busy || !sel;
  $('actDelete').disabled = busy || !sel;
  const selTr = app.project.tracks.find(t => t.id === app.selectedTrackId);
  $('actTune').disabled = busy || !selTr || !selTr.clips.length || selTr.isReference;
  $('actPaste').disabled = busy || !app.clipboard;
  $('actUndo').disabled = busy || !app.undoStack.length;
  $('actRedo').disabled = busy || !app.redoStack.length;
}

function setTool(t) {
  app.tool = t;
  timeline.hover = null;
  renderToolbar();
  timeline.invalidate();
  if (t === 'cut') toast('Scissors: tap a clip where you want to cut it.', false, 2500);
}

function copyClip() {
  const f = selectedClip();
  if (!f) return;
  app.clipboard = { clip: { ...f.clip }, trackId: f.track.id };
  renderToolbar();
  toast('Copied. Move the playhead and press Paste.', false, 2500);
}

function pasteClip() {
  const cb = app.clipboard;
  if (!cb || app.recording) return;
  if (app.engine.isRunning) app.engine.stop();
  const p = app.project;
  const before = app.snapshot();
  let dest = p.tracks.find(t => t.id === app.selectedTrackId) || p.tracks.find(t => t.id === cb.trackId);
  if (!dest) { dest = makeTrack({ name: nextLayerName() }); p.tracks.push(dest); }
  const start = app.project.snap ? timeline.snapTime(app.playhead) : app.playhead;
  const clip = { ...cb.clip, id: uid(), offset: start - cb.clip.trimStart };
  placeClip(dest, clip, uid);
  app.selectedClipId = clip.id;
  app.selectedTrackId = dest.id;
  ensureTuned(dest);
  // playhead jumps to the end of the paste, so pressing Paste again lines the next copy up behind it
  app.seek(clipEnd(clip));
  timeline.scrollToTime(app.playhead);
  app.commit(before);
}

function deleteClip() {
  const f = selectedClip();
  if (!f || app.recording) return;
  const before = app.snapshot();
  f.track.clips = f.track.clips.filter(c => c !== f.clip);
  app.selectedClipId = null;
  app.commit(before);
}

function doRepeat(opts) {
  const f = selectedClip();
  if (!f) return;
  if (app.engine.isRunning) app.engine.stop();
  const before = app.snapshot();
  const added = repeatClip(f.track, f.clip, opts, uid);
  if (!added.length) { toast('Nothing to add there.'); return; }
  app.selectedClipId = f.clip.id;
  app.commit(before);
  $('repeatDialog').close();
  toast(`Added ${added.length} cop${added.length === 1 ? 'y' : 'ies'}.`);
}

let fillBar = 8;
function openRepeat() {
  const f = selectedClip();
  if (!f) return;
  const p = app.project, barDur = 60 / p.bpm * p.beatsPerBar;
  const len = clipLen(f.clip);
  const bars = len / barDur;
  $('repeatInfo').textContent = `This clip is ${Math.abs(bars - Math.round(bars)) < 0.02 ? Math.round(bars) + ' bar' + (Math.round(bars) === 1 ? '' : 's') : len.toFixed(2) + ' s'} long.`;
  // sensible default: end of the loop, else end of the song, else 8 bars on
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  const clipEndBar = Math.ceil(clipEnd(f.clip) / barDur - 1e-6);
  fillBar = p.loop.enabled ? p.loop.endBar - 1 : Math.max(clipEndBar + 1, Math.ceil(end / barDur - 1e-6), clipEndBar + 7);
  $('fillBar').textContent = fillBar;
  $('repeatDialog').showModal();
}
document.querySelectorAll('#repeatDialog [data-times]').forEach(b => b.addEventListener('click', () => doRepeat({ times: +b.dataset.times })));
document.querySelectorAll('#repeatDialog [data-fill-step]').forEach(b => b.addEventListener('click', () => {
  fillBar = Math.max(1, fillBar + +b.dataset.fillStep); $('fillBar').textContent = fillBar;
}));
$('btnFill').addEventListener('click', () => {
  const p = app.project, barDur = 60 / p.bpm * p.beatsPerBar;
  doRepeat({ until: fillBar * barDur });
});

document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('actCopy').addEventListener('click', copyClip);
$('actPaste').addEventListener('click', pasteClip);
$('actRepeat').addEventListener('click', openRepeat);
$('actTune').addEventListener('click', () => openTuneEditor(app.project.tracks.find(t => t.id === app.selectedTrackId)));
$('actDelete').addEventListener('click', deleteClip);
$('actUndo').addEventListener('click', () => app.undo());
$('actRedo').addEventListener('click', () => app.redo());

// ---------- loop dialog (bar steppers) ----------
function loopDialogOpen() { return $('loopDialog').open; }
function syncLoopDialog() {
  const l = app.project.loop;
  $('loopOn').checked = l.enabled;
  $('loopFrom').textContent = l.startBar;
  $('loopTo').textContent = l.endBar - 1;
  const n = l.endBar - l.startBar;
  $('loopLen').textContent = `${n} bar${n === 1 ? '' : 's'}`;
}
$('loopLabel').addEventListener('click', () => { if (app.recording) return; syncLoopDialog(); $('loopDialog').showModal(); });
$('loopOn').addEventListener('change', (e) => {
  app.project.loop.enabled = e.target.checked;
  renderTransport(); timeline.invalidate(); app.loopChanged();
});
document.querySelectorAll('#loopDialog [data-step]').forEach(b => b.addEventListener('click', () => {
  const l = app.project.loop, d = +b.dataset.d;
  let s = l.startBar, en = l.endBar;
  if (b.dataset.step === 'start') s = Math.max(1, Math.min(en - 1, s + d));
  else en = Math.max(s + 1, en + d);
  app.setLoop(s, en, true);
  app.loopChanged();
}));
document.querySelectorAll('#loopDialog [data-len]').forEach(b => b.addEventListener('click', () => {
  const p = app.project, barDur = 60 / p.bpm * p.beatsPerBar;
  const start = Math.floor(app.playhead / barDur + 1e-6) + 1;
  app.setLoop(start, start + +b.dataset.len, true);
  app.loopChanged();
}));

// ---------- splitter: resize the layers window by folding the controls ----------
(() => {
  const fold = $('controlsFold'), handle = $('splitter');
  const KEY = 'overdub.fold';
  const natural = () => fold.scrollHeight;
  let open = 1; // 0 = controls folded away (biggest layers window), 1 = all controls showing
  try { const v = parseFloat(localStorage.getItem(KEY)); if (v >= 0 && v <= 1) open = v; } catch { /* */ }
  const apply = () => {
    // fully open = no cap at all, so late-loading fonts can't clip the last row
    fold.style.maxHeight = open >= 0.999 ? 'none' : Math.round(natural() * open) + 'px';
    fold.style.marginTop = open < 0.05 ? '0px' : '';
    fold.inert = open < 0.05;
    timeline.invalidate();
  };
  const save = () => { try { localStorage.setItem(KEY, String(open)); } catch { /* */ } };
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    if (fold.style.maxHeight === 'none') fold.style.maxHeight = natural() + 'px';
    drag = { y: e.clientY, open0: open, moved: false };
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    open = Math.max(0, Math.min(1, drag.open0 + dy / Math.max(40, natural())));
    apply();
  });
  const end = () => {
    if (!drag) return;
    handle.classList.remove('dragging');
    fold.classList.add('folding');
    if (fold.style.maxHeight === 'none') { fold.style.maxHeight = natural() + 'px'; void fold.offsetHeight; }
    if (!drag.moved) open = open > 0.5 ? 0 : 1;      // tap = fold / unfold
    else {
      // settle on a whole row of controls, never half a row
      const cur = natural() * open;
      const stops = new Set([0, natural()]);
      for (const c of fold.children) stops.add(Math.round(c.offsetTop + c.offsetHeight + 6));
      let best = 0;
      for (const st of stops) if (Math.abs(st - cur) < Math.abs(best - cur)) best = st;
      open = Math.min(1, best / natural());
    }
    apply(); save();
    setTimeout(() => { fold.classList.remove('folding'); apply(); }, 250);
    drag = null;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  window.addEventListener('resize', apply);
  requestAnimationFrame(apply);
})();

// ---------- track dialog ----------
let dlgTrack = null;
const keySel = $('atKey');
NOTE_NAMES.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; keySel.appendChild(o); });


function openTrackDialog(tr) {
  dlgTrack = tr;
  $('tdName').value = tr.name;
  $('tdVolume').value = tr.volume; $('tdPan').value = tr.pan; $('tdReverb').value = tr.reverb;
  $('tdRefRow').hidden = !tr.isReference;
  $('tdIncludeExport').checked = !!tr.includeInExport;
  nudgeBase = null;
  syncMixUI();
  $('tdNudge').value = 0; $('tdNudgeOut').textContent = '0 ms'; $('tdNudgeLearn').hidden = true;
  $('tdAutotune').hidden = tr.isReference;
  const a = tr.autotune;
  $('atEnabled').checked = a.enabled;
  $('atKey').value = a.key; $('atScale').value = a.scale; $('atSpeed').value = a.speed; $('atAmount').value = a.amount;
  syncTrackOutputs();
  updateAtStatus();
  $('trackDialog').showModal();
}

function syncTrackOutputs() {
  const tr = dlgTrack;
  $('tdVolumeOut').textContent = Math.round(tr.volume * 100) + '%';
  $('tdPanOut').textContent = Math.abs(tr.pan) < 0.02 ? 'C' : (tr.pan < 0 ? 'L' : 'R') + Math.round(Math.abs(tr.pan) * 100);
  $('tdReverbOut').textContent = Math.round(tr.reverb * 100) + '%';
  $('atAmountOut').textContent = tr.autotune.amount + '%';
}

function updateAtStatus() {
  const tr = dlgTrack;
  if (!tr) return;
  const a = tr.autotune;
  const busy = tuning.busy(tr.id);
  let s;
  if (!tr.clips.length) s = 'Record something on this layer first.';
  else if (busy) s = 'Updating the tuned sound…';
  else if (!a.enabled) s = 'Off: you hear the original.';
  else if (tuning.stale(tr).length) s = 'Will update in a moment…';
  else s = 'On.';
  $('atStatus').textContent = s;
}

$('tdName').addEventListener('change', (e) => {
  dlgTrack.name = e.target.value.trim() || dlgTrack.name;
  renderHeaders(); app.saveSoon();
});
for (const [id, key] of [['tdVolume', 'volume'], ['tdPan', 'pan'], ['tdReverb', 'reverb']]) {
  $(id).addEventListener('input', (e) => {
    dlgTrack[key] = +e.target.value;
    syncTrackOutputs();
    mixChanged();
    if (key === 'volume') renderHeaders();
  });
}
// ---------- sound (EQ / compressor) ----------
const MIX_FIELDS = [
  ['mxLowCut', 'lowCut', (v) => v <= 20 ? 'off' : v + ' Hz'],
  ['mxWarmth', 'warmth', (v) => (v > 0 ? '+' : '') + v + ' dB'],
  ['mxPresence', 'presence', (v) => (v > 0 ? '+' : '') + v + ' dB'],
  ['mxAir', 'air', (v) => (v > 0 ? '+' : '') + v + ' dB'],
  ['mxTameS', 'tameS', (v) => v ? '−' + v + ' dB' : 'off'],
  ['mxComp', 'comp', (v) => Math.round(v * 100) + '%'],
];
function syncMixUI() {
  const tr = dlgTrack;
  const m = { ...MIX_DEFAULT, ...(tr.mix || {}) };
  for (const [id, key, fmt] of MIX_FIELDS) { $(id).value = m[key]; $(id + 'Out').textContent = fmt(m[key]); }
  document.querySelectorAll('#mixPresets [data-preset]').forEach(b => {
    const pr = MIX_PRESETS[b.dataset.preset];
    b.classList.toggle('on', Object.keys(pr).every(k => pr[k] === m[k]));
  });
}
for (const [id, key] of MIX_FIELDS) {
  $(id).addEventListener('input', (e) => {
    const tr = dlgTrack;
    tr.mix = { ...MIX_DEFAULT, ...(tr.mix || {}), [key]: +e.target.value };
    syncMixUI(); mixChanged();
  });
}
document.querySelectorAll('#mixPresets [data-preset]').forEach(b => b.addEventListener('click', () => {
  dlgTrack.mix = { ...MIX_PRESETS[b.dataset.preset] };
  syncMixUI(); mixChanged();
}));

// Timing: slide the whole layer earlier/later by ear. Can teach the earphones' delay too.
let nudgeBase = null; // { before snapshot, offsets }
$('tdNudge').addEventListener('input', (e) => {
  const tr = dlgTrack;
  if (!nudgeBase) nudgeBase = { before: app.snapshot(), offsets: tr.clips.map(c => c.offset), startMs: 0 };
  const ms = +e.target.value;
  tr.clips.forEach((c, i) => { c.offset = nudgeBase.offsets[i] + (ms - nudgeBase.startMs) / 1000; });
  $('tdNudgeOut').textContent = (ms > 0 ? '+' : '') + ms + ' ms';
  const rec = tr.clips.map(c => c.rec).find(Boolean);
  $('tdNudgeLearn').hidden = !rec || ms === 0;
  if (rec) $('tdNudgeText').textContent = ms < 0 ? `Was late with ${rec.mic}?` : `Was early with ${rec.mic}?`;
  timeline.invalidate();
});
$('tdNudge').addEventListener('change', () => {
  if (!nudgeBase) return;
  const before = nudgeBase.before;
  nudgeBase = { before: app.snapshot(), offsets: dlgTrack.clips.map(c => c.offset), startMs: +$('tdNudge').value };
  app.commit(before);
});
$('tdNudgeSave').addEventListener('click', () => {
  const tr = dlgTrack;
  const rec = tr.clips.map(c => c.rec).find(Boolean);
  if (!rec) return;
  const ms = +$('tdNudge').value;
  // moved earlier by 40 ms => the earphones are 40 ms slower than we assumed
  const next = Math.max(0, Math.round(rec.latencyMs - ms));
  app.settings.latByDevice[rec.mic] = next;
  saveSettings();
  $('tdNudgeLearn').hidden = true;
  toast(`Saved: ${rec.mic} now uses ${next} ms. Future takes will land there.`, false, 4500);
});
$('tdIncludeExport').addEventListener('change', (e) => { dlgTrack.includeInExport = e.target.checked; app.saveSoon(); });
$('atEnabled').addEventListener('change', (e) => {
  const tr = dlgTrack;
  tr.autotune.enabled = e.target.checked;
  ensureTuned(tr);
  restartIfPlaying();
  updateAtStatus(); renderHeaders(); timeline.invalidate(); app.saveSoon();
});
for (const [id, key] of [['atKey', 'key'], ['atScale', 'scale'], ['atSpeed', 'speed'], ['atAmount', 'amount']]) {
  $(id).addEventListener('input', (e) => {
    const tr = dlgTrack;
    tr.autotune[key] = key === 'scale' ? e.target.value : +e.target.value;
    syncTrackOutputs(); updateAtStatus(); app.saveSoon();
    ensureTunedSoon(tr);
  });
}
$('atApply').addEventListener('click', () => { const tr = dlgTrack; $('trackDialog').close(); openTuneEditor(tr); });

$('tdDelete').addEventListener('click', () => { const tr = dlgTrack; $('trackDialog').close(); deleteLayer(tr); });

function deleteLayer(tr) {
  if (app.recording) return;
  if (app.engine.isRunning) app.engine.stop();
  const before = app.snapshot();
  app.project.tracks = app.project.tracks.filter(t => t !== tr);
  if (app.selectedTrackId === tr.id) { app.selectedTrackId = null; app.selectedClipId = null; }
  app.commit(before);
  toast(`${tr.name} deleted.`, false, 6000, { label: 'Undo', fn: () => app.undo() });
}

function addLayer() {
  if (app.recording) return;
  const before = app.snapshot();
  const tr = makeTrack({ name: nextLayerName() });
  // add it right under the selected layer, or at the bottom
  const i = app.project.tracks.findIndex(t => t.id === app.selectedTrackId);
  if (i >= 0) app.project.tracks.splice(i + 1, 0, tr); else app.project.tracks.push(tr);
  app.selectedTrackId = tr.id;
  app.selectedClipId = null;
  app.commit(before);
  timeline.scrollToRow(app.project.tracks.indexOf(tr));
  toast(`${tr.name} added. Press REC to record into it, or paste or drag a clip onto it.`, false, 4000);
}
$('btnAddLayer').addEventListener('click', addLayer);
$('tdDuplicate').addEventListener('click', () => {
  const tr = dlgTrack;
  const before = app.snapshot();
  const copy = structuredClone(tr);
  copy.id = uid();
  copy.name = tr.name + ' copy';
  copy.clips = copy.clips.map(c => ({ ...c, id: uid() }));
  const used = new Set(app.project.tracks.map(t => t.color));
  copy.color = COLORS.find(c => !used.has(c)) || tr.color;
  app.project.tracks.splice(app.project.tracks.indexOf(tr) + 1, 0, copy);
  $('trackDialog').close();
  app.selectedTrackId = copy.id; app.selectedClipId = null;
  app.commit(before);
  toast('Copied. Pan one left and one right for a wider sound.');
});

/** Remove stored audio no song uses any more (after deletes, re-tunes, undo history is gone). */
async function collectGarbage() {
  try {
    const used = new Set();
    for (const p of await db.listProjects()) referencedAudio(p, used);
    if (app.project) referencedAudio(app.project, used);
    for (const id of await db.listAudioIds()) {
      if (!used.has(id)) { await db.deleteAudio(id); app.engine.buffers.delete(id); timeline.peaks.delete(id); }
    }
  } catch { /* best effort */ }
}

// ---------- auto-tune (note based) ----------
const tuning = new Tuning({
  getProject: () => app.project, engine: app.engine, db, uid,
  onRendered: (tr) => {
    renderHeaders(); timeline.invalidate(); updateAtStatus();
    tuneEditor.onRendered(tr);
    app.saveSoon();
    if (tr.autotune.enabled) restartIfPlaying();
  },
});

/** Keep a layer's tuned sound current (background). */
function ensureTuned(tr) {
  if (!tr || !tr.autotune.enabled || !tr.clips.length || !tuning.stale(tr).length) return;
  updateAtStatus();
  tuning.render(tr).catch(e => toast('Auto-tune failed: ' + e.message, true));
}
const tuneTimers = new Map();
function ensureTunedSoon(tr, ms = 600) {
  clearTimeout(tuneTimers.get(tr.id));
  tuneTimers.set(tr.id, setTimeout(() => ensureTuned(tr), ms));
}

const tuneEditor = new TuneEditor({
  app, tuning, timeline,
  toast: (...a) => toast(...a),
  commit: (before) => app.commit(before),
  ensureTunedSoon: (tr) => ensureTunedSoon(tr, 450),
  play: () => togglePlay(),
  isPlaying: () => app.engine.isRunning,
});
function openTuneEditor(tr) {
  if (!tr) { toast('Select a layer first.'); return; }
  if (tr.isReference) { toast('Reference tracks can\u2019t be tuned.'); return; }
  if (!tr.clips.length) { toast('Record something on this layer first.'); return; }
  tuneEditor.open(tr);
}

// ---------- import reference ----------
$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('Importing ' + file.name + '…');
  try {
    const buf = await app.engine.decodeFile(await file.arrayBuffer());
    const channels = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) channels.push(buf.getChannelData(c).slice());
    const audio = { id: uid(), sampleRate: buf.sampleRate, channels };
    await db.saveAudio(audio);
    app.engine.setBufferFromRecord(audio);
    const before = app.snapshot();
    const tr = makeTrack({
      name: file.name.replace(/\.[^.]+$/, ''),
      clips: [{ id: uid(), audioId: audio.id, offset: 0, trimStart: 0, trimEnd: buf.duration }],
      isReference: true,
    });
    app.project.tracks.unshift(tr);
    app.selectedTrackId = tr.id; app.selectedClipId = null;
    app.commit(before);
    toast('Added as a reference. It stays out of exports unless you tick it.', false, 4500);
  } catch (err) {
    toast('Could not import that file: ' + (err.message || err), true, 6000);
  }
});

// ---------- export ----------
$('btnExport').addEventListener('click', () => {
  $('exportRefRow').hidden = !app.project.tracks.some(t => t.isReference);
  $('exportStatus').textContent = '';
  $('btnDoExport').disabled = false;
  $('exportDialog').showModal();
});
$('btnDoExport').addEventListener('click', async () => {
  const btn = $('btnDoExport');
  btn.disabled = true;
  $('exportStatus').textContent = 'Rendering…';
  try {
    const mix = await app.engine.renderMix(app.project, { includeReference: $('exportIncludeRef').checked });
    const blob = encodeWav(mix.channels, mix.sampleRate);
    const name = (app.project.name || 'song').replace(/[\\/:*?"<>|]+/g, '_') + '.wav';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('exportStatus').textContent = `Done: ${name} (${(blob.size / 1048576).toFixed(1)} MB, ${fmtTime(mix.channels[0].length / mix.sampleRate)}).`;
  } catch (e) {
    $('exportStatus').textContent = 'Export failed: ' + e.message;
  }
  btn.disabled = false;
});

// ---------- projects ----------
$('btnProjects').addEventListener('click', async () => { await app.saveNow(); await renderProjectList(); $('projectsDialog').showModal(); });
async function renderProjectList() {
  const list = (await db.listProjects()).sort((a, b) => b.updatedAt - a.updatedAt);
  const ul = $('projectList');
  ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    if (p.id === app.project.id) li.className = 'current';
    const layers = p.tracks.filter(t => !t.isReference).length;
    li.innerHTML = `<div class="pl-name"><strong>${escapeHtml(p.name)}</strong><span class="muted small">${layers} layer${layers === 1 ? '' : 's'} · ${p.bpm} BPM · ${new Date(p.updatedAt).toLocaleDateString()}</span></div>
      <button type="button" class="btn sm open">Open</button><button type="button" class="btn sm danger del" aria-label="Delete">Delete</button>`;
    li.querySelector('.open').addEventListener('click', async () => { $('projectsDialog').close(); await loadProject(migrateProject(p, uid)); });
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete the song “${p.name}” and all its recordings? This can’t be undone.`)) return;
      await db.deleteProject(p.id);
      if (p.id === app.project.id) {
        const rest = (await db.listProjects()).sort((a, b) => b.updatedAt - a.updatedAt);
        if (rest.length) await loadProject(rest[0]); else await createProject();
      }
      await collectGarbage();
      renderProjectList();
    });
    ul.appendChild(li);
  }
}
$('btnNewProject').addEventListener('click', async () => {
  await app.saveNow();
  $('projectsDialog').close();
  const p = await createProject();
  toast('New song. Name it at the top.');
  $('projectName').select();
  return p;
});

// ---------- settings ----------
async function openSettings(startSync = false) {
  const s = app.settings;
  $('monitor').checked = s.monitor;
  $('themeSel').value = s.theme || 'auto';
  $('calibResult').textContent = '';
  renderSync();
  await fillDevices();
  await fillStorageInfo();
  if (!$('settingsDialog').open) $('settingsDialog').showModal();
  if (startSync) $('btnSyncTest').scrollIntoView({ block: 'center' });
}
$('btnSettings').addEventListener('click', () => openSettings());

function renderSync() {
  const info = latencyInfo();
  $('latDevice').textContent = info.key;
  $('latValue').textContent = `${Math.round(info.sec * 1000)} ms ${info.measured ? '(measured)' : '(guess)'}`;
  $('latMs').value = Math.round(info.sec * 1000);
  const ul = $('latList');
  ul.innerHTML = '';
  for (const [k, v] of Object.entries(app.settings.latByDevice)) {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><span>${Math.round(v)} ms</span><button type="button" class="btn sm" aria-label="Forget">Forget</button>`;
    li.firstChild.textContent = k;
    li.querySelector('button').addEventListener('click', () => { delete app.settings.latByDevice[k]; saveSettings(); renderSync(); });
    ul.appendChild(li);
  }
}
async function fillDevices() {
  const sel = $('inputDevice');
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    sel.innerHTML = '<option value="">Default</option>';
    devs.forEach((d, i) => {
      if (!d.deviceId || d.deviceId === 'default') return;
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Microphone ${i + 1}`;
      sel.appendChild(o);
    });
    sel.value = app.settings.deviceId || '';
  } catch { /* ignore */ }
}
async function fillStorageInfo() {
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('storageInfo').textContent = est
      ? `Stored on this device only. Using ${(est.usage / 1048576).toFixed(1)} MB. ${persisted ? 'Protected from automatic clean-up.' : 'Add it to your home screen so the browser keeps your takes.'}`
      : 'Stored on this device only.';
  } catch { /* ignore */ }
}
$('inputDevice').addEventListener('change', async (e) => {
  app.settings.deviceId = e.target.value; saveSettings();
  if (!app.recording) app.engine.disableMic();
  toast('That microphone will be used for the next take.');
});
$('themeSel').addEventListener('change', (e) => { app.settings.theme = e.target.value; saveSettings(); applyTheme(e.target.value); });
$('lcdTempoBtn').addEventListener('click', () => { $('bpm').focus(); $('bpm').select(); });
$('lcdSigBtn').addEventListener('click', () => { $('timeSig').focus(); if ($('timeSig').showPicker) try { $('timeSig').showPicker(); } catch { /* */ } });
$('monitor').addEventListener('change', (e) => { app.settings.monitor = e.target.checked; app.engine.setMonitor(e.target.checked); saveSettings(); });
$('latMs').addEventListener('change', (e) => {
  app.settings.latByDevice[latencyInfo().key] = Math.max(0, Math.min(1000, +e.target.value || 0));
  saveSettings(); renderSync();
});
$('btnLatReset').addEventListener('click', () => {
  delete app.settings.latByDevice[latencyInfo().key];
  app.settings.latAuto = true;
  saveSettings(); renderSync();
});
$('btnSyncTest').addEventListener('click', async () => {
  const out = $('calibResult'), btn = $('btnSyncTest');
  btn.disabled = true;
  try {
    await openMic();
    rememberMic();
    const wasMonitor = app.engine.monitorEnabled;
    app.engine.setMonitor(false);
    out.textContent = 'Get ready…';
    const sec = await app.engine.calibrateTapAlong({
      onBeat: (i, lead, total) => {
        out.textContent = i < lead ? `Count-in ${lead - i}…` : `Clap! ${i - lead + 1} / ${total - lead}`;
      },
    });
    app.engine.setMonitor(wasMonitor);
    const key = latencyInfo().key;
    app.settings.latByDevice[key] = Math.round(sec * 1000);
    saveSettings(); renderSync();
    out.textContent = `Done: ${Math.round(sec * 1000)} ms for ${key}. New takes with these earphones will land on the beat.`;
  } catch (e) {
    out.textContent = e.message;
  } finally {
    if (!app.recording) app.engine.disableMic();
    btn.disabled = false;
  }
});
$('btnCalibrate').addEventListener('click', async () => {
  const out = $('calibResult');
  out.textContent = 'Listening… stay quiet.';
  $('btnCalibrate').disabled = true;
  try {
    await openMic();
    rememberMic();
    const wasMonitor = app.engine.monitorEnabled;
    app.engine.setMonitor(false);
    const sec = await app.engine.calibrateLatency();
    app.engine.setMonitor(wasMonitor);
    app.settings.latByDevice[latencyInfo().key] = Math.round(sec * 1000);
    saveSettings(); renderSync();
    out.textContent = `Measured ${Math.round(sec * 1000)} ms through the speaker.`;
  } catch (e) {
    out.textContent = e.message;
  } finally {
    if (!app.recording) app.engine.disableMic();
  }
  $('btnCalibrate').disabled = false;
});

// close dialogs when tapping the backdrop
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}
$('trackDialog').addEventListener('close', () => { dlgTrack = null; });

// ---------- boot ----------
async function boot() {
  requestPersistence();
  applyTheme(app.settings.theme);
  onThemeChange(() => { renderHeaders(); timeline.invalidate(); });
  let p = null;
  try {
    const last = localStorage.getItem(LAST_PROJECT_KEY);
    if (last) p = await db.getProject(last);
    if (!p) {
      const all = await db.listProjects();
      if (all.length) p = all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }
  } catch { /* ignore */ }
  if (p) await loadProject(p); else await createProject();
  collectGarbage();
  app.engine.setMonitor(app.settings.monitor);
  requestAnimationFrame(frame);
  window.addEventListener('pagehide', () => app.saveNow());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    // going to the background: finish any take and let go of the mic,
    // otherwise the phone can cut it off and the next take would be silent
    if (app.recording) stopTransport();
    else app.engine.disableMic();
    app.saveNow();
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();

// for debugging and tests
app.render = renderAll;
window.__app = app;
window.__tl = timeline;
window.__loadProject = loadProject;
window.__te = tuneEditor;
