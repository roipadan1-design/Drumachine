# Max for Live device (planned)

The `.amxd` will be a thin Max patch that reuses **`../engine/sequencer.js`**
unchanged inside a `[js]` object, and reproduces `web/audio.js` natively.

## Mapping web → Max
| Web (Tone.js) | Max for Live |
|---|---|
| `Tone.Player` sample voice | `[sfplay~]` / `[groove~]` reading a `[buffer~]` per role |
| Synth fallbacks | `[kink~]`/`[cycle~]`+`[*~]` env, or keep samples-only |
| Per-voice filter/drive/pan | `[svf~]` / `[overdrive~]` / `[pan~]` |
| Reverb send | `[yafr2~]` or gen~ reverb on a bus |
| Wow/Flutter | modulated `[tapin~]/[tapout~]` (pitch wobble) |
| Tape sat / Bitcrush | `[overdrive~]` / `[degrade~]` |
| Vinyl noise | `[pink~]`/`[noise~]` → `[svf~]` mixed to master |
| Master LP | `[lores~]` / `[svf~]` |
| `Tone.Transport` 16n | Live transport via `[plugsync~]` / `[transport]` |
| Step grid UI | `[live.grid]` (8×16) |
| Knobs | `[live.dial]` / `[live.slider]` mapped to engine params |

## Why this split
Keeping the sequencer logic in the shared JS file means timing/feel decisions
tuned in the browser carry over to Live with zero re-implementation. Only the
audio nodes differ.

> Built in the Max editor (can't be assembled headlessly). When ready we author
> the patch JSON here and you open/verify it in Max 8 inside Live 10.
