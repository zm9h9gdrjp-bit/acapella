// Canvas timeline.
//  Ruler (fixed, outside the scroll area):
//    top strip    = loop brace with drag handles (start / end / move / draw a new one)
//    bottom part  = bar numbers; tap or drag here only moves the playhead
//  Lanes (scroll horizontally AND vertically): waveforms, clip move/trim, playhead.
import { displayColor } from './theme.js';

export const ROW_H = 76;
export const STRIP_H = 24;
export const BAR_H = 38;
export const RULER_H = STRIP_H + BAR_H;
const EDGE = 12;       // px grab zone for clip trimming
const HANDLE = 18;     // px grab zone for loop handles
const FONT_B = '700 13px "Barlow Condensed", "Arial Narrow", sans-serif';
const FONT_S = '500 11px "Barlow Condensed", "Arial Narrow", sans-serif';

export class Timeline {
  constructor({ scroller, spacer, ruler, lanes, headersViewport, app }) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.ruler = ruler;
    this.lanes = lanes;
    this.headersViewport = headersViewport;
    this.app = app;
    this.pps = window.innerWidth < 640 ? 28 : 60; // pixels per second
    this.peaks = new Map();
    this.playhead = 0;
    this.drag = null;
    this.selectedTrackId = null;
    this.recording = null; // { row, from, to, newRow }
    this.dirty = true;

