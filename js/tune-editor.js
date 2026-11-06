// Tune editor: a full-screen note grid for one layer.
//  - piano keys on the left, bars along the top (same time line as the main screen)
//  - every sung note is a block at the pitch it will come out at; the thin line is the pitch
//    you actually sang, the thick line is the tuned result
//  - drag a note up/down to change it, cut a note in two, copy one note's tuning onto others
import { NOTE_NAMES, SCALES, computeCorrection, noteParams, nearestScaleNote } from './autotune.js';
import { displayColor } from './theme.js';

const KEYS_W = 48;
const RULER_H = 26;
const FIELDS = ['amount', 'drift', 'vibrato', 'transition', 'fine'];
const $ = (id) => document.getElementById(id);
const noteName = (m) => { const r = Math.round(m); return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };

export class TuneEditor {
  constructor(hooks) {
    this.h = hooks;            // { app, tuning, timeline, toast, commit, ensureTunedSoon, play, isPlaying }
    this.track = null;
    this.sel = new Set();
    this.tool = 'select';
    this.multi = false;
    this.clip = null;          // copied tuning
    this.curves = new Map();   // audioId -> { sig, midi, out, fd }
    this.drag = null;
    this.pointers = new Map();
    this.dirty = true;
    this.canvas = $('teCanvas');
    this.dlg = $('tuneEditor');
    this.build();
  }

  get app() { return this.h.app; }
  get project() { return this.app.project; }

