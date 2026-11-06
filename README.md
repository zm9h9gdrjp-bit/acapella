# Overdub

A browser-based multitrack recorder for layering a cappella vocals. Record a layer, then stack the next one on top while you hear the earlier ones. A metronome plays in your headphones but never ends up in the recordings.

Everything stays **on your device** (in the browser's IndexedDB). There are no accounts and no server.

## Features

- **Unlimited layers.** Each take becomes a new track with volume, pan, mute (M), solo (S) and reverb.
- **Adding and removing layers.** Tap **+ Layer** (top-left, always visible) or **+ Add layer** under the list. Select an empty layer and press REC to record straight into it. The bin icon on a layer deletes it in one tap, and the message that pops up has **Undo**. Keyboard: `N` new layer, `Delete` removes the selected clip, or the selected layer if no clip is selected.
- **Metronome / click.** It goes straight to your headphones and is never recorded or exported. You can set its volume, use a 1–2 bar count-in, and see a live **bar · beat** counter with beat dots.
- **Tempo and time signature.** Set the BPM with ±, by typing, or with **Tap** tempo. Time signatures from 2/4 to 7/8.
- **Timeline with bars and beats.** Tap to move the playhead, drag clips to move them, and drag clip edges to trim. **Snap** locks edits to the beat. Use Zoom ± (or Ctrl/⌘ + scroll).
- **Edit tools** (toolbar above the layers):
  - **Move** (V): drag a clip left or right, or up and down onto another layer. Drop it below the last layer to give it a new layer of its own. Drag a clip's edge to trim it.
  - **Cut** (C): scissors. Tap a clip where you want to split it (it snaps to the beat when Snap is on).
  - **Copy / Paste** (Ctrl/⌘+C, Ctrl/⌘+V): paste goes on the selected layer at the playhead, and the playhead jumps to the end of the paste so pressing Paste again lines the next copy up behind it.
  - **Repeat**: play the selected clip 2×, 4×, 8× or 16×, or fill it to the end of a chosen bar. Record one bar of drums, cut it on the bar lines, and fill the whole song.
  - **Delete** (Delete key), **Undo / Redo** (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z). Deleting a whole layer can be undone too.
  - A clip dropped on top of another clip on the same layer replaces the part underneath.
- **Loop a section.** Turn on **LOOP**, then drag the yellow loop bar above the bar numbers: drag an end to resize it, or the middle to move it. Or tap **Bars 1–4** to set *From bar / To bar* with −/+ buttons, or to loop 1, 2, 4 or 8 bars from the playhead. Tapping the bar numbers only moves the playhead. Recording in loop mode punch-records exactly one pass.
- **Layers window.** Only the layers scroll. Drag the handle under the controls to make the layers window bigger or smaller; tap it to fold the controls away.
- **Auto-tune (per layer)** with a full-screen **tune editor** (toolbar **Tune**, or `T`). Modelled on the classic pitch editors:
  - every sung note is a block on a piano-roll grid; the thin line is what you sang, the thick line is the tuned result
  - drag a note up or down (it snaps to the key), or use −/+; tap empty space to move the playhead
  - per note: **Correct** (how far it's pulled onto the note), **Straighten** (removes slow wandering), **Vibrato** (0% flat … 200% doubled), **Transition** (how fast it glides into the note: 0 ms is the robot step), **Fine** (cents)
  - **Natural / Tight / Robotic** style for every note you haven't touched; **Tuned / Original** switch to compare
  - Select, **Cut** (split a note), **Multi** select, **All**, **Copy / Paste tuning** from one note onto others, Reset, Undo / Redo, pinch or ± to zoom
  - transitions are smoothed forwards and backwards, so glides are centred on the note change rather than lagging; breaths and consonants are left alone, and the shifting method keeps the voice's natural tone
- **Sound** per layer: low cut, warmth, presence, air, tame S, compressor, with Natural / Lead / Backing / Bass voice / Beatbox presets.
- **Reverb.** A shared room reverb with a per-layer send amount.
- **Reference / backing track.** **Import** an MP3 or WAV to sing along with. It's left out of exports unless you include it.
- **Export.** Renders the mix (mute/solo, volume, pan, reverb and auto-tune applied) to a stereo **WAV**.
- **Timing that works with AirPods.** Each pair of earphones / headset remembers its own delay. Setup → **Sync test (earphones on)**: clap on the eight high clicks and the delay is measured through the earphones you actually use (Bluetooth included). Until then a Bluetooth headset gets a sensible guess and a reminder after the take. Each layer also has a **Timing** slider to move it earlier or later by ear, and **Use for future takes** teaches that correction to those earphones.
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
node tests/clips.test.mjs               # cut / overwrite / repeat rules, old-song upgrade
node tests/tuning.test.mjs              # note detection, natural/robotic tuning, per-note edits, transitions
python3 -m http.server 8765 &           # then the browser end-to-end test (needs Playwright):
node tests/e2e.cjs /tmp /path/to/voice.wav
```

## Code map

| File | What it does |
| --- | --- |
| `js/main.js` | UI wiring, songs, recording flow, dialogs |
| `js/audio-engine.js` | Web Audio transport, metronome, playback, recording, export, latency calibration |
| `js/recorder-worklet.js` | Sample-accurate mic capture (AudioWorklet) |
| `js/clips.js` | Clip rules: cut, overwrite, repeat, upgrading old songs |
| `js/timeline.js` | Canvas ruler/lanes, waveforms, drag to move/trim, loop selection |
| `js/autotune.js` | YIN pitch tracking + TD-PSOLA pitch correction |
| `js/tuning.js` | Finds notes per take, keeps each layer's tuned audio up to date |
| `js/tune-editor.js` | The tune editor screen |
| `js/autotune-worker.js` | Runs auto-tune off the main thread |
| `js/storage.js` | IndexedDB for songs and audio |
| `js/wav.js` | WAV encoder |
