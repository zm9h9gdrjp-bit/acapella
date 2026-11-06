// Audio engine: transport, metronome, multitrack playback, recording, export, latency calibration.
//
// Signal routing (live):
//   track sources -> track gain -> panner -> master -> speakers
//                                       \-> reverb send -> convolver -> master
//   metronome clicks -> metronome gain -> speakers   (separate; never mixed into recordings/exports)
//   microphone -> recorder worklet                   (only the mic is captured, so the click can't
//                                                      end up in a take unless it bleeds acoustically)

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map(); // audioId -> AudioBuffer
    this.transport = null;
    this.mic = null;
    this.onLevel = null;
    this.monitorEnabled = false;
  }

  async init() {
    // a phone can close the audio engine while the app sits in the background: build a new one
    if (this.ctx && this.ctx.state === 'closed') { this.ctx = null; this.mic = null; }
    if (this.ctx) {
      if (this.ctx.state !== 'running') {
        try { await this.ctx.resume(); } catch { /* resumes on the next tap */ }
      }
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx);
    this.reverb.connect(this.master);
    this.metronomeGain = ctx.createGain();
    this.metronomeGain.connect(ctx.destination);
    await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    if (ctx.state !== 'running') await ctx.resume();
  }

  // ---------- buffers ----------
  setBufferFromRecord(rec) {
    const buf = new AudioBuffer({
      length: rec.channels[0].length,
      numberOfChannels: rec.channels.length,
      sampleRate: rec.sampleRate,
    });
    rec.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
    this.buffers.set(rec.id, buf);
    return buf;
  }

  /** Audio a clip plays: the layer's auto-tuned version when it's on and ready, else the raw take. */
  audioIdForClip(track, clip) {
    const at = track.autotune;
    const pid = at && at.enabled && at.processed && at.processed[clip.audioId];
    return pid && this.buffers.has(pid) ? pid : clip.audioId;
  }

  bufferForClip(track, clip) {
    return this.buffers.get(this.audioIdForClip(track, clip));
  }

  async decodeFile(arrayBuffer) {
    await this.init();
    return await this.ctx.decodeAudioData(arrayBuffer);
  }

  // ---------- microphone ----------
  /**
   * Open the microphone. Returns { mic, usedFallback }.
   * The mic is only held while recording: see releaseMic().
   */
  async enableMic(deviceId) {
    await this.init();
    if (this.mic && micAlive(this.mic) && (!deviceId || this.mic.deviceId === deviceId)) {
      return { mic: this.mic, usedFallback: false };
    }
    // the old stream may have been cut off by the phone (app backgrounded, call, restart)
    this.disableMic();
    setAudioSession('play-and-record');
    const constraints = (id) => ({
      audio: {
        deviceId: id ? { ideal: id } : undefined,
        // processing meant for calls ruins singing; turn it off
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    let stream, usedFallback = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      // a saved mic ID can go stale after a restart; fall back to the default mic
      if (!deviceId || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(e.name)) {
        setAudioSession('playback');
        throw e;
      }
      stream = await navigator.mediaDevices.getUserMedia(constraints(null));
      usedFallback = true;
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* */ } }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1 });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink).connect(ctx.destination); // keeps the worklet running
    const monitor = ctx.createGain();
    monitor.gain.value = this.monitorEnabled ? 1 : 0;
    source.connect(monitor).connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    node.port.onmessage = (e) => this._onWorkletMessage(e.data);
    const mic = { stream, track, source, node, sink, monitor, deviceId: settings.deviceId || deviceId, inputLatency: settings.latency };
    track.addEventListener('ended', () => { if (this.mic === mic) this.disableMic(); });
    this.mic = mic;
    return { mic, usedFallback };
  }

  /** Close the microphone and hand the phone's audio back to normal media playback. */
  disableMic() {
    const mic = this.mic;
    this.mic = null;
    if (mic) {
      mic.stream.getTracks().forEach(t => t.stop());
      try { mic.source.disconnect(); mic.node.disconnect(); mic.sink.disconnect(); mic.monitor.disconnect(); } catch { /* */ }
    }
    // While a page holds the mic, phones switch to "call" audio: quiet earpiece-style output.
    // Leaving that mode is what brings playback back to full volume.
    setAudioSession('playback');
    this.onLevel && this.onLevel(0);
  }

  setMonitor(on) {
    this.monitorEnabled = on;
    if (this.mic) this.mic.monitor.gain.value = on ? 1 : 0;
  }

  _onWorkletMessage(m) {
    if (m.type === 'level') { this.onLevel && this.onLevel(m.peak); return; }
    const cap = this._capture;
    if (!cap) return;
    if (m.type === 'data') cap.chunks.push(m.samples);
    if (m.type === 'done') {
      this._capture = null;
      const total = cap.chunks.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const c of cap.chunks) { out.set(c, o); o += c.length; }
      cap.resolve(out);
    }
  }

  _startCapture(atTime) {
    return new Promise((resolve) => {
      this._capture = { chunks: [], resolve };
      this.mic.node.port.postMessage({ type: 'start', time: atTime });
    });
  }

  _stopCapture(atTime) {
    if (this.mic) this.mic.node.port.postMessage({ type: 'stop', time: atTime });
  }

  /** Best guess of round-trip latency in seconds (output + input). */
  estimatedLatency() {
    if (!this.ctx) return 0.02;
    const out = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const inp = (this.mic && this.mic.inputLatency) || 0.01;
    return out + inp;
  }

  // ---------- transport ----------
  get isRunning() { return !!this.transport; }

  /**
   * Start playback (and optionally recording).
   * opts: { project, from (sec), record (bool), latency (sec), onRecorded(samples, info), onEnded() }
   */
  async play(opts) {
    await this.init();
    if (this.transport) this.stop();
    const { project } = opts;
    const ctx = this.ctx;
    const spb = 60 / project.bpm;
    const barDur = spb * project.beatsPerBar;
    const loop = project.loop && project.loop.enabled && project.loop.endBar > project.loop.startBar
      ? { start: (project.loop.startBar - 1) * barDur, end: (project.loop.endBar - 1) * barDur } : null;
    let from = Math.max(0, opts.from || 0);
    if (loop && (from < loop.start || from >= loop.end)) from = loop.start;

    if (!opts.record && !this.mic) setAudioSession('playback');
    const countInDur = opts.record ? project.countInBars * barDur : 0;
    const t0 = ctx.currentTime + 0.15;
    const firstSegCtx = t0 + countInDur;

    // live mixer for the tracks
    const chains = new Map();
    const anySolo = project.tracks.some(t => t.solo);
    for (const tr of project.tracks) {
      const chain = buildChain(ctx, tr, this.master, this.reverb);
      chain.setAudible(isAudible(tr, anySolo));
      chains.set(tr.id, chain);
    }

    const tp = this.transport = {
      project, spb, barDur, loop, from, t0, countInDur,
      record: !!opts.record,
      segments: [],
      sources: [],
      chains,
      nextBeatIndex: 0, // count-in beats first, then timeline beats per segment
      countInBeats: Math.round(countInDur / spb),
      timer: null,
      onEnded: opts.onEnded,
      contentEnd: projectEnd(project),
    };
    this.metronomeGain.gain.value = project.metronome ? project.metronomeVolume : 0;

    this._scheduleSegment(from, loop ? loop.end : Infinity, firstSegCtx);

    if (opts.record) {
      const latency = opts.latency;
      const startTl = from - countInDur;
      const capture = this._startCapture(t0);
      tp.recordInfo = { startTl, latency, capture, onRecorded: opts.onRecorded, sampleRate: ctx.sampleRate };
      if (loop) {
        // punch-record exactly one pass of the loop, then stop
        tp.autoStopCtx = firstSegCtx + (loop.end - from) + latency;
      }
    }

    tp.timer = setInterval(() => this._tick(), 25);
    this._tick();
  }

  _scheduleSegment(tlStart, tlEnd, ctxStart) {
    const tp = this.transport;
    const seg = { tlStart, tlEnd, ctxStart, beatsScheduledUntil: tlStart };
    tp.segments.push(seg);
    for (const tr of tp.project.tracks) {
      for (const c of tr.clips) {
        const buf = this.bufferForClip(tr, c);
        if (!buf) continue;
        const clipStart = c.offset + c.trimStart;
        const clipEnd = c.offset + Math.min(c.trimEnd, buf.duration);
        const s = Math.max(tlStart, clipStart);
        const e = Math.min(tlEnd, clipEnd);
        if (e <= s) continue;
        tp.sources.push(playClip(this.ctx, buf, tp.chains.get(tr.id).input, ctxStart + (s - tlStart), s - c.offset, e - s));
      }
    }
  }

  _tick() {
    const tp = this.transport;
    if (!tp) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const horizon = now + 0.2;

    // count-in clicks
    while (tp.nextBeatIndex < tp.countInBeats) {
      const t = tp.t0 + tp.nextBeatIndex * tp.spb;
      if (t > horizon) break;
      this._click(t, tp.nextBeatIndex % tp.project.beatsPerBar === 0);
      tp.nextBeatIndex++;
    }
    // timeline clicks for each segment
    for (const seg of tp.segments) {
      if (seg.ctxStart > horizon) continue;
      let beat = Math.ceil(seg.beatsScheduledUntil / tp.spb - 1e-6);
      while (true) {
        const tl = beat * tp.spb;
        if (tl >= seg.tlEnd) break;
        const t = seg.ctxStart + (tl - seg.tlStart);
        if (t > horizon) break;
        if (t >= now - 0.01) this._click(t, beat % tp.project.beatsPerBar === 0);
        beat++;
        seg.beatsScheduledUntil = tl + tp.spb * 0.5;
      }
    }
    // looping: queue the next pass shortly before the current one ends
    const last = tp.segments[tp.segments.length - 1];
    const lastEndCtx = last.ctxStart + (last.tlEnd - last.tlStart);
    if (tp.loop && !tp.record && lastEndCtx - now < 0.3) {
      this._scheduleSegment(tp.loop.start, tp.loop.end, lastEndCtx);
      if (tp.segments.length > 4) tp.segments.shift();
    }
    // auto-stop
    if (tp.autoStopCtx && now >= tp.autoStopCtx) { this.stop(); return; }
    if (!tp.loop && !tp.record && tp.contentEnd > 0) {
      const pos = this.position();
      if (pos && !pos.countIn && pos.time > tp.contentEnd + 0.3) { this.stop(); return; }
    }
  }

  _click(time, accent) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(accent ? 1 : 0.6, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(g).connect(this.metronomeGain);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  /** Current transport position as heard (compensating output latency). */
  position() {
    const tp = this.transport;
    if (!tp) return null;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    const first = tp.segments[0];
    if (tp.countInBeats > 0 && now < tp.t0 + tp.countInDur && tp.segments.length && first.tlStart === tp.from) {
      const beat = Math.max(0, Math.floor((now - tp.t0) / tp.spb));
      return { countIn: true, beat: Math.min(beat, tp.countInBeats - 1), time: tp.from };
    }
    let seg = first;
    for (const s of tp.segments) if (s.ctxStart <= now) seg = s;
    const t = seg.tlStart + Math.max(0, now - seg.ctxStart);
    return { countIn: false, time: Math.min(t, seg.tlEnd) };
  }

  /** Live mixer updates while playing. */
  updateMix(project) {
    const tp = this.transport;
    if (!tp) return;
    const anySolo = project.tracks.some(t => t.solo);
    for (const tr of project.tracks) {
      const ch = tp.chains.get(tr.id);
      if (!ch) continue;
      ch.update(tr);
      ch.setAudible(isAudible(tr, anySolo));
    }
    this.metronomeGain.gain.value = project.metronome ? project.metronomeVolume : 0;
  }

  setMetronome(on, volume) {
    if (this.metronomeGain) this.metronomeGain.gain.value = on ? volume : 0;
  }

  stop() {
    const tp = this.transport;
    if (!tp) return;
    this.transport = null;
    clearInterval(tp.timer);
    const now = this.ctx.currentTime;
    for (const s of tp.sources) { try { s.stop(); } catch { /* */ } }
    // silence any metronome clicks already queued
    const mg = this.metronomeGain;
    mg.gain.cancelScheduledValues(now);
    mg.gain.setValueAtTime(0, now);
    setTimeout(() => { for (const ch of tp.chains.values()) ch.disconnect(); }, 100);

    if (tp.recordInfo) {
      const ri = tp.recordInfo;
      // include the singer's final notes, which arrive one round-trip late
      this._stopCapture(Math.max(now, tp.t0) + (tp.autoStopCtx ? 0 : ri.latency));
      ri.capture.then((samples) => {
        // Latency compensation: drop the first `latency` seconds so sample 0 lines up with t0.
        const drop = Math.min(samples.length, Math.round(ri.latency * ri.sampleRate));
        const aligned = samples.slice(drop);
        let loopLen = null;
        if (tp.loop) loopLen = tp.loop.end - tp.from;
        // take is captured: let go of the mic so playback returns to normal volume
        if (this.mic && !this.transport) this.disableMic();
        ri.onRecorded && ri.onRecorded(aligned, {
          sampleRate: ri.sampleRate,
          startTl: ri.startTl,
          visibleFrom: tp.from,
          loopLen,
        });
      });
    }
    tp.onEnded && tp.onEnded();
  }

  // ---------- export ----------
  async renderMix(project, { includeReference = false } = {}) {
    const sampleRate = 44100;
    const end = projectEnd(project, includeReference);
    if (end <= 0) throw new Error('Nothing to export yet');
    const length = Math.ceil((end + 2.5) * sampleRate); // + reverb tail
    const off = new OfflineAudioContext(2, length, sampleRate);
    const master = off.createGain();
    master.connect(off.destination);
    const reverb = off.createConvolver();
    reverb.buffer = makeImpulse(off);
    reverb.connect(master);
    const anySolo = project.tracks.some(t => t.solo);
    for (const tr of project.tracks) {
      if (tr.isReference && !includeReference && !tr.includeInExport) continue;
      if (!isAudible(tr, anySolo)) continue;
      if (!tr.clips.length) continue;
      const chain = buildChain(off, tr, master, reverb);
      for (const c of tr.clips) {
        const buf = this.bufferForClip(tr, c);
        if (!buf) continue;
        const s = Math.max(0, c.offset + c.trimStart);
        const e = c.offset + Math.min(c.trimEnd, buf.duration);
        if (e <= s) continue;
        playClip(off, buf, chain.input, s, s - c.offset, e - s);
      }
    }
    const rendered = await off.startRendering();
    // trim trailing silence, normalise peaks above 0 dBFS
    const chs = [rendered.getChannelData(0), rendered.getChannelData(1)];
    let last = 0, peak = 0;
    for (const ch of chs) for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > 0.0005) last = Math.max(last, i);
      if (a > peak) peak = a;
    }
    const n = Math.min(length, last + Math.round(sampleRate * 0.2));
    const scale = peak > 0.99 ? 0.99 / peak : 1;
    return {
      sampleRate,
      channels: chs.map(ch => { const o = ch.slice(0, n); if (scale !== 1) for (let i = 0; i < n; i++) o[i] *= scale; return o; }),
    };
  }

  // ---------- latency calibration ----------
  /**
   * Plays clicks through the speakers and listens for them with the mic.
   * Must be run WITHOUT headphones. Resolves with latency in seconds, or throws.
   */
  async calibrateLatency() {
    await this.init();
    if (!this.mic) throw new Error('Microphone not enabled');
    if (this.transport) this.stop();
    const ctx = this.ctx;
    const N = 8, interval = 0.5;
    const t0 = ctx.currentTime + 0.3;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    for (let i = 0; i < N; i++) {
      const t = t0 + i * interval;
      const osc = ctx.createOscillator();
      const e = ctx.createGain();
      osc.frequency.value = 2000;
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(1, t + 0.001);
      e.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      osc.connect(e).connect(g);
      osc.start(t); osc.stop(t + 0.04);
    }
    const capture = this._startCapture(t0);
    const stopAt = t0 + N * interval;
    this._stopCapture(stopAt);
    const samples = await capture;
    g.disconnect();
    const sr = ctx.sampleRate;
    const delays = [];
    for (let i = 0; i < N; i++) {
      const a = Math.round(i * interval * sr), b = Math.min(samples.length, a + Math.round(0.45 * sr));
      let mx = 0;
      for (let k = a; k < b; k++) mx = Math.max(mx, Math.abs(samples[k]));
      if (mx < 0.01) continue;
      for (let k = a; k < b; k++) {
        if (Math.abs(samples[k]) > mx * 0.3) { delays.push((k - a) / sr); break; }
      }
    }
    if (delays.length < N / 2) throw new Error('Could not hear the clicks. Turn the volume up, unplug headphones, and try again in a quiet room.');
    delays.sort((x, y) => x - y);
    const med = delays[delays.length >> 1];
    const spread = delays[Math.floor(delays.length * 0.75)] - delays[Math.floor(delays.length * 0.25)];
    if (spread > 0.01) throw new Error('Measurements were inconsistent. Try again in a quieter room.');
    return med;
  }
}