    // keep the layer names and the lanes scrolled together
    let syncing = false;
    scroller.addEventListener('scroll', () => {
      if (!syncing) { syncing = true; headersViewport.scrollTop = scroller.scrollTop; syncing = false; }
      this.invalidate();
    }, { passive: true });
    headersViewport.addEventListener('scroll', () => {
      if (!syncing) { syncing = true; scroller.scrollTop = headersViewport.scrollTop; syncing = false; }
    }, { passive: true });
    window.addEventListener('resize', () => this.invalidate());
    if (window.ResizeObserver) new ResizeObserver(() => this.invalidate()).observe(scroller);
    scroller.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = scroller.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left);
      }
    }, { passive: false });
    ruler.addEventListener('wheel', (e) => {
      e.preventDefault();
      scroller.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    }, { passive: false });

    for (const [el, kind] of [[ruler, 'ruler'], [lanes, 'lanes']]) {
      el.addEventListener('pointerdown', (e) => this.onDown(e, kind));
      el.addEventListener('pointermove', (e) => this.onMove(e, kind));
      el.addEventListener('pointerup', (e) => this.onUp(e, kind));
      el.addEventListener('pointercancel', () => { this.drag = null; this.invalidate(); });
    }
    const loop = () => { if (this.dirty) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  invalidate() { this.dirty = true; }

  get project() { return this.app.project; }
  get barDur() { const p = this.project; return 60 / p.bpm * p.beatsPerBar; }

  timeToX(t) { return t * this.pps - this.scroller.scrollLeft; }
  xToTime(x) { return (x + this.scroller.scrollLeft) / this.pps; }
  rowY(row) { return row * ROW_H - this.scroller.scrollTop; }

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
    if (p.loop) end = Math.max(end, (p.loop.endBar - 1) * this.barDur);
    return Math.max(end + this.barDur * 8, this.barDur * 32, this.playhead + this.barDur * 4);
  }

  rowCount() {
    return this.project.tracks.length + (this.recording && this.recording.newRow ? 1 : 0);
  }

  updateSize() {
    this.spacer.style.width = Math.ceil(this.totalDuration() * this.pps) + 'px';
    const contentH = this.rowCount() * ROW_H;
    this.spacer.style.height = Math.max(contentH, this.scroller.clientHeight) + 'px';
    // same scrollable height for the layer names so both columns scroll together
    const th = this.headersViewport.firstElementChild;
    if (th) th.style.minHeight = Math.max(contentH, this.scroller.clientHeight) + 'px';
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
  setupCanvas(c, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
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

  loopX() {
    const l = this.project.loop;
    return { x0: this.timeToX((l.startBar - 1) * this.barDur), x1: this.timeToX((l.endBar - 1) * this.barDur) };
  }

  draw() {
    this.dirty = false;
    const p = this.project;
    if (!p) return;
    this.updateSize();
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const spb = 60 / p.bpm, barDur = this.barDur;
    const t0 = this.xToTime(0);
    const viewW = this.scroller.clientWidth;

    // ----- ruler: loop strip + bar numbers -----
    {
      const { g, w, h } = this.setupCanvas(this.ruler, this.ruler.parentElement.clientWidth, RULER_H);
      const t1 = this.xToTime(w);
      g.fillStyle = col('--strip-bg');
      g.fillRect(0, 0, w, STRIP_H);
      g.fillStyle = col('--ruler-bg');
      g.fillRect(0, STRIP_H, w, BAR_H);

      // loop brace
      const { x0, x1 } = this.loopX();
      const on = p.loop.enabled;
      const top = 4, bh = STRIP_H - 8;
      g.fillStyle = on ? col('--loop-brace') : col('--loop-brace-off');
      roundRect(g, x0, top, x1 - x0, bh, 3);
      g.fill();
      // handles
      g.fillStyle = on ? col('--loop-handle') : col('--muted');
      for (const hx of [x0, x1 - 10]) {
        roundRect(g, hx, top - 2, 10, bh + 4, 2);
        g.fill();
      }
      g.fillStyle = on ? col('--loop-brace') : col('--strip-bg');
      for (const hx of [x0 + 3.5, x0 + 5.5, x1 - 6.5, x1 - 4.5]) g.fillRect(Math.round(hx), top + 3, 1, bh - 6);
      // label inside brace
      if (x1 - x0 > 70) {
        g.font = FONT_S;
        g.textBaseline = 'middle';
        g.fillStyle = on ? col('--loop-text') : col('--muted');
        const to = p.loop.endBar - 1;
        g.fillText(on ? `LOOP ${p.loop.startBar}–${to}` : `LOOP OFF · ${p.loop.startBar}–${to}`, Math.max(x0, 0) + 15, top + bh / 2 + 1);
      }
      if (on) {
        g.fillStyle = col('--loop-lane');
        g.fillRect(x0, STRIP_H, x1 - x0, BAR_H);
      }

      // bar numbers + beat ticks
      const minBarPx = 34;
      const barStep = Math.max(1, Math.pow(2, Math.ceil(Math.log2(minBarPx / (barDur * this.pps)))));
      const firstBar = Math.max(0, Math.floor(t0 / barDur));
      g.textBaseline = 'top';
      for (let b = firstBar; b * barDur <= t1; b++) {
        const x = Math.round(this.timeToX(b * barDur)) + 0.5;
        if (b % barStep === 0) {
          g.fillStyle = col('--grid-bar');
          g.fillRect(x - 0.5, STRIP_H, 1, BAR_H);
          g.fillStyle = col('--text');
          g.font = FONT_B;
          g.fillText(String(b + 1), x + 4, STRIP_H + 5);
        }
        if (spb * this.pps >= 10) {
          const showBeatNums = spb * this.pps >= 38;
          for (let k = 1; k < p.beatsPerBar; k++) {
            const bx = Math.round(this.timeToX(b * barDur + k * spb));
            g.fillStyle = col('--grid-bar');
            g.fillRect(bx, h - 7, 1, 7);
            if (showBeatNums) {
              g.fillStyle = col('--muted');
              g.font = FONT_S;
              g.fillText(`${b + 1}.${k + 1}`, bx + 3, STRIP_H + 7);
            }
          }
        }
      }
      g.fillStyle = col('--border');
      g.fillRect(0, STRIP_H - 1, w, 1);
      g.fillRect(0, h - 1, w, 1);
      // playhead in the bar-number area only
      const px = Math.round(this.timeToX(this.playhead)) + 0.5;
      g.fillStyle = col('--playhead');
      g.fillRect(px - 1, STRIP_H, 2, BAR_H);
      g.beginPath();
      g.moveTo(px - 7, STRIP_H); g.lineTo(px + 7, STRIP_H); g.lineTo(px, STRIP_H + 9); g.closePath();
      g.fill();
    }

    // ----- lanes (viewport-sized canvas; rows drawn at scroll offset) -----
    {
      const { g, w, h } = this.setupCanvas(this.lanes, viewW, this.scroller.clientHeight);
      const t1 = this.xToTime(w);
      g.fillStyle = col('--lane-bg');
      g.fillRect(0, 0, w, h);
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
      if (p.loop.enabled) {
        const { x0, x1 } = this.loopX();
        g.fillStyle = col('--loop-lane');
        g.fillRect(x0, 0, x1 - x0, h);
      }
      p.tracks.forEach((tr, row) => {
        const y = this.rowY(row);
        if (y > h || y + ROW_H < 0) return;
        if (tr.id === this.selectedTrackId) {
          g.fillStyle = col('--selected-row');
          g.fillRect(0, y, w, ROW_H);
        }
        g.fillStyle = col('--rule');
        g.fillRect(0, y + ROW_H - 1, w, 1);
        this.drawClip(g, tr, y, w, col);
      });
      if (this.recording) {
        const y = this.rowY(this.recording.row);
        const x0 = this.timeToX(this.recording.from), x1 = this.timeToX(this.recording.to);
        g.fillStyle = 'rgba(196,50,27,0.16)';
        g.strokeStyle = col('--rec');
        roundRect(g, x0, y + 6, Math.max(2, x1 - x0), ROW_H - 13, 6);
        g.fill(); g.stroke();
        g.fillStyle = col('--rec');
        g.font = FONT_B;
        g.textBaseline = 'alphabetic';
        g.fillText('REC', Math.max(x0, 0) + 8, y + 24);
      }
      const px = Math.round(this.timeToX(this.playhead)) + 0.5;
      g.fillStyle = col('--playhead');
      g.fillRect(px - 1, 0, 2, h);
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
    g.font = '600 11px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillStyle = col('--text');
    const label = (tr.isReference ? 'REF · ' : '') + tr.name + (tr.autotune && tr.autotune.enabled && tr.autotune.processedAudioId ? ' · tuned' : '');
    g.fillText(label, Math.max(x0, 0) + 8, top + 14);
    g.fillStyle = color;
    g.fillRect(x0, top + hh / 2 - 10, 3, 20);
    g.fillRect(x1 - 3, top + hh / 2 - 10, 3, 20);
  }

  // ---------- interaction ----------
  snapTime(t, force) {
    const p = this.project;
    if (!p.snap && !force) return t;
    const spb = 60 / p.bpm;
    return Math.round(t / spb) * spb;
  }

  barAt(x) { return Math.max(1, Math.floor(this.xToTime(x) / this.barDur) + 1); }
  nearestBarLine(x) { return Math.max(1, Math.round(this.xToTime(x) / this.barDur) + 1); }

  hitClip(x, y) {
    const row = Math.floor((y + this.scroller.scrollTop) / ROW_H);
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

  hitLoop(x) {
    const { x0, x1 } = this.loopX();
    if (Math.abs(x - x0) <= HANDLE && x <= (x0 + x1) / 2) return 'loopStart';
    if (Math.abs(x - x1) <= HANDLE) return 'loopEnd';
    if (x > x0 && x < x1) return 'loopMove';
    return 'loopNew';
  }

  onDown(e, kind) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (kind === 'ruler') {
      if (y < STRIP_H) {
        if (this.app.recording) return;
        const l = this.project.loop;
        this.drag = { kind, mode: this.hitLoop(x), startX: x, orig: { ...l }, startBar: this.barAt(x), moved: false };
      } else {
        this.drag = { kind, mode: 'scrub', startX: x, moved: false };
      }
      return;
    }
    const hit = this.hitClip(x, y);
    if (hit.tr && hit.mode && !this.app.engine.isRunning) {
      this.drag = { kind, mode: hit.mode, tr: hit.tr, startX: x, startY: y, orig: { ...hit.tr.clip }, moved: false };
    } else {
      this.drag = { kind, mode: 'pan', tr: hit.tr, startX: x, startY: y,
        scroll0: this.scroller.scrollLeft, scrollTop0: this.scroller.scrollTop, moved: false };
    }
    if (hit.tr) this.app.selectTrack(hit.tr.id);
  }

  onMove(e, kind) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (!this.drag) {
      let cur = 'default';
      if (kind === 'lanes') {
        const hit = this.hitClip(x, y);
        cur = !hit.mode ? 'default' : hit.mode === 'move' ? 'grab' : 'ew-resize';
      } else if (y < STRIP_H) {
        const m = this.hitLoop(x);
        cur = m === 'loopMove' ? 'grab' : m === 'loopNew' ? 'crosshair' : 'ew-resize';
      } else cur = 'pointer';
      e.currentTarget.style.cursor = cur;
      return;
    }
    const d = this.drag;
    if (Math.abs(x - d.startX) > 5 || (d.startY != null && Math.abs(y - d.startY) > 5)) d.moved = true;
    if (!d.moved) return;

    if (d.kind === 'ruler') {
      if (d.mode === 'scrub') {
        if (!this.app.engine.isRunning) this.app.seek(Math.max(0, this.snapTime(this.xToTime(x))));
        return;
      }
      const o = d.orig, len = o.endBar - o.startBar;
      let s = o.startBar, en = o.endBar;
      if (d.mode === 'loopStart') { s = Math.min(this.nearestBarLine(x), o.endBar - 1); }
      else if (d.mode === 'loopEnd') { en = Math.max(this.nearestBarLine(x), o.startBar + 1); }
      else if (d.mode === 'loopMove') {
        const shift = Math.round((x - d.startX) / (this.barDur * this.pps));
        s = Math.max(1, o.startBar + shift); en = s + len;
      } else if (d.mode === 'loopNew') {
        const a = d.startBar, b = this.barAt(x);
        s = Math.min(a, b); en = Math.max(a, b) + 1;
      }
      this.app.setLoop(s, en, true);
      return;
    }
    if (d.mode === 'pan') {
      this.scroller.scrollLeft = Math.max(0, d.scroll0 - (x - d.startX));
      this.scroller.scrollTop = Math.max(0, d.scrollTop0 - (y - d.startY));
      return;
    }
    const dt = (x - d.startX) / this.pps;
    const c = d.tr.clip, o = d.orig;
    const buf = this.app.engine.bufferForTrack(d.tr);
    const bufDur = buf ? buf.duration : o.trimEnd;
    if (d.mode === 'move') {
      const vs = Math.max(0, this.snapTime(o.offset + o.trimStart + dt));
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
    if (d.kind === 'ruler' && d.mode !== 'scrub') {
      if (!d.moved) {
        if (d.mode === 'loopNew') {
          // tap outside the brace: move the loop (same length) to start at the tapped bar
          const len = d.orig.endBar - d.orig.startBar;
          this.app.setLoop(d.startBar, d.startBar + len, true);
        } else if (d.mode === 'loopMove' && !this.project.loop.enabled) {
          this.app.setLoop(d.orig.startBar, d.orig.endBar, true);
        }
      }
      this.app.loopChanged();
      return;
    }
    if (!d.moved) {
      this.app.seek(this.snapTime(this.xToTime(x)));
      return;
    }
    if (d.kind === 'ruler' && d.mode === 'scrub' && this.app.engine.isRunning) {
      this.app.seek(this.snapTime(this.xToTime(x)));
      return;
    }
    if (d.kind === 'lanes' && d.mode !== 'pan') this.app.clipChanged(d.tr);
  }

  scrollToTime(t) {
    const x = t * this.pps;
    const w = this.scroller.clientWidth;
    const sl = this.scroller.scrollLeft;
    if (x < sl || x > sl + w * 0.85) this.scroller.scrollLeft = Math.max(0, x - w * 0.15);
  }

  scrollToRow(row) {
    const top = row * ROW_H, h = this.scroller.clientHeight;
    const st = this.scroller.scrollTop;
    if (top < st) this.scroller.scrollTop = top;
    else if (top + ROW_H > st + h) this.scroller.scrollTop = top + ROW_H - h;
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  else g.rect(x, y, w, h);
}