  // ---------------- setup ----------------
  build() {
    const key = $('teKey');
    NOTE_NAMES.forEach((n, i) => { const o = document.createElement('option'); o.value = i; o.textContent = n; key.appendChild(o); });
    $('teDone').addEventListener('click', () => this.close());
    this.dlg.addEventListener('close', () => { this.track = null; });
    this.dlg.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
    $('teKey').addEventListener('change', (e) => this.setLayer({ key: +e.target.value }));
    $('teScale').addEventListener('change', (e) => this.setLayer({ scale: e.target.value }));
    document.querySelectorAll('#tuneEditor [data-style]').forEach(b => b.addEventListener('click', () => this.setLayer({ speed: +b.dataset.style })));
    $('teAB').addEventListener('click', () => {
      const a = this.track.autotune;
      this.setLayer({ enabled: !a.enabled });
      this.h.toast(a.enabled ? 'Hearing the tuned version.' : 'Hearing the original.', false, 1800);
    });
    $('tePlay').addEventListener('click', () => { this.h.play(); setTimeout(() => this.syncHead(), 50); });
    document.querySelectorAll('#tuneEditor [data-te-tool]').forEach(b => b.addEventListener('click', () => { this.tool = b.dataset.teTool; this.syncHead(); }));
    $('teMulti').addEventListener('click', () => { this.multi = !this.multi; this.syncHead(); });
    $('teAll').addEventListener('click', () => { this.sel = new Set(this.entries().map(e => e.note.id)); this.afterSelect(); });
    $('teCopy').addEventListener('click', () => this.copyTuning());
    $('tePaste').addEventListener('click', () => this.pasteTuning());
    $('teReset').addEventListener('click', () => this.resetNotes());
    $('teUndo').addEventListener('click', () => this.app.undo());
    $('teRedo').addEventListener('click', () => this.app.redo());
    $('teZoomIn').addEventListener('click', () => this.zoom(1.4));
    $('teZoomOut').addEventListener('click', () => this.zoom(1 / 1.4));
    $('teNoteDown').addEventListener('click', () => this.stepNotes(-1));
    $('teNoteUp').addEventListener('click', () => this.stepNotes(1));

    // inspector sliders: one undo step per gesture
    const sliders = [['teAmount', 'amount', v => v / 100], ['teDrift', 'drift', v => v / 100], ['teVibrato', 'vibrato', v => v / 100],
      ['teTrans', 'transition', v => v], ['teFine', 'fine', v => v]];
    for (const [id, field, conv] of sliders) {
      const el = $(id);
      el.addEventListener('input', () => {
        if (!this.sel.size) return;
        if (!this.gesture) this.gesture = this.app.snapshot();
        for (const n of this.selectedNotes()) n[field] = conv(+el.value);
        this.changed(false);
      });
      el.addEventListener('change', () => { if (this.gesture) { const b = this.gesture; this.gesture = null; this.h.commit(b); } });
    }

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => { this.pointers.delete(e.pointerId); this.drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX); return; }
      this.scrollT = Math.max(-0.5, this.scrollT + (e.shiftKey ? e.deltaY : e.deltaX) / this.pps);
      if (!e.shiftKey) this.topMidi += e.deltaY / this.semi / 3 * (Math.abs(e.deltaY) > 40 ? 1 : 0.5);
      this.invalidate();
    }, { passive: false });
    window.addEventListener('resize', () => this.invalidate());
    document.addEventListener('keydown', (e) => {
      if (!this.track || e.target.closest('input, select')) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === 'c') { e.preventDefault(); e.stopImmediatePropagation(); this.copyTuning(); }
      else if (mod && k === 'v') { e.preventDefault(); e.stopImmediatePropagation(); this.pasteTuning(); }
      else if (mod && k === 'a') { e.preventDefault(); $('teAll').click(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.stepNotes(e.key === 'ArrowUp' ? 1 : -1); }
      else if (k === 'c' && !mod) this.tool = 'cut', this.syncHead();
      else if (k === 'v' && !mod) this.tool = 'select', this.syncHead();
      else if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); $('tePlay').click(); }
    }, true);
    const loop = () => {
      if (this.track) {
        const playing = this.h.isPlaying();
        if (playing !== this.wasPlaying) { this.wasPlaying = playing; this.syncHead(); this.dirty = true; }
        if (playing) { this.followPlayhead(); this.dirty = true; }
        if (this.dirty) this.draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------- open / close ----------------
  async open(track) {
    this.track = track;
    this.sel.clear();
    this.curves.clear();
    $('teName').textContent = track.name;
    this.syncHead();
    this.syncInspector();
    if (!this.dlg.open) this.dlg.showModal();
    this.status('Finding the notes…');
    try {
      const ids = [...new Set(track.clips.map(c => c.audioId))];
      for (let i = 0; i < ids.length; i++) {
        await this.h.tuning.ensureAnalysis(ids[i], (p) => this.status(`Finding the notes… ${Math.round((i + p) / ids.length * 100)}%`));
      }
    } catch (e) { this.h.toast('Could not read this layer: ' + e.message, true); }
    if (this.track !== track) return;
    // switching the editor on means you want to hear it
    if (!track.autotune.enabled) { track.autotune.enabled = true; this.app.saveSoon(); }
    this.h.ensureTunedSoon(track);
    this.fit();
    this.status('');
    this.syncHead();
    this.invalidate();
    if (!this.entries().length) this.h.toast('No sung notes found on this layer (too quiet, or only noise?).', false, 4000);
  }

  close() { if (this.dlg.open) this.dlg.close(); this.track = null; }

  // called by the app after any edit / undo / redo
  onEdit() {
    if (!this.track) return;
    const tr = this.project.tracks.find(t => t.id === this.track.id);
    if (!tr) { this.close(); return; }
    this.track = tr; // undo replaces objects
    const ids = new Set(this.entries().map(e => e.note.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
    this.curves.clear();
    this.syncHead();
    this.syncInspector();
    this.invalidate();
  }

  onRendered(tr) { if (this.track && tr.id === this.track.id) { this.status(''); this.syncHead(); } }

  status(t) { $('teStatus').textContent = t; $('teStatus').hidden = !t; }
  invalidate() { this.dirty = true; }

  // ---------------- data helpers ----------------
  notesOf(audioId) { const t = this.project.tuning && this.project.tuning[audioId]; return t ? t.notes : []; }

  /** Notes on this layer as they sit on the time line (one entry per clip they appear in). */
  entries() {
    const out = [];
    if (!this.track) return out;
    for (const c of this.track.clips) {
      const s = c.offset + c.trimStart, e = c.offset + c.trimEnd;
      for (const n of this.notesOf(c.audioId)) {
        const t0 = Math.max(s, c.offset + n.start), t1 = Math.min(e, c.offset + n.end);
        if (t1 - t0 > 0.005) out.push({ clip: c, note: n, audioId: c.audioId, t0, t1 });
      }
    }
    return out;
  }

  selectedNotes() {
    const seen = new Set(), out = [];
    for (const e of this.entries()) if (this.sel.has(e.note.id) && !seen.has(e.note.id)) { seen.add(e.note.id); out.push(e.note); }
    return out;
  }

  opts() { return this.h.tuning.opts(this.track); }
  params(n) { const o = this.opts(); return noteParams(n, o.defaults, o.key, o.scale); }
  /** Pitch the note's block sits at after tuning (centre moved toward target, plus fine). */
  shownPitch(n) { const p = this.params(n); return n.center + (p.target - n.center) * p.amount + p.fine / 100; }

  curveFor(audioId) {
    const an = this.h.tuning.analysis.get(audioId);
    if (!an) return null;
    const sig = this.h.tuning.sig(this.track, audioId);
    let c = this.curves.get(audioId);
    if (!c || c.sig !== sig) {
      const r = computeCorrection(an.f0, an.hop, an.sampleRate, this.notesOf(audioId), this.opts());
      c = { sig, midi: r.midi, out: r.out, fd: an.hop / an.sampleRate };
      this.curves.set(audioId, c);
    }
    return c;
  }

  // ---------------- view ----------------
  get semi() { return this.semiPx || 18; }
  x(t) { return KEYS_W + (t - this.scrollT) * this.pps; }
  tAt(x) { return (x - KEYS_W) / this.pps + this.scrollT; }
  y(m) { return RULER_H + (this.topMidi - m) * this.semi; }
  mAt(y) { return this.topMidi - (y - RULER_H) / this.semi; }

  fit() {
    const ents = this.entries();
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 400;
    if (!ents.length) { this.scrollT = 0; this.pps = 80; this.topMidi = 72; this.semiPx = 18; return; }
    let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
    for (const e of ents) { t0 = Math.min(t0, e.t0); t1 = Math.max(t1, e.t1); lo = Math.min(lo, e.note.center); hi = Math.max(hi, e.note.center); }
    // start near the playhead if it is inside the layer, otherwise at the first note
    const ph = this.app.playhead;
    const start = ph > t0 && ph < t1 ? ph - 0.3 : t0 - 0.3;
    this.pps = Math.max(40, Math.min(260, (w - KEYS_W) / Math.min(8, t1 - t0 + 0.6)));
    this.scrollT = start;
    const range = Math.max(10, hi - lo + 6);
    this.semiPx = Math.max(13, Math.min(26, (h - RULER_H) / range));
    this.topMidi = (hi + lo) / 2 + (h - RULER_H) / this.semiPx / 2;
  }

  zoom(f, anchorX) {
    const ax = anchorX ?? (KEYS_W + (this.canvas.clientWidth - KEYS_W) / 2);
    const t = this.tAt(ax);
    this.pps = Math.max(15, Math.min(1200, this.pps * f));
    this.scrollT = t - (ax - KEYS_W) / this.pps;
    this.invalidate();
  }

  followPlayhead() {
    const x = this.x(this.app.playhead), w = this.canvas.clientWidth;
    if (x < KEYS_W || x > w * 0.85) this.scrollT = this.app.playhead - (w - KEYS_W) * 0.15 / this.pps;
  }

  syncHead() {
    if (!this.track) return;
    const a = this.track.autotune;
    $('teKey').value = a.key; $('teScale').value = a.scale;
    document.querySelectorAll('#tuneEditor [data-style]').forEach(b => b.classList.toggle('on', +b.dataset.style === +a.speed));
    $('teAB').setAttribute('aria-pressed', String(!!a.enabled));
    $('teABLabel').textContent = a.enabled ? 'Tuned' : 'Original';
    $('tePlay').classList.toggle('playing', this.h.isPlaying());
    $('tePlayLabel').textContent = this.h.isPlaying() ? 'Stop' : 'Play';
    document.querySelectorAll('#tuneEditor [data-te-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.teTool === this.tool)));
    $('teMulti').setAttribute('aria-pressed', String(this.multi));
    const has = this.sel.size > 0;
    $('teCopy').disabled = !has; $('teReset').disabled = !has;
    $('tePaste').disabled = !has || !this.clip;
    $('teUndo').disabled = !this.app.undoStack.length; $('teRedo').disabled = !this.app.redoStack.length;
    if (this.h.tuning.busy(this.track.id)) this.status('Updating the sound…');
    else if ($('teStatus').textContent.startsWith('Updating')) this.status('');
  }

  syncInspector() {
    const notes = this.selectedNotes();
    const insp = $('teInspector');
    insp.classList.toggle('no-sel', !notes.length);
    const set = (id, v, out) => { $(id).value = v; $(id + 'Out').textContent = out; };
    if (!notes.length) {
      $('teNote').textContent = '–';
      $('teSelInfo').textContent = 'Tap a note to tune it. Drag it up or down to change the note.';
      return;
    }
    const p = this.params(notes[0]);
    $('teNote').textContent = noteName(p.target) + (notes.length > 1 ? ` +${notes.length - 1}` : '');
    $('teSelInfo').textContent = notes.length > 1 ? `${notes.length} notes selected. Changes apply to all of them.` :
      `Sung at ${noteName(notes[0].center)} ${fmtCents((notes[0].center - Math.round(notes[0].center)) * 100)}`;
    set('teAmount', Math.round(p.amount * 100), Math.round(p.amount * 100) + '%');
    set('teDrift', Math.round(p.drift * 100), Math.round(p.drift * 100) + '%');
    set('teVibrato', Math.round(p.vibrato * 100), Math.round(p.vibrato * 100) + '%');
    set('teTrans', Math.round(p.transition), Math.round(p.transition) + ' ms');
    set('teFine', Math.round(p.fine), fmtCents(p.fine));
  }

  afterSelect() { this.syncHead(); this.syncInspector(); this.invalidate(); }

  /** A change to notes/settings: redraw now; record undo if `before` given; refresh the sound soon. */
  changed(commitNow = true, before = null) {
    this.curves.clear();
    this.syncInspector();
    this.invalidate();
    if (commitNow && before) this.h.commit(before);
    this.h.ensureTunedSoon(this.track);
    this.syncHead();
  }

  // ---------------- edits ----------------
  setLayer(patch) {
    const before = this.app.snapshot();
    Object.assign(this.track.autotune, patch);
    this.h.commit(before);
    this.changed(false);
  }

  scaleStep(m, dir) {
    const a = this.track.autotune;
    const deg = SCALES[a.scale] || SCALES.chromatic;
    let n = Math.round(m) + dir;
    for (let i = 0; i < 12 && !deg.includes((((n - a.key) % 12) + 12) % 12); i++) n += dir;
    return n;
  }

  stepNotes(dir) {
    const notes = this.selectedNotes();
    if (!notes.length) return;
    const before = this.app.snapshot();
    for (const n of notes) n.target = this.scaleStep(this.params(n).target, dir);
    this.changed(true, before);
  }

  copyTuning() {
    const n = this.selectedNotes()[0];
    if (!n) return;
    const p = this.params(n);
    this.clip = Object.fromEntries(FIELDS.map(f => [f, p[f]]));
    this.syncHead();
    this.h.toast('Tuning copied. Select other notes and press Paste.', false, 2500);
  }

  pasteTuning() {
    if (!this.clip || !this.sel.size) return;
    const before = this.app.snapshot();
    for (const n of this.selectedNotes()) Object.assign(n, this.clip);
    this.changed(true, before);
  }

  resetNotes() {
    const notes = this.selectedNotes();
    if (!notes.length) return;
    const before = this.app.snapshot();
    for (const n of notes) { delete n.target; for (const f of FIELDS) delete n[f]; }
    this.changed(true, before);
  }

  splitAt(entry, t) {
    const n = entry.note, at = t - entry.clip.offset; // seconds into the take
    if (at <= n.start + 0.04 || at >= n.end - 0.04) return;
    const before = this.app.snapshot();
    const notes = this.notesOf(entry.audioId);
    const right = { ...n, id: this.app.newId(), start: at };
    n.end = at;
    const an = this.h.tuning.analysis.get(entry.audioId);
    if (an) { n.center = centerOf(an, n.start, n.end) ?? n.center; right.center = centerOf(an, right.start, right.end) ?? right.center; }
    notes.splice(notes.indexOf(n) + 1, 0, right);
    this.sel = new Set([right.id]);
    this.changed(true, before);
  }

  // ---------------- pointer ----------------
  hit(x, y) {
    let best = null, bestD = Infinity;
    for (const e of this.entries()) {
      const x0 = this.x(e.t0), x1 = this.x(e.t1);
      if (x < x0 - 2 || x > x1 + 2) continue;
      const d = Math.abs(y - this.y(this.shownPitch(e.note)));
      if (d < this.semi * 0.75 && d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  onDown(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x, y });
    if (this.pointers.size === 2) { // pinch to zoom time
      const [a, b] = [...this.pointers.values()];
      this.drag = { type: 'pinch', d0: Math.abs(a.x - b.x) || 1, pps0: this.pps, mid: (a.x + b.x) / 2 };
      return;
    }
    if (y < RULER_H) { this.drag = { type: 'seek', x, y, moved: false }; return; }
    const hit = x > KEYS_W ? this.hit(x, y) : null;
    if (hit && this.tool === 'select') {
      const id = hit.note.id;
      if (this.multi) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); }
      else if (!this.sel.has(id)) this.sel = new Set([id]);
      this.afterSelect();
      const orig = new Map(this.selectedNotes().map(n => [n.id, this.params(n).target]));
      this.drag = { type: 'note', x, y, moved: false, orig, before: this.app.snapshot(), steps: 0 };
      return;
    }
    this.drag = { type: hit && this.tool === 'cut' ? 'cut' : 'pan', hit, x, y, moved: false, t0: this.scrollT, m0: this.topMidi };
  }

  onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
    const d = this.drag;
    if (!d) {
      this.canvas.style.cursor = y < RULER_H ? 'pointer' : (this.hit(x, y) ? (this.tool === 'cut' ? 'crosshair' : 'ns-resize') : 'grab');
      return;
    }
    if (d.type === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const t = this.tAt(d.mid);
      this.pps = Math.max(15, Math.min(1200, d.pps0 * Math.abs(a.x - b.x) / d.d0));
      this.scrollT = t - (d.mid - KEYS_W) / this.pps;
      this.invalidate();
      return;
    }
    if (Math.abs(x - d.x) > 4 || Math.abs(y - d.y) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.type === 'pan') {
      this.scrollT = d.t0 - (x - d.x) / this.pps;
      this.topMidi = d.m0 + (y - d.y) / this.semi;
      this.invalidate();
    } else if (d.type === 'note') {
      const steps = Math.round(-(y - d.y) / this.semi);
      if (steps === d.steps) return;
      d.steps = steps;
      const a = this.track.autotune;
      for (const n of this.selectedNotes()) {
        let t = d.orig.get(n.id) + steps;
        if (a.scale !== 'chromatic') t = nearestScaleNote(t, +a.key, a.scale);
        n.target = t;
        if (n.amount == null && this.params(n).amount < 0.999) n.amount = 1; // a hand-placed note should land
      }
      this.changed(false);
    } else if (d.type === 'seek') {
      if (!this.h.isPlaying()) this.app.seek(Math.max(0, this.tAt(x)));
      this.invalidate();
    }
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (!d || d.type === 'pinch') return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (d.type === 'note') { if (d.moved && d.steps) this.h.commit(d.before); return; }
    if (d.type === 'seek') { this.app.seek(Math.max(0, this.tAt(x))); this.invalidate(); return; }
    if (d.moved) return;
    if (d.type === 'cut' && d.hit) { this.splitAt(d.hit, this.tAt(x)); return; }
    // tap on empty space: clear selection, move the playhead
    if (!this.multi) { this.sel.clear(); this.afterSelect(); }
    if (x > KEYS_W) this.app.seek(Math.max(0, this.tAt(x)));
    this.invalidate();
  }

  // ---------------- drawing ----------------
  draw() {
    this.dirty = false;
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const dark = document.documentElement.dataset.resolved === 'dark';
    const tr = this.track, a = tr.autotune;
    const deg = SCALES[a.scale] || SCALES.chromatic;
    const color = displayColor(tr.color);
    const semi = this.semi;

    // pitch rows
    g.fillStyle = col('--lane-bg'); g.fillRect(0, 0, w, h);
    const mTop = Math.ceil(this.topMidi + 1), mBot = Math.floor(this.mAt(h) - 1);
    for (let m = mBot; m <= mTop; m++) {
      const yc = this.y(m), y0 = yc - semi / 2;
      const pc = ((m % 12) + 12) % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      const inScale = deg.includes(((m - a.key) % 12 + 12) % 12);
      g.fillStyle = inScale ? (dark ? 'rgba(232,190,62,0.06)' : 'rgba(232,190,62,0.13)') : (black ? (dark ? 'rgba(0,0,0,0.25)' : 'rgba(30,27,22,0.05)') : 'transparent');
      g.fillRect(KEYS_W, y0, w - KEYS_W, semi);
      g.fillStyle = pc === 0 ? col('--grid-bar') : col('--grid-beat');
      g.fillRect(KEYS_W, Math.round(y0 + semi) - 0.5, w - KEYS_W, 1);
    }
    // bar / beat lines
    const p = this.project, spb = 60 / p.bpm, barDur = spb * p.beatsPerBar;
    const tL = this.tAt(KEYS_W), tR = this.tAt(w);
    for (let b = Math.max(0, Math.floor(tL / barDur)); b * barDur <= tR; b++) {
      g.fillStyle = col('--grid-bar');
      g.fillRect(Math.round(this.x(b * barDur)), RULER_H, 1, h);
      if (spb * this.pps > 14) {
        g.fillStyle = col('--grid-beat');
        for (let k = 1; k < p.beatsPerBar; k++) g.fillRect(Math.round(this.x(b * barDur + k * spb)), RULER_H, 1, h);
      }
    }
    // outside this layer's clips: shaded
    g.fillStyle = dark ? 'rgba(0,0,0,0.25)' : 'rgba(30,27,22,0.05)';
    const spans = tr.clips.map(cl => [cl.offset + cl.trimStart, cl.offset + cl.trimEnd]).sort((u, v) => u[0] - v[0]);
    let cur = tL;
    for (const [s0, s1] of spans) { if (s0 > cur) g.fillRect(this.x(cur), RULER_H, this.x(s0) - this.x(cur), h); cur = Math.max(cur, s1); }
    if (cur < tR) g.fillRect(this.x(cur), RULER_H, w, h);

    // pitch curves: thin = as sung, thick = tuned
    for (const cl of tr.clips) {
      const cv = this.curveFor(cl.audioId);
      if (!cv) continue;
      const s0 = Math.max(tL, cl.offset + cl.trimStart), s1 = Math.min(tR, cl.offset + cl.trimEnd);
      if (s1 <= s0) continue;
      const i0 = Math.max(0, Math.floor((s0 - cl.offset) / cv.fd)), i1 = Math.min(cv.midi.length, Math.ceil((s1 - cl.offset) / cv.fd));
      const step = Math.max(1, Math.floor(1 / (cv.fd * this.pps)));
      const path = (arr, style, width) => {
        g.strokeStyle = style; g.lineWidth = width; g.beginPath();
        let pen = false;
        for (let i = i0; i < i1; i += step) {
          const v = arr[i];
          if (isNaN(v)) { pen = false; continue; }
          const px = this.x(cl.offset + i * cv.fd), py = this.y(v);
          if (pen) g.lineTo(px, py); else { g.moveTo(px, py); pen = true; }
        }
        g.stroke();
      };
      path(cv.midi, col('--muted'), 1);
      if (a.enabled) path(cv.out, color, 2.2);
    }

    // note blocks
    for (const e of this.entries()) {
      const x0 = this.x(e.t0), x1 = this.x(e.t1);
      if (x1 < KEYS_W || x0 > w) continue;
      const n = e.note, shown = this.shownPitch(n), sel = this.sel.has(n.id);
      if (Math.abs(shown - n.center) > 0.08) { // ghost where it was sung
        g.setLineDash([3, 3]); g.strokeStyle = col('--muted'); g.lineWidth = 1;
        rr(g, x0, this.y(n.center) - semi * 0.38, x1 - x0, semi * 0.76, 4); g.stroke(); g.setLineDash([]);
      }
      const yy = this.y(shown) - semi * 0.42;
      g.fillStyle = sel ? color : color + (dark ? '55' : '40');
      g.strokeStyle = sel ? col('--text') : color;
      g.lineWidth = sel ? 2 : 1;
      rr(g, x0, yy, Math.max(3, x1 - x0), semi * 0.84, 5); g.fill(); g.stroke();
      if (x1 - x0 > 28 && semi >= 14) {
        g.fillStyle = sel ? (dark ? '#0b0907' : '#f3eee2') : col('--text');
        g.font = '700 11px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textBaseline = 'middle';
        g.fillText(noteName(this.params(n).target), Math.max(x0, KEYS_W) + 5, this.y(shown) + 0.5);
      }
    }

    // playhead
    const px = Math.round(this.x(this.app.playhead)) + 0.5;
    if (px > KEYS_W) { g.fillStyle = col('--playhead'); g.fillRect(px - 1, 0, 2, h); }

    // ruler with bar numbers
    g.fillStyle = col('--ruler-bg'); g.fillRect(0, 0, w, RULER_H);
    g.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textBaseline = 'middle';
    const step = Math.max(1, Math.pow(2, Math.ceil(Math.log2(34 / (barDur * this.pps)))));
    for (let b = Math.max(0, Math.floor(tL / barDur)); b * barDur <= tR; b++) {
      if (b % step) continue;
      const bx = Math.round(this.x(b * barDur));
      g.fillStyle = col('--grid-bar'); g.fillRect(bx, RULER_H - 9, 1, 9);
      g.fillStyle = col('--text'); g.fillText(String(b + 1), bx + 4, RULER_H / 2);
    }
    if (px > KEYS_W) { g.fillStyle = col('--playhead'); g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.fill(); }
    g.fillStyle = col('--border'); g.fillRect(0, RULER_H - 1, w, 1);

    // piano keys
    g.fillStyle = '#efe8d8'; g.fillRect(0, RULER_H, KEYS_W, h);
    for (let m = mBot; m <= mTop; m++) {
      const yc = this.y(m), y0 = yc - semi / 2;
      if (yc < RULER_H - semi) continue;
      const pc = ((m % 12) + 12) % 12;
      const black = [1, 3, 6, 8, 10].includes(pc);
      g.fillStyle = black ? '#1a1712' : '#efe8d8'; // real piano colours in both themes
      g.fillRect(0, y0, black ? KEYS_W * 0.62 : KEYS_W - 1, semi);
      g.fillStyle = '#cfc4ad'; g.fillRect(0, Math.round(y0 + semi) - 0.5, KEYS_W, 1);
      const inScale = deg.includes(((m - a.key) % 12 + 12) % 12);
      if (pc === 0 || (inScale && semi >= 15)) {
        g.fillStyle = black ? '#efe8d8' : (inScale ? '#1e1b16' : '#8a8170');
        g.font = (pc === 0 ? '700 ' : '500 ') + Math.min(12, semi - 3) + 'px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.textBaseline = 'middle';
        g.fillText(noteName(m), black ? 3 : KEYS_W - 26, yc + 0.5);
      }
    }
    g.fillStyle = col('--strong'); g.fillRect(KEYS_W - 1, RULER_H, 1, h);
    g.fillStyle = col('--ruler-bg'); g.fillRect(0, 0, KEYS_W, RULER_H);
  }
}

function centerOf(an, start, end) {
  const fd = an.hop / an.sampleRate, a = Math.floor(start / fd), b = Math.ceil(end / fd);
  const v = [];
  const pad = Math.floor((b - a) * 0.15);
  for (let i = a + pad; i < b - pad; i++) if (an.f0[i] > 0) v.push(69 + 12 * Math.log2(an.f0[i] / 440));
  if (!v.length) return null;
  v.sort((x, y) => x - y);
  return +v[v.length >> 1].toFixed(3);
}

function fmtCents(c) { const r = Math.round(c); return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r) + ' ct'; }

function rr(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); else g.rect(x, y, w, h);
}
