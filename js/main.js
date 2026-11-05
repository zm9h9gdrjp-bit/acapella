import { AudioEngine } from './audio-engine.js';
import { Timeline } from './timeline.js';
import { db, uid, requestPersistence } from './storage.js';
import { encodeWav } from './wav.js';
import { NOTE_NAMES } from './autotune.js';
import { displayColor, applyTheme, onThemeChange } from './theme.js';

const $ = (id) => document.getElementById(id);
// marker-ink colours, picked by hand to sit on cream paper
const COLORS = ['#2f5d8a', '#b8452b', '#3f7a4f', '#7d4f93', '#b07d12', '#1f7373', '#8a3a2c', '#5b6b2e', '#9b4a72', '#44546a'];
const SETTINGS_KEY = 'acapella.settings';
const LAST_PROJECT_KEY = 'acapella.lastProject';

// ---------- device settings (per device, not per song) ----------
function loadSettings() {
  const def = { latAuto: true, latMs: 30, deviceId: '', monitor: false, theme: 'auto' };
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
  settings: loadSettings(),
  saveTimer: null,

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
function toast(msg, isError = false, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- project loading ----------
async function loadProject(p) {
  if (app.engine.isRunning) app.engine.stop();
  app.project = p;
  app.playhead = 0;
  app.selectedTrackId = null;
  timeline.peaks.clear();
  try { localStorage.setItem(LAST_PROJECT_KEY, p.id); } catch { /* */ }
  const ids = new Set();
  for (const tr of p.tracks) {
    ids.add(tr.clip.audioId);
    if (tr.autotune && tr.autotune.processedAudioId) ids.add(tr.autotune.processedAudioId);
  }
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
}

function renderHeaders() {
  const p = app.project;
  const wrap = $('trackHeaders');
  wrap.innerHTML = '';
  p.tracks.forEach((tr) => {
    const el = document.createElement('div');
    el.className = 'track-header' + (tr.id === app.selectedTrackId ? ' selected' : '');
    el.dataset.id = tr.id;
    const tuned = tr.autotune && tr.autotune.enabled && tr.autotune.processedAudioId;
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
        </div>
      </div>`;
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, input')) return;
      app.selectTrack(tr.id);
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
    wrap.appendChild(el);
  });
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
function latencySeconds() {
  return app.settings.latAuto ? app.engine.estimatedLatency() : (app.settings.latMs || 0) / 1000;
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
    await app.engine.enableMic(app.settings.deviceId || undefined);
  } catch (e) {
    toast(e.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
      : 'Could not open the microphone: ' + e.message, true, 6000);
    return;
  }
  const project = app.project;
  const projectId = project.id;
  const row = project.tracks.length;
  try {
    app.recording = true;
    await app.engine.play({
      project,
      from: app.playhead,
      record: true,
      latency: latencySeconds(),
      onEnded: onTransportEnded,
      onRecorded: (samples, info) => saveTake(projectId, samples, info),
    });
  } catch (e) {
    app.recording = false;
    toast('Audio error: ' + e.message, true);
    renderTransport();
    return;
  }
  const from = app.engine.transport.from;
  app.playStart = from;
  timeline.recording = { row, from, to: from, newRow: true };
  $('emptyState').hidden = true;
  renderTransport();
}

async function saveTake(projectId, samples, info) {
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
  const n = p.tracks.filter(t => !t.isReference).length + 1;
  const tr = makeTrack({
    name: `Layer ${n}`,
    clip: { audioId: audio.id, offset: info.startTl, trimStart, trimEnd },
  });
  p.tracks.push(tr);
  app.selectedTrackId = tr.id;
  renderHeaders();
  app.selectTrack(tr.id);
  timeline.scrollToRow(p.tracks.length - 1);
  await app.saveNow();
  toast(`${tr.name} saved.`);
}

function makeTrack({ name, clip, isReference = false }) {
  const used = new Set(app.project.tracks.map(t => t.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[app.project.tracks.length % COLORS.length];
  return {
    id: uid(), name, color,
    volume: isReference ? 0.7 : 1, pan: 0, reverb: isReference ? 0 : 0.2,
    mute: false, solo: false,
    isReference, includeInExport: false,
    clip,
    autotune: { enabled: false, key: 0, scale: 'major', speed: 60, amount: 100, processedAudioId: null, appliedParams: null },
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

function atParams(tr) {
  const a = tr.autotune;
  return { key: +a.key, scale: a.scale, speed: a.speed / 100, amount: a.amount / 100 };
}
function sameParams(a, b) { return a && b && a.key === b.key && a.scale === b.scale && a.speed === b.speed && a.amount === b.amount; }

function openTrackDialog(tr) {
  dlgTrack = tr;
  $('tdName').value = tr.name;
  $('tdVolume').value = tr.volume; $('tdPan').value = tr.pan; $('tdReverb').value = tr.reverb;
  $('tdRefRow').hidden = !tr.isReference;
  $('tdIncludeExport').checked = !!tr.includeInExport;
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
  const busy = atJobs.has(tr.id);
  $('atApply').disabled = busy;
  let s;
  if (busy) s = 'Working…';
  else if (!a.processedAudioId) s = 'Not applied yet.';
  else if (sameParams(a.appliedParams, atParams(tr))) s = a.enabled ? 'Applied and on.' : 'Applied, but switched off (you’re hearing the original).';
  else s = 'Settings changed. Press Apply to hear them.';
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
$('tdIncludeExport').addEventListener('change', (e) => { dlgTrack.includeInExport = e.target.checked; app.saveSoon(); });
$('atEnabled').addEventListener('change', (e) => {
  const tr = dlgTrack;
  tr.autotune.enabled = e.target.checked;
  if (e.target.checked && (!tr.autotune.processedAudioId || !sameParams(tr.autotune.appliedParams, atParams(tr)))) {
    applyAutotune(tr);
  }
  restartIfPlaying();
  updateAtStatus(); renderHeaders(); timeline.invalidate(); app.saveSoon();
});
for (const [id, key] of [['atKey', 'key'], ['atScale', 'scale'], ['atSpeed', 'speed'], ['atAmount', 'amount']]) {
  $(id).addEventListener('input', (e) => {
    dlgTrack.autotune[key] = key === 'scale' ? e.target.value : +e.target.value;
    syncTrackOutputs(); updateAtStatus(); app.saveSoon();
  });
}
$('atApply').addEventListener('click', () => applyAutotune(dlgTrack));

$('tdDelete').addEventListener('click', async () => {
  const tr = dlgTrack;
  if (!confirm(`Delete “${tr.name}”? This can’t be undone.`)) return;
  if (app.engine.isRunning) app.engine.stop();
  app.project.tracks = app.project.tracks.filter(t => t !== tr);
  await deleteAudioIfUnused(tr.clip.audioId);
  if (tr.autotune.processedAudioId) await deleteAudioIfUnused(tr.autotune.processedAudioId);
  $('trackDialog').close();
  renderHeaders(); await app.saveNow();
});
$('tdDuplicate').addEventListener('click', async () => {
  const tr = dlgTrack;
  const copy = structuredClone(tr);
  copy.id = uid();
  copy.name = tr.name + ' copy';
  const used = new Set(app.project.tracks.map(t => t.color));
  copy.color = COLORS.find(c => !used.has(c)) || tr.color;
  app.project.tracks.splice(app.project.tracks.indexOf(tr) + 1, 0, copy);
  $('trackDialog').close();
  renderHeaders(); app.selectTrack(copy.id); await app.saveNow();
  toast('Copied. Pan one left and one right for a wider sound.');
});

async function deleteAudioIfUnused(id) {
  if (!id) return;
  const projects = await db.listProjects();
  const live = [app.project, ...projects.filter(p => p.id !== app.project.id)];
  const used = live.some(p => p.tracks.some(t => t.clip.audioId === id || (t.autotune && t.autotune.processedAudioId === id)));
  if (!used) {
    await db.deleteAudio(id);
    app.engine.buffers.delete(id);
    timeline.peaks.delete(id);
  }
}

// ---------- auto-tune worker ----------
const atJobs = new Map();
let atWorker = null;
let atJobSeq = 0;
function getWorker() {
  if (!atWorker) {
    atWorker = new Worker(new URL('./autotune-worker.js', import.meta.url), { type: 'module' });
    atWorker.onmessage = (e) => {
      const m = e.data;
      for (const [trackId, job] of atJobs) {
        if (job.id !== m.id) continue;
        if (m.progress != null) {
          if (dlgTrack && dlgTrack.id === trackId) { $('atProgress').hidden = false; $('atProgress').value = m.progress; }
        } else if (m.error) {
          atJobs.delete(trackId); job.reject(new Error(m.error));
        } else if (m.done) {
          atJobs.delete(trackId); job.resolve(m.channels);
        }
      }
    };
  }
  return atWorker;
}

async function applyAutotune(tr) {
  if (atJobs.has(tr.id)) return;
  const raw = app.engine.buffers.get(tr.clip.audioId);
  if (!raw) { toast('Audio for this layer is missing.', true); return; }
  const params = atParams(tr);
  const channels = [];
  for (let c = 0; c < raw.numberOfChannels; c++) channels.push(raw.getChannelData(c).slice());
  const project = app.project;
  const job = { id: ++atJobSeq };
  const done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  atJobs.set(tr.id, job);
  updateAtStatus();
  $('atProgress').hidden = false; $('atProgress').value = 0;
  getWorker().postMessage({ id: job.id, channels, sampleRate: raw.sampleRate, params }, channels.map(c => c.buffer));
  try {
    const out = await done;
    const audio = { id: uid(), sampleRate: raw.sampleRate, channels: out };
    await db.saveAudio(audio);
    app.engine.setBufferFromRecord(audio);
    const old = tr.autotune.processedAudioId;
    tr.autotune.processedAudioId = audio.id;
    tr.autotune.appliedParams = params;
    tr.autotune.enabled = true;
    if (old) await deleteAudioIfUnused(old);
    if (app.project === project) {
      await app.saveNow();
      restartIfPlaying();
    } else {
      await db.saveProject(project);
    }
    toast(`${tr.name}: auto-tune done.`);
  } catch (e) {
    toast('Auto-tune failed: ' + e.message, true);
  } finally {
    if (dlgTrack === tr) { $('atProgress').hidden = true; $('atEnabled').checked = tr.autotune.enabled; updateAtStatus(); }
    renderHeaders();
    timeline.invalidate();
  }
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
    const tr = makeTrack({
      name: file.name.replace(/\.[^.]+$/, ''),
      clip: { audioId: audio.id, offset: 0, trimStart: 0, trimEnd: buf.duration },
      isReference: true,
    });
    app.project.tracks.unshift(tr);
    renderHeaders(); app.selectTrack(tr.id); await app.saveNow();
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
    li.querySelector('.open').addEventListener('click', async () => { $('projectsDialog').close(); await loadProject(p); });
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete the song “${p.name}” and all its recordings? This can’t be undone.`)) return;
      await db.deleteProject(p.id);
      for (const t of p.tracks) {
        await db.deleteAudio(t.clip.audioId);
        if (t.autotune && t.autotune.processedAudioId) await db.deleteAudio(t.autotune.processedAudioId);
      }
      if (p.id === app.project.id) {
        const rest = (await db.listProjects()).sort((a, b) => b.updatedAt - a.updatedAt);
        if (rest.length) await loadProject(rest[0]); else await createProject();
      }
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
$('btnSettings').addEventListener('click', async () => {
  const s = app.settings;
  $('monitor').checked = s.monitor;
  $('themeSel').value = s.theme || 'auto';
  $('latAuto').checked = s.latAuto;
  $('latMs').value = Math.round(s.latMs);
  $('latMs').disabled = s.latAuto;
  $('latEstimate').textContent = Math.round(app.engine.estimatedLatency() * 1000);
  $('calibResult').textContent = '';
  await fillDevices();
  await fillStorageInfo();
  $('settingsDialog').showModal();
});
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
  try { app.engine.disableMic(); await app.engine.enableMic(e.target.value || undefined); toast('Microphone switched.'); }
  catch (err) { toast('Could not open that microphone: ' + err.message, true); }
});
$('themeSel').addEventListener('change', (e) => { app.settings.theme = e.target.value; saveSettings(); applyTheme(e.target.value); });
$('lcdTempoBtn').addEventListener('click', () => { $('bpm').focus(); $('bpm').select(); });
$('lcdSigBtn').addEventListener('click', () => { $('timeSig').focus(); if ($('timeSig').showPicker) try { $('timeSig').showPicker(); } catch { /* */ } });
$('monitor').addEventListener('change', (e) => { app.settings.monitor = e.target.checked; app.engine.setMonitor(e.target.checked); saveSettings(); });
$('latAuto').addEventListener('change', (e) => { app.settings.latAuto = e.target.checked; $('latMs').disabled = e.target.checked; saveSettings(); });
$('latMs').addEventListener('change', (e) => { app.settings.latMs = Math.max(0, +e.target.value || 0); saveSettings(); });
$('btnCalibrate').addEventListener('click', async () => {
  const out = $('calibResult');
  out.textContent = 'Listening… stay quiet.';
  $('btnCalibrate').disabled = true;
  try {
    await app.engine.enableMic(app.settings.deviceId || undefined);
    const wasMonitor = app.engine.monitorEnabled;
    app.engine.setMonitor(false);
    const sec = await app.engine.calibrateLatency();
    app.engine.setMonitor(wasMonitor);
    app.settings.latAuto = false;
    app.settings.latMs = Math.round(sec * 1000);
    saveSettings();
    $('latAuto').checked = false; $('latMs').disabled = false; $('latMs').value = app.settings.latMs;
    out.textContent = `Measured ${app.settings.latMs} ms. New takes get moved by that much. Headphones back in.`;
  } catch (e) {
    out.textContent = e.message;
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
  app.engine.setMonitor(app.settings.monitor);
  requestAnimationFrame(frame);
  window.addEventListener('pagehide', () => app.saveNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden) app.saveNow(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();

// for debugging and tests
app.render = renderAll;
window.__app = app;
window.__tl = timeline;
