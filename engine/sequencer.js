/*
 * BoC Drumachine — shared sequencer engine
 * --------------------------------------------------------------------------
 * Pure logic. No audio, no DOM. This same file is loaded by:
 *   - the web prototype  (web/index.html, via <script> / ES module wrapper)
 *   - the Max for Live device (m4l, via the [js] object)
 *
 * Because Max's [js] runs an older JS engine, this file is intentionally
 * written in conservative ES5 (var / function / prototype, no arrow funcs,
 * no let/const, no template strings). Keep it that way so it stays portable.
 *
 * The engine is audio-agnostic. The host calls `eventsForStep(i)` on every
 * 16th-note tick and receives the list of voices that should fire, already
 * resolved for probability, velocity, micro-timing and ratchets. The host
 * decides *how* to make the sound.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();            // Node / bundlers
  } else {
    root.DrumSequencer = factory();        // browser global + Max [js]
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NUM_VOICES = 8;
  var NUM_STEPS = 16;
  var PATTERN_SLOTS = ['A', 'B', 'C', 'D'];

  // Default voice layout. `role` maps to the samples/<role>/ folder.
  var VOICE_DEFS = [
    { name: 'Kick',       role: 'kick' },
    { name: 'Snare',      role: 'snare' },
    { name: 'Clap/Rim',   role: 'clap' },
    { name: 'Hat Closed', role: 'hat_closed' },
    { name: 'Hat Open',   role: 'hat_open' },
    { name: 'Perc 1',     role: 'perc1' },
    { name: 'Perc 2',     role: 'perc2' },
    { name: 'FX/Tom',     role: 'fx' }
  ];

  // ---- helpers -------------------------------------------------------------

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function makeStep() {
    return {
      on: false,
      velocity: 1.0,   // 0..1
      prob: 1.0,       // 0..1 chance the step fires
      nudge: 0.0,      // -0.5..0.5 of a step (micro-timing)
      ratchet: 1       // 1..4 sub-hits within the step
    };
  }

  function makeVoice(def) {
    return {
      name: def.name,
      role: def.role,
      // mixer / shaping (consumed by the audio layer, stored here so a whole
      // patch can be serialised from one place)
      volume: 0.8,     // 0..1
      pan: 0.0,        // -1..1
      pitch: 0,        // semitones, -12..12
      decay: 1.0,      // 0..1 amp-envelope length scaler
      filterType: 'lp',// 'lp' | 'hp' | 'off'
      filterFreq: 1.0, // 0..1 normalised cutoff
      drive: 0.0,      // 0..1 saturation amount
      reverbSend: 0.0, // 0..1
      chokeGroup: 0,   // 0 = none; voices sharing a group cut each other
      mute: false,
      solo: false,
      sampleIndex: 0   // which sample in the role's bank is selected
    };
  }

  function makePattern() {
    var voices = [];
    for (var v = 0; v < NUM_VOICES; v++) {
      var steps = [];
      for (var s = 0; s < NUM_STEPS; s++) steps.push(makeStep());
      voices.push(steps);
    }
    return { steps: voices, length: NUM_STEPS };
  }

  // ---- engine --------------------------------------------------------------

  function DrumSequencer(opts) {
    opts = opts || {};
    this.numVoices = NUM_VOICES;
    this.numSteps = NUM_STEPS;
    this.voices = [];
    for (var i = 0; i < NUM_VOICES; i++) this.voices.push(makeVoice(VOICE_DEFS[i]));

    // four independent pattern slots; `current` is the one being played/edited
    this.patterns = {};
    for (var p = 0; p < PATTERN_SLOTS.length; p++) {
      this.patterns[PATTERN_SLOTS[p]] = makePattern();
    }
    this.current = 'A';

    // pattern chaining, e.g. ['A','A','B','A']; empty = stay on `current`
    this.chain = [];
    this._chainPos = 0;

    // global feel
    this.swing = 0.0;       // 0..1  (0 = straight, ~0.5 = heavy)
    this.humanizeTime = 0.0;// 0..1  random timing jitter
    this.humanizeVel = 0.0; // 0..1  random velocity jitter

    this.rng = opts.rng || Math.random;
  }

  DrumSequencer.PATTERN_SLOTS = PATTERN_SLOTS;
  DrumSequencer.VOICE_DEFS = VOICE_DEFS;

  DrumSequencer.prototype.pattern = function () {
    return this.patterns[this.current];
  };

  DrumSequencer.prototype.getStep = function (voice, step) {
    return this.pattern().steps[voice][step];
  };

  DrumSequencer.prototype.toggleStep = function (voice, step) {
    var st = this.getStep(voice, step);
    st.on = !st.on;
    return st.on;
  };

  DrumSequencer.prototype.setStep = function (voice, step, props) {
    var st = this.getStep(voice, step);
    for (var k in props) if (props.hasOwnProperty(k)) st[k] = props[k];
    return st;
  };

  DrumSequencer.prototype.selectPattern = function (slot) {
    if (this.patterns[slot]) this.current = slot;
  };

  DrumSequencer.prototype.setChain = function (arr) {
    this.chain = arr || [];
    this._chainPos = 0;
  };

  // Advance pattern chain when a bar wraps (host calls this at step 0).
  DrumSequencer.prototype.advanceChain = function () {
    if (!this.chain.length) return;
    this._chainPos = (this._chainPos + 1) % this.chain.length;
    this.selectPattern(this.chain[this._chainPos]);
  };

  /*
   * Core query: what should fire on this 16th-note step?
   * Returns an array of events. Each event:
   *   { voice, velocity, offset, ratchetIndex, ratchetCount }
   *   - offset:      timing offset in *fraction of a step* (-0.5..+0.5),
   *                  already combining swing + per-step nudge + humanize.
   *   - velocity:    0..1 final velocity (after humanize).
   *   - ratchetIndex/Count let the host place sub-hits inside the step.
   * The host multiplies `offset` by the seconds-per-16th to get real time.
   */
  DrumSequencer.prototype.eventsForStep = function (stepIndex) {
    var pat = this.pattern();
    var len = pat.length;
    var i = ((stepIndex % len) + len) % len;
    var out = [];

    // swing pushes every odd 16th later
    var swingOffset = (i % 2 === 1) ? this.swing * 0.5 : 0;

    var anySolo = false;
    for (var sv = 0; sv < this.numVoices; sv++) {
      if (this.voices[sv].solo) { anySolo = true; break; }
    }

    for (var v = 0; v < this.numVoices; v++) {
      var voice = this.voices[v];
      if (voice.mute) continue;
      if (anySolo && !voice.solo) continue;

      var st = pat.steps[v][i];
      if (!st.on) continue;
      if (st.prob < 1.0 && this.rng() > st.prob) continue;

      var rc = clamp(st.ratchet | 0, 1, 4);
      for (var r = 0; r < rc; r++) {
        var humTime = this.humanizeTime ? (this.rng() - 0.5) * this.humanizeTime * 0.5 : 0;
        var humVel = this.humanizeVel ? (this.rng() - 0.5) * this.humanizeVel : 0;
        var baseOffset = swingOffset + st.nudge + (r / rc); // ratchet spreads across the step
        out.push({
          voice: v,
          role: voice.role,
          sampleIndex: voice.sampleIndex,
          velocity: clamp(st.velocity + humVel, 0, 1),
          offset: clamp(baseOffset + humTime, -0.5, rc), // ratchets may exceed 0.5
          ratchetIndex: r,
          ratchetCount: rc
        });
      }
    }
    return out;
  };

  // ---- generative grooves --------------------------------------------------
  /*
   * Fill the current pattern with a BoC-leaning groove: laid-back kicks with a
   * little syncopation, backbeat snare with ghosts, swung hats with velocity
   * drift, and sparse probabilistic percussion. `density` 0..1 scales activity.
   * Voice roles are matched by name so it adapts if the layout changes.
   */
  DrumSequencer.prototype.generate = function (opts) {
    opts = opts || {};
    var density = typeof opts.density === 'number' ? opts.density : 0.5;
    var rng = this.rng;
    var pat = this.pattern();
    var len = pat.length;
    var self = this;

    function idx(role) {
      for (var i = 0; i < self.voices.length; i++) if (self.voices[i].role === role) return i;
      return -1;
    }
    function clear(v) {
      if (v < 0) return;
      for (var s = 0; s < len; s++) { var st = pat.steps[v][s]; st.on = false; st.ratchet = 1; st.prob = 1; st.nudge = 0; }
    }
    function put(v, s, props) { if (v < 0) return; var st = pat.steps[v][s % len]; st.on = true; for (var k in props) st[k] = props[k]; }
    function chance(p) { return rng() < p; }

    var K = idx('kick'), S = idx('snare'), HC = idx('hat_closed'), HO = idx('hat_open'),
        CL = idx('clap'), P1 = idx('perc1'), P2 = idx('perc2');
    [K, S, HC, HO, CL, P1, P2].forEach(clear);

    // kick: beat 1 always, beat ~3 usually, plus syncopated ghosts
    put(K, 0, { velocity: 0.95 });
    if (chance(0.85)) put(K, 8, { velocity: 0.85 });
    if (chance(0.5 + density * 0.3)) put(K, 10 + (chance(0.5) ? 1 : 0), { velocity: 0.7 });
    if (chance(0.3 + density * 0.3)) put(K, 6, { velocity: 0.6, prob: 0.7 });
    if (chance(0.25)) put(K, 3, { velocity: 0.55, prob: 0.6 });

    // snare: backbeats with optional ghost notes
    put(S, 4, { velocity: 0.85 });
    put(S, 12, { velocity: 0.88 });
    if (chance(0.4 + density * 0.4)) put(S, 7, { velocity: 0.35, prob: 0.5 });
    if (chance(0.3 + density * 0.4)) put(S, 14, { velocity: 0.3, prob: 0.4, ratchet: chance(0.4) ? 2 : 1 });
    if (chance(0.2)) put(CL, 12, { velocity: 0.5 }); // layer a clap on the 2nd backbeat

    // closed hats: 8ths or 16ths with velocity drift + a few drops
    var hatStep = chance(0.5) ? 2 : 1; // 8ths vs 16ths
    for (var s = 0; s < len; s += hatStep) {
      if (chance(0.12 - density * 0.05)) continue; // occasional gap
      put(HC, s, { velocity: 0.35 + rng() * 0.35, prob: chance(0.85) ? 1 : 0.75 });
    }
    if (chance(0.7)) put(HO, chance(0.5) ? 14 : 2, { velocity: 0.5 });

    // sparse found-sound percussion, probabilistic and occasionally ratcheted
    var percHits = 1 + Math.floor(density * 3);
    for (var n = 0; n < percHits; n++) {
      var v = chance(0.5) ? P1 : P2;
      put(v, Math.floor(rng() * len), { velocity: 0.3 + rng() * 0.3, prob: 0.4 + rng() * 0.4,
        ratchet: chance(0.25) ? (chance(0.5) ? 2 : 3) : 1 });
    }

    // a touch of human feel
    this.swing = 0.12 + rng() * 0.14;
    this.humanizeTime = 0.15 + rng() * 0.2;
    this.humanizeVel = 0.1 + rng() * 0.15;
    return this;
  };

  // ---- serialisation (for presets / Live set persistence) ------------------

  DrumSequencer.prototype.toJSON = function () {
    return {
      version: 1,
      voices: this.voices,
      patterns: this.patterns,
      current: this.current,
      chain: this.chain,
      swing: this.swing,
      humanizeTime: this.humanizeTime,
      humanizeVel: this.humanizeVel
    };
  };

  DrumSequencer.prototype.loadJSON = function (data) {
    if (!data) return;
    if (data.voices) this.voices = data.voices;
    if (data.patterns) this.patterns = data.patterns;
    if (data.current) this.current = data.current;
    if (data.chain) this.chain = data.chain;
    if (typeof data.swing === 'number') this.swing = data.swing;
    if (typeof data.humanizeTime === 'number') this.humanizeTime = data.humanizeTime;
    if (typeof data.humanizeVel === 'number') this.humanizeVel = data.humanizeVel;
  };

  return DrumSequencer;
});
