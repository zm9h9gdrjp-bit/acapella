# Overdub

A browser-based multitrack recorder for layering a cappella vocals. Record a layer, then stack the next one on top while you hear the earlier ones. A metronome plays in your headphones but never ends up in the recordings.

Everything stays **on your device** (in the browser's IndexedDB). There are no accounts and no server.

## Features

- **Unlimited layers.** Each take becomes a new track with volume, pan, mute (M), solo (S) and reverb.
- **Metronome / click.** It goes straight to your headphones and is never recorded or exported. You can set its volume, use a 1–2 bar count-in, and see a live **bar · beat** counter with beat dots.
- **Tempo and time signature.** Set the BPM with ±, by typing, or with **Tap** tempo. Time signatures from 2/4 to 7/8.
- **Timeline with bars and beats.** Tap to move the playhead, drag clips to move them, and drag clip edges to trim. **Snap** locks edits to the beat. Use Zoom ± (or Ctrl/⌘ + scroll).
- **Loop a section.** Turn on **LOOP**, then drag the yellow loop bar above the bar numbers: drag an end to resize it, or the middle to move it. Or tap **Bars 1–4** to set *From bar / To bar* with −/+ buttons, or to loop 1, 2, 4 or 8 bars from the playhead. Tapping the bar numbers only moves the playhead. Recording in loop mode punch-records exactly one pass.
- **Layers window.** Only the layers scroll. Drag the handle under the controls to make the layers window bigger or smaller; tap it to fold the controls away.
- **Auto-tune (per layer).** Pick a key and scale (major, minor or chromatic) and a **Speed** from *Natural* to *Robotic*, plus an **Amount**. It runs on-device: YIN pitch detection plus PSOLA pitch shifting in a Web Worker. The original take is always kept, so you can switch auto-tune on and off to compare.
- **Reverb.** A shared room reverb with a per-layer send amount.
- **Reference / backing track.** **Import** an MP3 or WAV to sing along with. It's left out of exports unless you include it.
- **Export.** Renders the mix (mute/solo, volume, pan, reverb and auto-tune applied) to a stereo **WAV**.
- **Latency compensation.** Each take is shifted earlier by the round-trip delay so layers line up. The delay is estimated automatically, or you can measure it in ⚙ Settings → *Measure it*.
- **Multiple songs.** Use **Songs** to create, open or delete them. Works offline and can be installed to your home screen.

## How to record (tips)

1. **Use headphones.** Otherwise the click and the other layers leak into the mic.
2. Set the tempo and count-in, then press **●**. Sing after the count-in, then press **●** again (or **■**) to stop.
3. The playhead jumps back to where you started, ready for the next layer.
4. If layers sound slightly late or early, open ⚙ Settings → *Latency compensation*. Use **Measure it** (unplug headphones first) or adjust the milliseconds by hand.

Keyboard: `Space` play/stop · `R` record · `L` loop · `Home` back to start.

## Running it

It's a static site with no build step. The microphone only works on `https://` or `http://localhost`.

```bash
python3 -m http.server 8765
# then open http://localhost:8765
```

To use it on phones, host the folder on any static HTTPS host, such as **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root), Netlify or Cloudflare Pages. Then open it on the phone and "Add to Home Screen".

> **Storage note:** recordings live in the browser on that device. Safari can clear website data that hasn't been used for a while, but apps added to the Home Screen are kept. Export a WAV of anything you care about.

## Tests

```bash
node tests/autotune.test.mjs            # DSP: pitch correction accuracy, level, silence
python3 -m http.server 8765 &           # then the browser end-to-end test (needs Playwright):
node tests/e2e.cjs /tmp /path/to/voice.wav
```

## Code map

| File | What it does |
| --- | --- |
| `js/main.js` | UI wiring, songs, recording flow, dialogs |
| `js/audio-engine.js` | Web Audio transport, metronome, playback, recording, export, latency calibration |
| `js/recorder-worklet.js` | Sample-accurate mic capture (AudioWorklet) |
| `js/timeline.js` | Canvas ruler/lanes, waveforms, drag to move/trim, loop selection |
| `js/autotune.js` | YIN pitch tracking + TD-PSOLA pitch correction |
| `js/autotune-worker.js` | Runs auto-tune off the main thread |
| `js/storage.js` | IndexedDB for songs and audio |
| `js/wav.js` | WAV encoder |
