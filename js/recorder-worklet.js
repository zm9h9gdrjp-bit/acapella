// Captures microphone PCM between two sample-accurate frame numbers on the AudioContext clock.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startFrame = Infinity;
    this.stopFrame = Infinity;
    this.chunks = [];
    this.chunkSize = 0;
    this.active = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'start') {
        this.startFrame = Math.round(m.time * sampleRate);
        this.stopFrame = Infinity;
        this.active = true;
        this.chunks = [];
      } else if (m.type === 'stop') {
        this.stopFrame = Math.round(m.time * sampleRate);
      } else if (m.type === 'cancel') {
        this.active = false; this.chunks = [];
      }
    };
  }
  flush(final) {
    if (this.chunks.length) {
      const total = this.chunks.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      this.chunks = [];
      this.port.postMessage({ type: 'data', samples: out }, [out.buffer]);
    }
    if (final) this.port.postMessage({ type: 'done' });
  }
  process(inputs) {
    const input = inputs[0];
    const frames = 128;
    // input level meter (even when not recording)
    if (input && input[0]) {
      let peak = 0;
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
      if ((currentFrame & 2047) < frames) this.port.postMessage({ type: 'level', peak });
    }
    if (!this.active) return true;
    const blockStart = currentFrame;
    const blockEnd = currentFrame + frames;
    if (blockEnd <= this.startFrame) return true;
    const from = Math.max(0, this.startFrame - blockStart);
    const to = Math.min(frames, this.stopFrame - blockStart);
    if (to > from) {
      const out = new Float32Array(to - from);
      if (input && input.length) {
        // mix all input channels to mono
        for (let c = 0; c < input.length; c++) {
          const ch = input[c];
          for (let i = from; i < to; i++) out[i - from] += ch[i] / input.length;
        }
      }
      this.chunks.push(out);
      this.chunkSize += out.length;
      if (this.chunkSize > sampleRate) { this.chunkSize = 0; this.flush(false); }
    }
    if (blockEnd >= this.stopFrame) {
      this.active = false;
      this.flush(true);
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
