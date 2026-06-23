# BoC Drumachine

A dusty, lo-fi **step-sequencer drum machine** inspired by the drum sounds of
**Boards of Canada** — built for **Ableton Live 10 / Max for Live**, with a
browser prototype that shares the same sequencer engine.

8 voices · 16 steps · A/B/C/D patterns · per-step velocity / probability /
micro-timing / ratchet · swappable sample banks per voice · a master **"Dust"**
chain (wow & flutter, tape saturation, bitcrush, vinyl noise, master LP).

See [`SPEC.md`](SPEC.md) for the full feature spec and roadmap.

## Run the web prototype
The engine lives in `engine/` (shared with the future Max device), so the app
must be **served over HTTP from the project root** — not opened as `file://`,
and not served from inside `web/`.

```bash
# from the repo root
python3 -m http.server 8099
# then open:  http://localhost:8099/web/index.html
```

Press **PLAY** (this also unlocks audio). A starter groove is pre-loaded so you
hear something immediately via the built-in synth drums.

### Using it
- **Click a step** to toggle it on/off (brightness = velocity).
- **Right-click a step** to select it and edit Velocity / Probability / Nudge /
  Ratchet in the Step panel.
- **Click a voice name** to load it into the mixer (Volume, Pan, Pitch, Decay,
  Filter, Drive, Reverb send, Choke group) and **📁 load your own sample**.
- **A/B/C/D** switch pattern slots. The **Dust** panel adds the BoC character.

## Add your sounds
Drop `.wav` one-shots into `samples/<role>/` (see
[`samples/README.md`](samples/README.md)). Each file becomes a switchable
option in that voice's bank. In the web prototype, load them per-voice with 📁.

## Layout
```
engine/sequencer.js   shared, audio-agnostic sequencer (web + Max)
web/                  Tone.js prototype (index.html, audio.js, vendor/Tone.js)
samples/<role>/       your one-shot banks
m4l/                  Max for Live device (planned — see m4l/README.md)
```

## Status
Web prototype is working and verified. Next: real BoC-style samples, then the
Max for Live device built around the same engine. See `SPEC.md`.
