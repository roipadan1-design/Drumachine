#!/usr/bin/env node
/*
 * build-manifest.js — scan samples/<role>/ for audio files and write
 * samples/manifest.json, which the web app auto-loads on boot.
 *
 * Usage:  node tools/build-manifest.js
 */
const fs = require('fs');
const path = require('path');

const ROLES = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'perc1', 'perc2', 'fx'];
const AUDIO = /\.(wav|aif|aiff|flac|mp3|ogg)$/i;
const root = path.resolve(__dirname, '..', 'samples');

const manifest = {};
let total = 0;
for (const role of ROLES) {
  const dir = path.join(root, role);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => AUDIO.test(f)).sort();
  } catch (e) { /* role folder missing — skip */ }
  manifest[role] = files;
  total += files.length;
  console.log(`${role.padEnd(12)} ${files.length} file(s)`);
}

fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nwrote samples/manifest.json (${total} files across ${ROLES.length} roles)`);
