import { autotune } from './autotune.js';

self.onmessage = (e) => {
  const { id, channels, sampleRate, params } = e.data;
  try {
    const out = channels.map((ch, i) => autotune(ch, sampleRate, params, (p) => {
      self.postMessage({ id, progress: (i + p) / channels.length });
    }));
    self.postMessage({ id, done: true, channels: out }, out.map(c => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
