# BoC Drumachine — Spec (v0.1)

A dusty, lo-fi step-sequencer drum machine inspired by the drum sounds of
**Boards of Canada**. Target host: **Ableton Live 10 + Max for Live (Max 8)**.

## Decisions locked
| Topic | Choice |
|---|---|
| Delivery | **Hybrid** — one shared JS engine drives a browser prototype *and* the M4L device |
| Sounds | **User-provided samples** per role, with built-in synth fallbacks for day-one sound |
| Voices | **8** — Kick, Snare, Clap/Rim, Hat Closed, Hat Open, Perc 1, Perc 2, FX/Tom |
| Steps | **16** per pattern, four pattern slots **A/B/C/D** + chaining |

## Architecture
```
engine/sequencer.js   pure ES5 logic — steps, swing, humanize, probability,
                      ratchets, patterns/chaining. Shared by web + Max.
web/index.html        UI (grid, mixer, step inspector, Dust panel)
web/audio.js          Tone.js audio: sample players + synth fallbacks + FX
samples/<role>/       user one-shot banks (switchable live)
m4l/                  Max for Live device (mirrors web/audio.js natively)
```
The engine is **audio-agnostic**: the host calls `eventsForStep(i)` each
16th-note and gets back resolved events (`voice, velocity, offset, ratchet`).

## Features
**Per voice:** sample-bank select (live swap) · Volume · Pan · Pitch (±12) ·
Decay · Filter (LP/HP/off + cutoff) · Drive/Saturation · Reverb send ·
Choke group · Mute/Solo.

**Per step:** On/off · Velocity · Probability % · Micro-timing (Nudge) ·
Ratchet (1–4×).

**Global feel:** Swing · Humanize (time + velocity).

**Dust — the BoC character (master chain):** Wow · Flutter (tape pitch
wobble) · Tape Saturation · Bitcrush/Downsample · Vinyl Noise · Master LP.

## Status
- [x] Shared sequencer engine + Node unit test
- [x] Web prototype: UI, transport, synth fallbacks, Dust chain, sample loading
- [ ] Drop in real BoC-style samples and tune the synth fallbacks
- [ ] Build the Max for Live device around the shared engine
- [ ] Preset/pattern save & load

## Roadmap / open questions for next pass
1. Polymeter (per-voice step length) — deferred, easy to add to the engine.
2. Per-voice insert FX vs. the single master Dust chain — currently master only.
3. Pattern morph / fills, accent lane, velocity "humanize curves".
4. Once a real sample set exists: round-robin & sample-start/length controls.
