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

  // Elektron-style trig conditions: decide if a step fires on this loop pass.
  var CONDITIONS = ['always', '1:2', '2:2', '1:3', '1:4', '2:4', '3:4', '4:4', 'first', '!first', 'fill', '!fill'];
  function condMet(cond, loop, fill, rng) {
    switch (cond) {
      case undefined: case 'always': return true;
      case '1:2': return loop % 2 === 0;
      case '2:2': return loop % 2 === 1;
      case '1:3': return loop % 3 === 0;
      case '1:4': return loop % 4 === 0;
      case '2:4': return loop % 4 === 1;
      case '3:4': return loop % 4 === 2;
      case '4:4': return loop % 4 === 3;
      case 'first': return loop === 0;
      case '!first': return loop !== 0;
      case 'fill': return !!fill;
      case '!fill': return !fill;
      default: return true;
    }
  }

  function makeStep() {
    return {
      on: false,
      velocity: 1.0,   // 0..1
      prob: 1.0,       // 0..1 chance the step fires
      nudge: 0.0,      // -0.5..0.5 of a step (micro-timing)
      ratchet: 1,      // 1..4 sub-hits within the step
      pitch: 0,        // per-step pitch lock (semitones), added to the voice pitch
      reverse: false,  // per-step reverse lock (samples/slices)
      cond: 'always'   // trig condition (see CONDITIONS): evolving patterns
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
      length: NUM_STEPS, // per-track length 1..16 for polymeter (IDM phasing)
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
    this.fill = false;      // host sets true to trigger 'fill' conditioned steps

    this.rng = opts.rng || Math.random;
  }

  DrumSequencer.PATTERN_SLOTS = PATTERN_SLOTS;
  DrumSequencer.VOICE_DEFS = VOICE_DEFS;
  DrumSequencer.CONDITIONS = CONDITIONS;

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
  DrumSequencer.prototype.eventsForStep = function (absStep) {
    var nsteps = this.numSteps;
    var loop = Math.floor(absStep / nsteps); // which pass through the pattern (for conditions)
    var out = [];

    var anySolo = false;
    for (var sv = 0; sv < this.numVoices; sv++) {
      if (this.voices[sv].solo) { anySolo = true; break; }
    }

    var pat = this.pattern();
    for (var v = 0; v < this.numVoices; v++) {
      var voice = this.voices[v];
      if (voice.mute) continue;
      if (anySolo && !voice.solo) continue;

      // per-track length -> polymeter: each track wraps at its own length
      var vlen = clamp(voice.length || nsteps, 1, nsteps);
      var i = ((absStep % vlen) + vlen) % vlen;
      var vloop = Math.floor(absStep / vlen);

      var st = pat.steps[v][i];
      if (!st.on) continue;
      if (!condMet(st.cond, vloop, this.fill, this.rng)) continue;
      if (st.prob < 1.0 && this.rng() > st.prob) continue;

      // swing pushes every odd 16th later
      var swingOffset = (i % 2 === 1) ? this.swing * 0.5 : 0;
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
          pitch: st.pitch || 0,
          reverse: !!st.reverse,
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

  // ---- Euclidean rhythms ---------------------------------------------------
  /*
   * Distribute `pulses` hits as evenly as possible across the voice's length
   * (Bjorklund / Euclidean). `rotate` shifts the pattern. Classic IDM/world
   * rhythm generator — great for evolving, non-obvious grooves.
   */
  DrumSequencer.prototype.euclid = function (voice, pulses, rotate, velocity) {
    var steps = clamp(this.voices[voice].length || NUM_STEPS, 1, NUM_STEPS);
    pulses = clamp(pulses | 0, 0, steps);
    rotate = rotate | 0;
    var vel = (velocity == null) ? 0.85 : velocity;
    var arr = [];
    if (pulses > 0) {
      // bucket method: hit when the accumulated ratio rolls over
      var bucket = 0;
      for (var s = 0; s < steps; s++) {
        bucket += pulses;
        if (bucket >= steps) { bucket -= steps; arr.push(1); } else arr.push(0);
      }
    } else {
      for (var z = 0; z < steps; z++) arr.push(0);
    }
    var pat = this.pattern();
    for (var i = 0; i < steps; i++) {
      var src = ((i - rotate) % steps + steps) % steps;
      var st = pat.steps[voice][i];
      st.on = !!arr[src];
      if (st.on && st.velocity === 1.0) st.velocity = vel;
    }
    return this;
  };

  // ---- mutate (aleatoric evolution) ----------------------------------------
  /*
   * Nudge the current pattern: randomly toggles a few steps and jitters
   * velocity / pitch locks. `amount` 0..1 scales how much changes. Repeated
   * calls grow an evolving, IDM-style pattern from a seed.
   */
  DrumSequencer.prototype.mutate = function (amount) {
    amount = (amount == null) ? 0.3 : amount;
    var pat = this.pattern();
    for (var v = 0; v < this.numVoices; v++) {
      var len = clamp(this.voices[v].length || NUM_STEPS, 1, NUM_STEPS);
      for (var s = 0; s < len; s++) {
        var st = pat.steps[v][s];
        if (this.rng() < amount * 0.12) st.on = !st.on;             // flip a few steps
        if (st.on) {
          if (this.rng() < amount * 0.3) st.velocity = clamp(st.velocity + (this.rng() - 0.5) * 0.4, 0.15, 1);
          if (this.rng() < amount * 0.15) st.pitch = clamp((st.pitch || 0) + (this.rng() < 0.5 ? -1 : 1) * (1 + ((this.rng() * 5) | 0)), -12, 12);
          if (this.rng() < amount * 0.1) st.reverse = !st.reverse;
          if (this.rng() < amount * 0.08) st.ratchet = 1 + ((this.rng() * 3) | 0);
        }
      }
    }
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
