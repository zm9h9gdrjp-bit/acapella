// Tuning service: finds the notes in each take (once), keeps the layer's tuned audio
// up to date, and runs all the heavy work in a background worker.
//
// Data:
//   project.tuning[audioId].notes = [{ id, start, end, center, target?, amount?, drift?, vibrato?, transition?, fine? }]
//     (times in seconds into the take; per-note fields are optional overrides)
//   track.autotune = { enabled, key, scale, speed (0 natural..100 robotic), amount (0..100),
//                      processed: { audioId: tunedAudioId }, sig: { audioId: settingsHash } }
import { styleDefaults } from './autotune.js';

export class Tuning {
  constructor({ getProject, engine, db, uid, onRendered }) {
    this.getProject = getProject;
    this.engine = engine;
    this.db = db;
    this.uid = uid;
    this.onRendered = onRendered || (() => {});
    this.analysis = new Map();   // audioId -> { hop, sampleRate, f0 }
    this.analyzing = new Map();  // audioId -> Promise
    this.rendering = new Map();  // trackId -> Promise
    this.again = new Set();      // trackIds that changed while rendering
    this.jobs = new Map();
    this.seq = 0;
    this.worker = null;
  }

  call(msg, transfer = [], onProgress) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./autotune-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const m = e.data, job = this.jobs.get(m.id);
        if (!job) return;
        if (m.progress != null) { job.onProgress && job.onProgress(m.progress); return; }
        this.jobs.delete(m.id);
        if (m.error) job.reject(new Error(m.error)); else job.resolve(m);
      };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  notesFor(audioId) {
    const p = this.getProject();
    const t = p.tuning && p.tuning[audioId];
    return t ? t.notes : null;
  }

  /** Pitch track + note list for a take (notes are created once and then kept with your edits). */
  async ensureAnalysis(audioId, onProgress) {
    if (this.analysis.has(audioId) && this.notesFor(audioId)) return this.analysis.get(audioId);
    if (this.analyzing.has(audioId)) return this.analyzing.get(audioId);
    const job = (async () => {
      const buf = this.engine.buffers.get(audioId);
      if (!buf) throw new Error('This take’s audio is missing.');
      const channel = buf.getChannelData(0).slice();
      const m = await this.call({ op: 'analyze', channel, sampleRate: buf.sampleRate }, [channel.buffer], onProgress);
      const a = m.analysis;
      this.analysis.set(audioId, { hop: a.hop, sampleRate: a.sampleRate, f0: a.f0 });
      const p = this.getProject();
      p.tuning = p.tuning || {};
      if (!p.tuning[audioId]) p.tuning[audioId] = { notes: a.notes.map(n => ({ id: this.uid(), ...n })) };
      return this.analysis.get(audioId);
    })();
    this.analyzing.set(audioId, job);
    try { return await job; } finally { this.analyzing.delete(audioId); }
  }

  opts(track) {
    const a = track.autotune;
    return { key: +a.key, scale: a.scale, defaults: styleDefaults((a.speed ?? 60) / 100, (a.amount ?? 100) / 100) };
  }

  sig(track, audioId) {
    const notes = this.notesFor(audioId) || [];
    return JSON.stringify([this.opts(track), notes.map(n => [n.start, n.end, n.target, n.amount, n.drift, n.vibrato, n.transition, n.fine])]);
  }

  /** Takes on this layer whose tuned version is missing or out of date. */
  stale(track) {
    const a = track.autotune;
    const ids = [...new Set(track.clips.map(c => c.audioId))];
    return ids.filter(id => !(a.processed || {})[id] || !this.notesFor(id) || (a.sig || {})[id] !== this.sig(track, id));
  }

  busy(trackId) { return this.rendering.has(trackId); }

  /** Bring the layer's tuned audio up to date. Re-runs once more if edits arrive meanwhile. */
  render(track, onProgress) {
    if (this.rendering.has(track.id)) { this.again.add(track.id); return this.rendering.get(track.id); }
    const run = (async () => {
      do {
        this.again.delete(track.id);
        const ids = this.stale(track);
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const an = await this.ensureAnalysis(id, (p) => onProgress && onProgress((i + p * 0.4) / ids.length));
          const buf = this.engine.buffers.get(id);
          if (!buf) continue;
          const sig = this.sig(track, id);
          const channels = [];
          for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
          const m = await this.call({
            op: 'render', channels, sampleRate: buf.sampleRate,
            analysis: { hop: an.hop, f0: an.f0 }, notes: this.notesFor(id), opts: this.opts(track),
          }, channels.map(c => c.buffer), (p) => onProgress && onProgress((i + 0.4 + p * 0.6) / ids.length));
          const audio = { id: this.uid(), sampleRate: buf.sampleRate, channels: m.channels };
          await this.db.saveAudio(audio);
          this.engine.setBufferFromRecord(audio);
          const a = track.autotune;
          a.processed = { ...(a.processed || {}), [id]: audio.id };
          a.sig = { ...(a.sig || {}), [id]: sig };
        }
      } while (this.again.has(track.id));
    })();
    this.rendering.set(track.id, run);
    run.finally(() => { this.rendering.delete(track.id); this.onRendered(track); }).catch(() => {});
    return run;
  }
}
