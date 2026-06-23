#!/usr/bin/env python3
"""Bundle the web app into a single self-contained HTML file.

Inlines vendor/Tone.js, engine/sequencer.js and web/audio.js into
web/index.html so the result opens directly from disk (double-click,
file://) with no server or clone. Output: demos/BoC_Drumachine_standalone.html

Usage:  python3 tools/build-standalone.py

Note: over file:// the Tone.js BitCrusher AudioWorklet can't load, so the
Bitcrush control is inert; everything else (playback, chop, extract, samples)
works. Serve over http for full fidelity.
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'web/index.html').read_text(encoding='utf-8')

replacements = {
    '<script src="vendor/Tone.js"></script>': root / 'web/vendor/Tone.js',
    '<script src="../engine/sequencer.js"></script>': root / 'engine/sequencer.js',
    '<script src="audio.js"></script>': root / 'web/audio.js',
}
for tag, path in replacements.items():
    assert tag in html, f'tag not found in index.html: {tag}'
    code = path.read_text(encoding='utf-8')
    html = html.replace(tag, '<script>\n/* inlined: %s */\n%s\n</script>' % (path.name, code))

html = html.replace('DUSTY STEP SEQUENCER · 8 VOICES · 16 STEPS',
                    'DUSTY STEP SEQUENCER · 8 VOICES · 16 STEPS · STANDALONE')

out = root / 'demos/BoC_Drumachine_standalone.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding='utf-8')
print(f'wrote {out.relative_to(root)} ({out.stat().st_size // 1024} KB)')