// ---------- helpers ----------
/** Start one clip with 3 ms fades at both ends, so cuts and copies join without clicks. */
function playClip(ctx, buf, dest, when, offset, dur) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const env = ctx.createGain();
  const f = Math.min(0.003, dur / 4);
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(1, when + f);
  env.gain.setValueAtTime(1, when + dur - f);
  env.gain.linearRampToValueAtTime(0, when + dur);
  src.connect(env).connect(dest);
  src.start(when, offset, dur);
  return src;
}

function micAlive(mic) {
  return mic.track && mic.track.readyState === 'live' && !mic.track.muted && mic.stream.active;
}

/** Safari 17+: tell the phone whether we're recording or just playing. Elsewhere a no-op. */
function setAudioSession(type) {
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { /* */ }
}

function isAudible(tr, anySolo) {
  if (tr.mute) return false;
  if (anySolo && !tr.solo) return false;
  return true;
}

function buildChain(ctx, tr, dest, reverbIn) {
  const input = ctx.createGain();
  const vol = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const send = ctx.createGain();
  input.connect(vol).connect(pan).connect(dest);
  pan.connect(send).connect(reverbIn);
  const chain = {
    input,
    update(t) {
      vol.gain.value = t.volume;
      pan.pan.value = t.pan;
      send.gain.value = t.reverb;
    },
    setAudible(on) { input.gain.value = on ? 1 : 0; },
    disconnect() { try { input.disconnect(); vol.disconnect(); pan.disconnect(); send.disconnect(); } catch { /* */ } },
  };
  chain.update(tr);
  return chain;
}

export function projectEnd(project, includeReference = true) {
  let end = 0;
  for (const tr of project.tracks) {
    if (tr.isReference && !includeReference && !tr.includeInExport) continue;
    for (const c of tr.clips) end = Math.max(end, c.offset + c.trimEnd);
  }
  return end;
}

/** Synthetic room impulse: decaying stereo noise with a little pre-delay. */
function makeImpulse(ctx, seconds = 2.2, decay = 3.2) {
  const sr = ctx.sampleRate;
  const len = Math.round(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.round(sr * 0.012);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const env = Math.pow(1 - (i - pre) / (len - pre), decay);
      // gentle low-pass so the tail is warm rather than hissy
      lp += 0.35 * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * env * 0.6;
    }
  }
  return buf;
}
