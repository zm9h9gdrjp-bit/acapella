// Canvas timeline: ruler with bars/beats + loop region, track lanes with waveforms,
// clip move/trim by dragging, playhead.
import { displayColor } from './theme.js';

export const ROW_H = 76;
export const RULER_H = 40;
const EDGE = 12; // px grab zone for trimming

export class Timeline {
  constructor({ scroller, spacer, ruler, lanes, app }) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.ruler = ruler;
    this.lanes = lanes;
    this.app = app;
    this.pps = window.innerWidth < 640 ? 28 : 60; // pixels per second
    this.peaks = new Map();
    this.playhead = 0;
    this.drag = null;
    this.selectedTrackId = null;
    this.recording = null; // { trackRow, from, to }
    this.dirty = true;

    scroller.addEventListener('scroll', () => this.invalidate(), { passive: true });
    window.addEventListener('resize', () => this.invalidate());
    scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = scroller.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left);
      }
    }, { passive: false });

    for (const [el, kind] of [[ruler, 'ruler'], [lanes, 'lanes']]) {
      el.addEventListener('pointerdown', (e) => this.onDown(e, kind));
      el.addEventListener('pointermove', (e) => this.onMove(e, kind));
      el.addEventListener('pointerup', (e) => this.onUp(e, kind));
      el.addEventListener('pointercancel', () => { this.drag = null; });
    }
    const loop = () => { if (this.dirty) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

  get project() { return this.app.project; }

  timeToX(t) { return t * this.pps - this.scroller.scrollLeft; }
  xToTime(x) { return (x + this.scroller.scrollLeft) / this.pps; }

  zoomAt(factor, anchorX) {
    const tAnchor = this.xToTime(anchorX);
    this.pps = Math.max(8, Math.min(600, this.pps * factor));
    this.updateSize();
    this.scroller.scrollLeft = Math.max(0, tAnchor * this.pps - anchorX);
    this.invalidate();
  }

  totalDuration() {
    const p = this.project;
    let end = 0;
    for (const tr of p.tracks) end = Math.max(end, tr.clip.offset + tr.clip.trimEnd);
    if (this.recording) end = Math.max(end, this.recording.to);
    const barDur = 60 / p.bpm * p.beatsPerBar;
    return Math.max(end + barDur * 8, barDur * 32, this.playhead + barDur * 4);
  }

  updateSize() {
    const w = Math.ceil(this.totalDuration() * this.pps);
    this.spacer.style.width = w + 'px';
    const rows = Math.max(1, this.project.tracks.length + (this.recording && this.recording.newRow ? 1 : 0));
    this.lanesCssHeight = rows * ROW_H;
    this.lanes.style.height = this.lanesCssHeight + 'px';
  }

  // ---------- waveform peaks ----------
  peaksFor(audioId, buffer) {
    let p = this.peaks.get(audioId);
    if (p) return p;
    const block = 128;
    const ch = buffer.getChannelData(0);
    const n = Math.ceil(ch.length / block);
    const max = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      const end = Math.min(ch.length, (i + 1) * block);
      for (let k = i * block; k < end; k++) { const a = Math.abs(ch[k]); if (a > m) m = a; }
      max[i] = m;
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, max[i]);
    p = { block, max, sampleRate: buffer.sampleRate, norm: peak > 0 ? Math.min(4, 0.95 / peak) : 1 };
    this.peaks.set(audioId, p);
    return p;
  }

  // ---------- drawing ----------
  setupCanvas(c, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.scroller.clientWidth;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      c.style.width = cssW + 'px';
      c.style.height = cssH + 'px';
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: cssW, h: cssH };
  }

  draw() {
    this.dirty = false;
    const p = this.project;
    if (!p) return;
    this.updateSize();
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const spb = 60 / p.bpm, barDur = spb * p.beatsPerBar;
    const t0 = this.xToTime(0);

    // ----- ruler -----
    {
      const { g, w, h } = this.setupCanvas(this.ruler, RULER_H);
      const t1 = this.xToTime(w);
      g.fillStyle = col('--ruler-bg');
      g.fillRect(0, 0, w, h);
      if (p.loop && p.loop.endBar > p.loop.startBar) {
        const x0 = this.timeToX((p.loop.startBar - 1) * barDur), x1 = this.timeToX((p.loop.endBar - 1) * barDur);
        g.fillStyle = p.loop.enabled ? col('--loop') : col('--loop-off');
        g.fillRect(x0, 0, x1 - x0, h);
      }
      const minBarPx = 34;
      const barStep = Math.max(1, Math.pow(2, Math.ceil(Math.log2(minBarPx / (barDur * this.pps)))));
      const firstBar = Math.max(0, Math.floor(t0 / barDur));
      g.font = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.textBaseline = 'top';
      for (let b = firstBar; b * barDur <= t1; b++) {
        const x = Math.round(this.timeToX(b * barDur)) + 0.5;
        if (b % barStep === 0) {
          g.fillStyle = col('--grid-bar');
          g.fillRect(x - 0.5, h - 18, 1, 18);
          g.fillStyle = col('--text');
          g.fillText(String(b + 1), x + 4, 6);
        }
        if (spb * this.pps >= 10) {
          const showBeatNums = spb * this.pps >= 38;
          for (let k = 1; k < p.beatsPerBar; k++) {
            const bx = Math.round(this.timeToX(b * barDur + k * spb));
            g.fillStyle = col('--grid-bar');
            g.fillRect(bx, h - 7, 1, 7);
            if (showBeatNums) {
              g.fillStyle = col('--muted');
              g.font = '500 11px "Barlow Condensed", "Arial Narrow", sans-serif';
              g.fillText(`${b + 1}.${k + 1}`, bx + 3, 20);
              g.font = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
            }
          }
        }
      }
      g.fillStyle = col('--border');
      g.fillRect(0, h - 1, w, 1);
      this.drawPlayhead(g, h, true, col);
    }

    // ----- lanes -----
    {
      const { g, w, h } = this.setupCanvas(this.lanes, this.lanesCssHeight);
      const t1 = this.xToTime(w);
      g.fillStyle = col('--lane-bg');
      g.fillRect(0, 0, w, h);
      // grid
      const firstBar = Math.max(0, Math.floor(t0 / barDur));
      for (let b = firstBar; b * barDur <= t1; b++) {
        const x = Math.round(this.timeToX(b * barDur));
        g.fillStyle = col('--grid-bar');
        g.fillRect(x, 0, 1, h);
        if (spb * this.pps >= 14) {
          g.fillStyle = col('--grid-beat');
          for (let k = 1; k < p.beatsPerBar; k++) g.fillRect(Math.round(this.timeToX(b * barDur + k * spb)), 0, 1, h);
        }
      }
      if (p.loop && p.loop.enabled && p.loop.endBar > p.loop.startBar) {
        const x0 = this.timeToX((p.loop.startBar - 1) * barDur), x1 = this.timeToX((p.loop.endBar - 1) * barDur);
        g.fillStyle = col('--loop-lane');
        g.fillRect(x0, 0, x1 - x0, h);
      }
      p.tracks.forEach((tr, row) => {
        const y = row * ROW_H;
        if (tr.id === this.selectedTrackId) {
          g.fillStyle = col('--selected-row');
          g.fillRect(0, y, w, ROW_H);
        }
        g.fillStyle = col('--border');
        g.fillRect(0, y + ROW_H - 1, w, 1);
        this.drawClip(g, tr, y, w, col);
      });
      if (this.recording) {
        const row = this.recording.row;
        const y = row * ROW_H;
        const x0 = this.timeToX(this.recording.from), x1 = this.timeToX(this.recording.to);
        g.fillStyle = 'rgba(196,50,27,0.16)';
        g.strokeStyle = col('--rec');
        roundRect(g, x0, y + 6, Math.max(2, x1 - x0), ROW_H - 13, 6);
        g.fill(); g.stroke();
        g.fillStyle = col('--rec');
        g.font = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
        g.fillText('REC', Math.max(x0, 0) + 8, y + 22);
      }
      this.drawPlayhead(g, h, false, col);
    }
  }

  drawClip(g, tr, y, w, col) {
    const color = displayColor(tr.color);
    const buf = this.app.engine.bufferForTrack(tr);
    const c = tr.clip;
    const dur = buf ? buf.duration : c.trimEnd;
    const vs = c.offset + c.trimStart, ve = c.offset + Math.min(c.trimEnd, dur);
    const x0 = this.timeToX(vs), x1 = this.timeToX(ve);
    if (x1 < 0 || x0 > w) return;
    const top = y + 6, hh = ROW_H - 13;
    const dim = tr.mute || (this.project.tracks.some(t => t.solo) && !tr.solo);
    g.save();
    g.globalAlpha = dim ? 0.4 : 1;
    g.fillStyle = color + (document.documentElement.dataset.resolved === 'dark' ? '33' : '22');
    g.strokeStyle = color;
    g.lineWidth = tr.id === this.selectedTrackId ? 2 : 1;
    roundRect(g, x0, top, x1 - x0, hh, 6);
    g.fill(); g.stroke();
    g.clip();
    if (buf) {
      const audioId = (tr.autotune && tr.autotune.enabled && tr.autotune.processedAudioId && this.app.engine.buffers.has(tr.autotune.processedAudioId))
        ? tr.autotune.processedAudioId : c.audioId;
      const pk = this.peaksFor(audioId, buf);
      const mid = top + hh / 2;
      g.fillStyle = color;
      const xa = Math.max(0, Math.floor(x0)), xb = Math.min(w, Math.ceil(x1));
      for (let x = xa; x < xb; x++) {
        const ta = this.xToTime(x) - c.offset, tb = this.xToTime(x + 1) - c.offset;
        const ia = Math.max(0, Math.floor(ta * pk.sampleRate / pk.block));
        const ib = Math.min(pk.max.length, Math.ceil(tb * pk.sampleRate / pk.block));
        let m = 0;
        for (let i = ia; i < ib; i++) if (pk.max[i] > m) m = pk.max[i];
        const a = Math.min(1, m * pk.norm) * (hh / 2 - 4);
        if (a > 0.3) g.fillRect(x, mid - a, 1, a * 2);
      }
    }
    g.restore();
    // label
    g.font = '600 11px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.fillStyle = col('--text');
    const label = (tr.isReference ? 'REF · ' : '') + tr.name + (tr.autotune && tr.autotune.enabled && tr.autotune.processedAudioId ? ' · tuned' : '');
    g.fillText(label, Math.max(x0, 0) + 8, top + 14);
    // trim handles
    g.fillStyle = color;
    g.fillRect(x0, top + hh / 2 - 10, 3, 20);
    g.fillRect(x1 - 3, top + hh / 2 - 10, 3, 20);
  }

  drawPlayhead(g, h, isRuler, col) {
    const x = Math.round(this.timeToX(this.playhead)) + 0.5;
    g.fillStyle = col('--playhead');
    g.fillRect(x - 1, 0, 2, h);
    if (isRuler) {
      g.beginPath();
      g.moveTo(x - 7, 0); g.lineTo(x + 7, 0); g.lineTo(x, 9); g.closePath();
      g.fill();
    }
  }

  // ---------- interaction ----------
  snapTime(t, force) {
    const p = this.project;
    if (!p.snap && !force) return t;
    const spb = 60 / p.bpm;
    return Math.round(t / spb) * spb;
  }

  hitClip(x, y) {
    const row = Math.floor(y / ROW_H);
    const tr = this.project.tracks[row];
    if (!tr) return { row, tr: null };
    const buf = this.app.engine.bufferForTrack(tr);
    const c = tr.clip;
    const ve = c.offset + Math.min(c.trimEnd, buf ? buf.duration : c.trimEnd);
    const x0 = this.timeToX(c.offset + c.trimStart), x1 = this.timeToX(ve);
    const edge = Math.min(EDGE, (x1 - x0) / 3);
    if (x >= x0 - 4 && x <= x0 + edge) return { row, tr, mode: 'trimL' };
    if (x <= x1 + 4 && x >= x1 - edge) return { row, tr, mode: 'trimR' };
    if (x > x0 && x < x1) return { row, tr, mode: 'move' };
    return { row, tr, mode: null };
  }

  onDown(e, kind) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (kind === 'ruler') {
      this.drag = { kind, startX: x, startT: this.xToTime(x), moved: false };
      return;
    }
    const hit = this.hitClip(x, y);
    if (hit.tr && hit.mode && !this.app.engine.isRunning) {
      const c = hit.tr.clip;
      this.drag = { kind, mode: hit.mode, tr: hit.tr, startX: x, orig: { ...c }, moved: false };
    } else {
      this.drag = { kind, mode: 'pan', tr: hit.tr, startX: x, scroll0: this.scroller.scrollLeft, moved: false };
    }
    if (hit.tr) this.app.selectTrack(hit.tr.id);
  }

  onMove(e, kind) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (!this.drag) {
      if (kind === 'lanes') {
        const hit = this.hitClip(x, y);
        e.currentTarget.style.cursor = !hit.mode ? 'default' : hit.mode === 'move' ? 'grab' : 'ew-resize';
      }
      return;
    }
    const d = this.drag;
    if (Math.abs(x - d.startX) > 5) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'ruler') {
      // drag on the ruler = select loop range in whole bars
      const p = this.project, barDur = 60 / p.bpm * p.beatsPerBar;
      const a = d.startT, b = this.xToTime(x);
      const startBar = Math.max(1, Math.floor(Math.min(a, b) / barDur) + 1);
      const endBar = Math.max(startBar + 1, Math.ceil(Math.max(a, b) / barDur) + 1);
      this.app.setLoop(startBar, endBar, true);
      return;
    }
    if (d.mode === 'pan') {
      this.scroller.scrollLeft = Math.max(0, d.scroll0 - (x - d.startX));
      return;
    }
    const dt = (x - d.startX) / this.pps;
    const c = d.tr.clip, o = d.orig;
    const buf = this.app.engine.bufferForTrack(d.tr);
    const bufDur = buf ? buf.duration : o.trimEnd;
    if (d.mode === 'move') {
      let vs = this.snapTime(o.offset + o.trimStart + dt);
      vs = Math.max(0, vs);
      c.offset = vs - o.trimStart;
    } else if (d.mode === 'trimL') {
      let vs = this.snapTime(o.offset + o.trimStart + dt);
      vs = Math.max(o.offset, Math.max(0, vs));
      vs = Math.min(vs, o.offset + o.trimEnd - 0.05);
      c.trimStart = vs - o.offset;
    } else if (d.mode === 'trimR') {
      let ve = this.snapTime(o.offset + o.trimEnd + dt);
      ve = Math.min(o.offset + bufDur, ve);
      ve = Math.max(ve, o.offset + o.trimStart + 0.05);
      c.trimEnd = ve - o.offset;
    }
    this.invalidate();
  }

  onUp(e, kind) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (!d.moved) {
      // a tap = move playhead (snapped to the beat if snap is on)
      this.app.seek(this.snapTime(this.xToTime(x)));
      return;
    }
    if (d.kind === 'lanes' && d.mode !== 'pan') this.app.clipChanged(d.tr);
    if (d.kind === 'ruler') this.app.saveSoon();
  }

  scrollToTime(t) {
    const x = t * this.pps;
    const w = this.scroller.clientWidth;
    const sl = this.scroller.scrollLeft;
    if (x < sl || x > sl + w * 0.85) this.scroller.scrollLeft = Math.max(0, x - w * 0.15);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}
