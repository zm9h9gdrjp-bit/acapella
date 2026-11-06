import { autotune, analyze, renderTuned } from './autotune.js';

// Jobs:
//  { op: 'analyze', id, channel, sampleRate }                         -> { id, done, analysis }
//  { op: 'render',  id, channels, sampleRate, analysis, notes, opts }  -> { id, done, channels }
//  (no op) legacy whole-take auto-tune                                 -> { id, done, channels }
self.onmessage = (e) => {
  const d = e.data;
  const progress = (p) => self.postMessage({ id: d.id, progress: p });
  try {
    if (d.op === 'analyze') {
      const a = analyze(d.channel, d.sampleRate, progress);
      self.postMessage({ id: d.id, done: true, analysis: a }, [a.f0.buffer]);
    } else if (d.op === 'render') {
      const out = d.channels.map((ch, i) => renderTuned(ch, d.sampleRate, d.analysis, d.notes, d.opts,
        (p) => progress((i + p) / d.channels.length)));
      self.postMessage({ id: d.id, done: true, channels: out }, out.map(c => c.buffer));
    } else {
      const out = d.channels.map((ch, i) => autotune(ch, d.sampleRate, d.params, (p) => progress((i + p) / d.channels.length)));
      self.postMessage({ id: d.id, done: true, channels: out }, out.map(c => c.buffer));
    }
  } catch (err) {
    self.postMessage({ id: d.id, error: String(err && err.message || err) });
  }
};
