# Samples

Drop your `.wav` one-shots into the folder for each role. Every file in a
folder becomes one selectable option in that voice's **bank** — switch between
them live in the plugin.

```
samples/
├── kick/         ← soft, round, dusty kicks
├── snare/        ← muffled / filtered snares & rims
├── clap/         ← claps, finger-snaps, rimshots
├── hat_closed/   ← tight, rolled-off closed hats
├── hat_open/     ← washy open hats / shakers
├── perc1/        ← found-sound percussion, blocks, clicks
├── perc2/        ← second perc layer / bells / toys
└── fx/           ← toms, sub hits, textures, reversed bits
```

## Boards of Canada flavour — what to look for
- **Soft, slightly detuned** sources. Nothing crisp or modern.
- **Rolled-off highs** — material that already sounds like it came off tape.
- **Found sounds & toys** for the perc/fx voices (rubber bands, music boxes,
  vintage drum machines, field recordings).
- Mono or narrow stereo works best; the Dust chain adds the width/wobble.

## Naming
Filenames are shown in the bank selector, so name them clearly, e.g.
`kick_tape_soft.wav`, `snare_dusty_01.wav`. No strict convention required.

> The web prototype loads samples via the 📁 button (per voice). For the Max
> for Live device these folders ship inside the `.amxd` project.
