/*
 * BoC Drumachine — web audio layer (Tone.js)
 * --------------------------------------------------------------------------
 * The browser-side sound engine. Mirrors what the Max for Live device will do
 * natively. Each voice plays a user sample when one is loaded, otherwise falls
 * back to a built-in synthesised drum so the instrument makes sound on day one.
 *
 * Signal flow per voice:
 *   source -> pitch -> ampEnv -> filter -> drive -> [pan/vol] -> dryBus
 *                                                  \-> reverbSend -> reverb -> wetBus
 * Master "Dust" chain (the BoC character):
 *   busSum -> wow/flutter (pitch wobble) -> tape sat -> bitcrush
 *          -> + vinyl noise -> master LP -> out
 */

function clampN(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

class AudioEngine {
  constructor(seq) {
    this.seq = seq;
    this.ready = false;
    this.voices = [];          // per-voice node graphs
    this.buffers = {};         // role -> [Tone.ToneAudioBuffer] user samples
    this.slices = [];          // per-voice {buffer, offset, duration, fadeIn, fadeOut, role, pitch, gain, reverse}
    this.breakBuffer = null;   // the currently loaded reference loop
    this.referenceHits = null; // all auto-detected+classified hits (with role)
    this.markers = [];         // sorted slice-boundary times across the loop (chop grid)
    this._stepHandle = null;
    this.currentStep = 0;
    this.onStep = null;        // UI callback(stepIndex)
  }

  async init(opts) {
    opts = opts || {};
    if (this.ready) return;
    if (!opts.offline) await Tone.start();
    const T = Tone;

    // ---- master Dust chain (built output-first) --------------------------
    this.masterLP = new T.Filter({ type: 'lowpass', frequency: 18000, Q: 0.4 }).toDestination();

    // Bit reduction via a WaveShaper (amplitude quantisation). Tone's built-in
    // BitCrusher uses an AudioWorklet, which won't load from file:// and would
    // sever the master chain — this works everywhere. Curve set in setDust().
    this.bitcrush = new T.WaveShaper((x) => x, 2048).connect(this.masterLP);

    this.tapeSat = new T.Distortion({ distortion: 0.05, oversample: '2x' });
    this.tapeSat.wet.value = 0.15;
    this.tapeSat.connect(this.bitcrush);

    // wow & flutter = slow + fast pitch wobble, via a modulated delay
    this.flutter = new T.Vibrato({ frequency: 6, depth: 0, type: 'sine' });
    this.wow = new T.Vibrato({ frequency: 0.6, depth: 0, type: 'sine' });
    this.flutter.connect(this.tapeSat);
    this.wow.connect(this.flutter);

    this.busSum = new T.Gain(1).connect(this.wow);

    // vinyl hiss/crackle injected straight before the master LP
    this.vinyl = new T.Noise('pink').start();
    this.vinylGain = new T.Gain(0).connect(this.masterLP);
    this.vinylFilter = new T.Filter({ type: 'highpass', frequency: 1200 }).connect(this.vinylGain);
    this.vinyl.connect(this.vinylFilter);

    // dry + reverb buses both fold into busSum
    this.dryBus = new T.Gain(1).connect(this.busSum);
    this.reverb = new T.Reverb({ decay: 2.4, preDelay: 0.01, wet: 1 });
    // generating the IR runs its own offline render; skip when we're already
    // inside Tone.Offline (nested renders are unreliable). Sends default to 0.
    if (!opts.offline) await this.reverb.generate();
    this.reverb.connect(this.busSum);
    this.reverbInput = new T.Gain(1).connect(this.reverb);

    // dedicated player for auditioning slice regions (routes through the bus)
    this.auditionPlayer = new T.Player().connect(this.dryBus);

    // ---- per-voice graphs ------------------------------------------------
    for (let v = 0; v < this.seq.numVoices; v++) {
      this.voices.push(this._buildVoice(v));
    }

    this.ready = true;
  }

  _buildVoice(index) {
    const T = Tone;
    const role = this.seq.voices[index].role;

    const vol = new T.Gain(0.8);
    const pan = new T.Panner(0).connect(vol);
    const drive = new T.Distortion({ distortion: 0, oversample: '2x' });
    drive.wet.value = 0;
    drive.connect(pan);
    const filter = new T.Filter({ type: 'lowpass', frequency: 18000, Q: 0.7 }).connect(drive);

    // voice output splits to dry + reverb send
    const sendGain = new T.Gain(0);
    vol.connect(this.dryBus);
    vol.connect(sendGain);
    sendGain.connect(this.reverbInput);

    // one persistent sample player per voice, created in the current (possibly
    // offline) context. Buffer is (re)assigned per hit for samples/break slices.
    const player = new T.Player().connect(filter);
    player.fadeOut = 0.002; // tiny declick on retrigger

    return { index, role, vol, pan, drive, filter, sendGain, player, synth: this._makeSynth(role, filter) };
  }

  /*
   * Built-in BoC-leaning synth voices. Each returns an object with
   *   play(time, velocity, def)
   * so the trigger path is uniform and the character lives here. The aim is
   * soft, filtered and a touch detuned — nothing crisp or modern. Hats are
   * built from filtered noise (not MetalSynth) for a dustier, vintage top.
   */
  _makeSynth(role, out) {
    const T = Tone;
    // small, fixed pitch wobble so repeated hits aren't identical (tape-ish)
    const wob = (cents) => (Math.random() * 2 - 1) * cents;

    switch (role) {
      case 'kick': {
        const s = new T.MembraneSynth({ pitchDecay: 0.045, octaves: 4.5,
          oscillator: { type: 'sine' },
          envelope: { attack: 0.001, decay: 0.34, sustain: 0, release: 0.12 } }).connect(out);
        return { node: s, play: (t, v, d, p) => {
          const semis = p || 0;
          s.detune.setValueAtTime(wob(8), t);
          s.triggerAttackRelease(Tone.Frequency('C1').transpose(semis), 0.32, t, 0.85 * v + 0.1);
        }};
      }
      case 'snare': {
        // muffled body (bandpass noise) + a soft tonal thud underneath
        const noise = new T.NoiseSynth({ noise: { type: 'white' },
          envelope: { attack: 0.001, decay: 0.14, sustain: 0 } });
        const bp = new T.Filter({ type: 'bandpass', frequency: 1400, Q: 0.7 }).connect(out);
        const lp = new T.Filter({ type: 'lowpass', frequency: 3200 }).connect(bp);
        noise.connect(lp);
        const body = new T.MembraneSynth({ pitchDecay: 0.02, octaves: 2,
          envelope: { attack: 0.001, decay: 0.12, sustain: 0 } }).connect(out);
        body.volume.value = -10;
        return { node: noise, play: (t, v) => {
          noise.triggerAttackRelease(0.14, t, v);
          body.triggerAttackRelease('G2', 0.1, t, 0.5 * v);
        }};
      }
      case 'clap': {
        const s = new T.NoiseSynth({ noise: { type: 'pink' },
          envelope: { attack: 0.002, decay: 0.12, sustain: 0 } });
        const bp = new T.Filter({ type: 'bandpass', frequency: 1100, Q: 0.6 }).connect(out);
        s.connect(bp);
        return { node: s, play: (t, v) => s.triggerAttackRelease(0.12, t, v) };
      }
      case 'hat_closed':
      case 'hat_open': {
        const open = role === 'hat_open';
        const s = new T.NoiseSynth({ noise: { type: 'white' },
          envelope: { attack: 0.001, decay: open ? 0.32 : 0.045, sustain: 0, release: 0.02 } });
        const hp = new T.Filter({ type: 'highpass', frequency: 6500, Q: 0.5 }).connect(out);
        const lp = new T.Filter({ type: 'lowpass', frequency: 11000 }).connect(hp); // roll off the fizz
        s.connect(lp);
        s.volume.value = -8;
        return { node: s, play: (t, v) => s.triggerAttackRelease(open ? 0.3 : 0.05, t, v) };
      }
      case 'perc1': {
        const s = new T.MembraneSynth({ pitchDecay: 0.02, octaves: 3,
          envelope: { attack: 0.001, decay: 0.18, sustain: 0 } }).connect(out);
        return { node: s, play: (t, v, d, p) => {
          s.detune.setValueAtTime(wob(15) + (p || 0) * 100, t);
          s.triggerAttackRelease('G3', 0.16, t, v);
        }};
      }
      case 'perc2': {
        // soft mid woodblock-ish: short bandpass noise + tonal click
        const noise = new T.NoiseSynth({ noise: { type: 'pink' },
          envelope: { attack: 0.001, decay: 0.07, sustain: 0 } });
        const bp = new T.Filter({ type: 'bandpass', frequency: 2400, Q: 1.4 }).connect(out);
        noise.connect(bp);
        return { node: noise, play: (t, v) => noise.triggerAttackRelease(0.07, t, v) };
      }
      default: { // fx / tom — low, hollow
        const s = new T.MembraneSynth({ pitchDecay: 0.08, octaves: 2.5,
          envelope: { attack: 0.002, decay: 0.5, sustain: 0 } }).connect(out);
        return { node: s, play: (t, v, d, p) => {
          const semis = p || 0;
          s.triggerAttackRelease(Tone.Frequency('A1').transpose(semis), 0.45, t, v);
        }};
      }
    }
  }

  // ---- sample handling ---------------------------------------------------
  async loadSampleFromFile(role, file) {
    const url = URL.createObjectURL(file);
    const buf = new Tone.ToneAudioBuffer();
    await buf.load(url);
    if (!this.buffers[role]) this.buffers[role] = [];
    this.buffers[role].push({ name: file.name, buffer: buf });
    URL.revokeObjectURL(url);
    return this.buffers[role].length - 1;
  }

  async loadSampleFromURL(role, url, name) {
    const buf = new Tone.ToneAudioBuffer();
    await buf.load(url);
    if (!this.buffers[role]) this.buffers[role] = [];
    this.buffers[role].push({ name: name || url.split('/').pop(), buffer: buf });
    return this.buffers[role].length - 1;
  }

  /*
   * Auto-load sample banks listed in samples/manifest.json, shaped as
   *   { "kick": ["kick_a.wav", ...], "snare": [...], ... }
   * Returns { loaded, byRole }. Missing manifest or files are non-fatal so the
   * synth fallbacks simply remain in place.
   */
  async loadManifest(basePath) {
    basePath = basePath || '../samples';
    let manifest;
    try {
      const res = await fetch(basePath + '/manifest.json', { cache: 'no-store' });
      if (!res.ok) return { loaded: 0, byRole: {} };
      manifest = await res.json();
    } catch (e) { return { loaded: 0, byRole: {}, error: String(e) }; }

    let loaded = 0; const byRole = {};
    for (const role of Object.keys(manifest)) {
      const files = manifest[role] || [];
      for (const file of files) {
        try {
          await this.loadSampleFromURL(role, basePath + '/' + role + '/' + encodeURIComponent(file), file);
          loaded++; byRole[role] = (byRole[role] || 0) + 1;
        } catch (e) { /* skip unreadable file, keep going */ }
      }
    }
    return { loaded, byRole };
  }

  // ---- break chopping ----------------------------------------------------
  /*
   * Find slice points in a buffer. mode 'transient' uses energy-onset
   * detection on a mono mixdown (falling back to equal division when it can't
   * find enough hits); mode 'equal' just divides the length evenly.
   * Returns [{ offset, duration }] in seconds.
   */
  static sliceBuffer(audioBuffer, numSlices, mode, threshFrac) {
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const dur = len / sr;

    const equal = () => {
      const out = []; const step = dur / numSlices;
      for (let i = 0; i < numSlices; i++) out.push({ offset: i * step, duration: step });
      return out;
    };
    if (mode === 'equal') return equal();

    const data = audioBuffer.getChannelData(0);
    const win = Math.max(1, Math.floor(sr * 0.01));   // 10ms RMS window
    const hop = Math.max(1, Math.floor(sr * 0.005));  // 5ms hop
    const env = [];
    for (let i = 0; i + win < len; i += hop) {
      let s = 0; for (let j = 0; j < win; j++) { const v = data[i + j]; s += v * v; }
      env.push({ t: i / sr, e: Math.sqrt(s / win) });
    }
    if (!env.length) return equal();
    let peak = 0; for (const o of env) if (o.e > peak) peak = o.e;
    if (peak <= 0) return equal();

    const thresh = peak * (threshFrac || 0.18);
    const minGap = 0.04; // min gap between onsets
    const onsets = []; let last = -minGap;
    for (let i = 1; i < env.length; i++) {
      if (env[i].e > thresh && env[i - 1].e <= thresh && env[i].t - last > minGap) {
        onsets.push(env[i].t); last = env[i].t;
      }
    }
    if (onsets.length < 2) return equal();

    // a break should start at its beginning; the detector can't see a rising
    // edge at t=0 (no preceding silence), so anchor the first slice there.
    if (onsets[0] > 0.02) onsets.unshift(0);

    let pts = onsets;
    if (pts.length > numSlices) pts = pts.slice(0, numSlices); // keep the first N hits
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const start = pts[i];
      const end = (i + 1 < pts.length) ? pts[i + 1] : dur;
      out.push({ offset: start, duration: end - start });
    }
    return out;
  }

  // Chop a break and map slices across the voices (slice i -> voice i).
  _applyBreak(buf, opts) {
    opts = opts || {};
    const numSlices = opts.numSlices || this.seq.numVoices;
    const mode = opts.mode || 'transient';
    const slices = AudioEngine.sliceBuffer(buf.get(), numSlices, mode);
    this.breakBuffer = buf;
    this.slices = [];
    for (let v = 0; v < this.seq.numVoices; v++) {
      const sl = slices.length ? slices[v % slices.length] : null;
      this.slices[v] = sl ? { buffer: buf, offset: sl.offset, duration: sl.duration } : null;
    }
    return { slices: slices.length, sliceTimes: slices };
  }

  async loadBreakFromURL(url, opts) {
    const buf = new Tone.ToneAudioBuffer();
    await buf.load(url);
    return this._applyBreak(buf, opts);
  }

  async loadBreakFromFile(file, opts) {
    const url = URL.createObjectURL(file);
    const buf = new Tone.ToneAudioBuffer();
    await buf.load(url);
    URL.revokeObjectURL(url);
    return this._applyBreak(buf, opts);
  }

  clearBreak() { this.slices = []; this.breakBuffer = null; this.referenceHits = null; this.markers = []; }

  // ---- one-shot extraction (classify a break's hits into role banks) -----
  static _onePoleLP(data, sr, fc) {
    const rc = 1 / (2 * Math.PI * fc), dt = 1 / sr, a = dt / (rc + dt);
    const y = new Float32Array(data.length); let prev = 0;
    for (let i = 0; i < data.length; i++) { prev = prev + a * (data[i] - prev); y[i] = prev; }
    return y;
  }

  // Decide a role from coarse band balance + noisiness (zero-crossing rate).
  static classifyHit(f, dur) {
    const total = f.low + f.mid + f.high + 1e-9;
    const lr = f.low / total, mr = f.mid / total, hr = f.high / total;
    // kick: low energy dominates and it's tonal (few zero crossings)
    if (lr > 0.45 && f.zcr < 0.08) return 'kick';
    // hats / cymbals: high band dominates or very noisy; length splits closed/open
    if (hr > 0.4 || f.zcr > 0.17) return dur > 0.16 ? 'hat_open' : 'hat_closed';
    // clap: noisy + mid-heavy but not as bright as a hat
    if (mr > 0.3 && f.zcr > 0.1 && hr > 0.2) return 'clap';
    // snare: mid-dominant body
    if (mr > 0.34) return 'snare';
    // leftover low-ish hits -> toms/perc
    if (lr >= hr) return 'perc1';
    return 'perc2';
  }

  /*
   * Detect every hit in a buffer and classify each. Returns
   *   [{ offset, duration, role, peak, low, mid, high, zcr }]
   * sorted by time. Shared by extractOneShots() and loadReference().
   */
  static analyzeHits(ab) {
    const sr = ab.sampleRate;
    const data = ab.getChannelData(0);
    const hits = AudioEngine.sliceBuffer(ab, 999, 'transient');
    const lp150 = AudioEngine._onePoleLP(data, sr, 150);
    const lp1500 = AudioEngine._onePoleLP(data, sr, 1500);
    const lp6000 = AudioEngine._onePoleLP(data, sr, 6000);
    return hits.map((h) => {
      const s0 = Math.floor(h.offset * sr);
      const aEnd = Math.min(data.length, s0 + Math.floor(0.06 * sr)); // 60ms body
      let low = 0, mid = 0, high = 0, zc = 0, peak = 0; const nn = Math.max(1, aEnd - s0);
      for (let i = s0; i < aEnd; i++) {
        const lo = lp150[i], md = lp1500[i] - lp150[i], hi = data[i] - lp6000[i];
        low += lo * lo; mid += md * md; high += hi * hi;
        const a = Math.abs(data[i]); if (a > peak) peak = a;
        if (i > s0 && ((data[i] >= 0) !== (data[i - 1] >= 0))) zc++;
      }
      const f = { low: Math.sqrt(low / nn), mid: Math.sqrt(mid / nn), high: Math.sqrt(high / nn), zcr: zc / nn };
      return { offset: h.offset, duration: h.duration, role: AudioEngine.classifyHit(f, h.duration), peak, ...f };
    });
  }

  /*
   * Load a reference loop, auto-detect + classify its hits, and assign the
   * loudest hit of each role to the matching voice as a slice (with fades).
   * Keeps the full hit list + buffer for the waveform editor. Each voice then
   * plays its detected kick / snare / hat etc. Returns { hits, byRole }.
   */
  _applyReference(buf, sensitivity) {
    const ab = buf.get();
    this.breakBuffer = buf;
    this.referenceHits = AudioEngine.analyzeHits(ab);
    this.detectMarkers(sensitivity == null ? 0.5 : sensitivity);
    this.autoAssign();
    const counts = {}; for (const h of this.referenceHits) counts[h.role] = (counts[h.role] || 0) + 1;
    return { hits: this.referenceHits, byRole: counts, markers: this.markers.length - 1 };
  }

  // Build the chop grid (slice boundaries) from transient detection.
  // sensitivity 0..1 — higher finds more, quieter onsets.
  detectMarkers(sensitivity) {
    if (!this.breakBuffer) return;
    const ab = this.breakBuffer.get();
    const dur = ab.duration;
    const threshold = 0.05 + (1 - clampN(sensitivity, 0, 1)) * 0.4; // 0.05..0.45 of peak
    const hits = AudioEngine.sliceBuffer(ab, 999, 'transient', threshold);
    const ts = hits.map((h) => h.offset).filter((t) => t > 0.005);
    this.markers = [0].concat(ts).concat([dur]);
    this._dedupeMarkers();
  }

  _dedupeMarkers() {
    this.markers.sort((a, b) => a - b);
    const out = []; for (const t of this.markers) { if (!out.length || t - out[out.length - 1] > 0.012) out.push(t); }
    this.markers = out;
  }

  regionCount() { return Math.max(0, this.markers.length - 1); }
  region(i) { return { offset: this.markers[i], duration: this.markers[i + 1] - this.markers[i] }; }

  // role label for a region = classification of its strongest detected hit inside it
  regionRole(i) {
    const r = this.region(i); let best = null;
    for (const h of (this.referenceHits || [])) {
      if (h.offset >= r.offset - 0.005 && h.offset < r.offset + r.duration) {
        if (!best || h.peak > best.peak) best = h;
      }
    }
    return best ? best.role : 'perc1';
  }

  addMarker(t) { this.markers.push(t); this._dedupeMarkers(); }
  removeMarker(i) { if (i > 0 && i < this.markers.length - 1) this.markers.splice(i, 1); }
  moveMarker(i, t) {
    if (i <= 0 || i >= this.markers.length - 1) return;
    const lo = this.markers[i - 1] + 0.012, hi = this.markers[i + 1] - 0.012;
    this.markers[i] = clampN(t, lo, hi);
  }

  // Snapshot a region as the slice played by voice v (with default per-slice params).
  assignRegionToVoice(regionIndex, v) {
    const r = this.region(regionIndex);
    this.slices[v] = {
      buffer: this.breakBuffer, offset: r.offset, duration: r.duration,
      fadeIn: 0.001, fadeOut: 0.012, role: this.regionRole(regionIndex),
      pitch: 0, gain: 1, reverse: false
    };
    this._refreshReverse(this.slices[v]);
  }

  // Auto-assign the loudest region of each role to the matching voice.
  autoAssign() {
    this.slices = [];
    const byRole = {};
    for (let i = 0; i < this.regionCount(); i++) {
      const role = this.regionRole(i);
      const r = this.region(i);
      let peak = 0; const h = (this.referenceHits || []).find((x) => x.offset >= r.offset - 0.005 && x.offset < r.offset + r.duration);
      if (h) peak = h.peak;
      (byRole[role] = byRole[role] || []).push({ i, peak });
    }
    for (const role in byRole) byRole[role].sort((a, b) => b.peak - a.peak);
    for (let v = 0; v < this.seq.numVoices; v++) {
      const role = this.seq.voices[v].role;
      const pick = byRole[role] && byRole[role][0];
      if (pick) this.assignRegionToVoice(pick.i, v); else this.slices[v] = null;
    }
  }

  async loadReferenceFromFile(file) {
    const url = URL.createObjectURL(file);
    const buf = new Tone.ToneAudioBuffer();
    await buf.load(url);
    URL.revokeObjectURL(url);
    return this._applyReference(buf);
  }
  async loadReferenceFromURL(url) {
    const buf = new Tone.ToneAudioBuffer();
    await buf.load(url);
    return this._applyReference(buf);
  }

  // Build/cache a reversed copy of a slice's region (always, so per-step
  // reverse locks can flip direction independent of the slice's own setting).
  _refreshReverse(slice) {
    if (!slice) return;
    const ab = slice.buffer.get();
    const sr = ab.sampleRate, nch = ab.numberOfChannels;
    const s0 = Math.floor(slice.offset * sr), len = Math.max(1, Math.floor(slice.duration * sr));
    const out = Tone.getContext().createBuffer(nch, len, sr);
    for (let c = 0; c < nch; c++) {
      const src = ab.getChannelData(c), dst = out.getChannelData(c);
      for (let i = 0; i < len; i++) dst[i] = src[Math.min(src.length - 1, s0 + (len - 1 - i))];
    }
    slice._revBuffer = new Tone.ToneAudioBuffer(out);
  }

  // Audition an arbitrary region (not necessarily assigned) through the master bus.
  auditionRegion(regionIndex, time) {
    if (!this.breakBuffer || !this.auditionPlayer) return;
    const r = this.region(regionIndex);
    const pl = this.auditionPlayer;
    pl.buffer = this.breakBuffer; pl.fadeIn = 0.001; pl.fadeOut = 0.01;
    pl.start(time != null ? time : Tone.now() + 0.02, r.offset, r.duration);
  }

  // Copy the auto-classified hits into per-role sample banks (durable one-shots).
  extractOneShots(opts) {
    opts = opts || {};
    const maxPerRole = opts.maxPerRole || 6;
    if (!this.breakBuffer) return null;
    const ab = this.breakBuffer.get();
    const sr = ab.sampleRate, nch = ab.numberOfChannels;
    const hits = this.referenceHits || AudioEngine.analyzeHits(ab);

    if (opts.reset) this.buffers = {};
    const summary = {};
    for (const h of hits) {
      const role = h.role;
      if (!this.buffers[role]) this.buffers[role] = [];
      if (this.buffers[role].length >= maxPerRole) continue;
      const dur = Math.min(h.duration, 0.5);
      const len = Math.max(1, Math.floor(dur * sr));
      const s0 = Math.floor(h.offset * sr);
      const out = Tone.getContext().createBuffer(nch, len, sr);
      for (let c = 0; c < nch; c++) {
        const src = ab.getChannelData(c), dst = out.getChannelData(c);
        for (let i = 0; i < len && s0 + i < src.length; i++) dst[i] = src[s0 + i];
      }
      this.buffers[role].push({ name: role + '_' + (this.buffers[role].length + 1), buffer: new Tone.ToneAudioBuffer(out) });
      summary[role] = (summary[role] || 0) + 1;
    }
    for (let v = 0; v < this.seq.numVoices; v++) this.seq.voices[v].sampleIndex = 0;
    this.clearBreak();
    return summary;
  }

  // ---- triggering --------------------------------------------------------
  // ev (optional): per-step locks { pitch, reverse } from the sequencer.
  trigger(voiceIndex, time, velocity, ev) {
    const voice = this.voices[voiceIndex];
    const def = this.seq.voices[voiceIndex];
    const bank = this.buffers[def.role];
    const slice = this.slices[voiceIndex];
    const lockPitch = ev && ev.pitch || 0;
    const lockRev = !!(ev && ev.reverse);

    // priority: user one-shot for this role > break slice > built-in synth
    let buf = null, offset = 0, duration = null, fadeIn = 0, fadeOut = 0.003;
    let pitch = (def.pitch || 0) + lockPitch, gain = 1;
    if (bank && bank[def.sampleIndex]) buf = bank[def.sampleIndex].buffer;
    else if (slice) {
      const rev = (!!slice.reverse) !== lockRev; // XOR: per-step lock flips it
      if (rev && slice._revBuffer) { buf = slice._revBuffer; offset = 0; duration = slice.duration; }
      else { buf = slice.buffer; offset = slice.offset; duration = slice.duration; }
      fadeIn = slice.fadeIn || 0; fadeOut = slice.fadeOut || 0;
      pitch += slice.pitch || 0; gain = slice.gain == null ? 1 : slice.gain;
    }

    if (buf) {
      const pl = voice.player;
      if (pl.buffer !== buf) pl.buffer = buf;
      pl.fadeIn = fadeIn; pl.fadeOut = fadeOut;
      pl.playbackRate = Math.pow(2, pitch / 12);
      pl.volume.value = Tone.gainToDb(Math.max(0.0001, velocity * gain));
      // a single persistent Player rejects non-increasing start times; nudge by
      // a sub-millisecond so colliding ratchet/humanized hits still fire.
      const t = Math.max(time, (voice._lastStart || 0) + 0.0006);
      voice._lastStart = t;
      if (duration != null) pl.start(t, offset, duration);
      else pl.start(t, offset);
    } else {
      voice.synth.play(time, velocity, def, pitch);
    }

    // choke groups: cut other voices sharing the group
    if (def.chokeGroup) {
      for (let i = 0; i < this.voices.length; i++) {
        if (i === voiceIndex) continue;
        if (this.seq.voices[i].chokeGroup === def.chokeGroup) {
          try { this.voices[i].player.stop(time); } catch (e) { /* not playing */ }
        }
      }
    }
  }

  // ---- transport ---------------------------------------------------------
  start() {
    if (this._stepHandle !== null) return;
    this.absStep = 0;
    this.voices.forEach((v) => { v._lastStart = 0; });
    const sixteenth = Tone.Time('16n').toSeconds();
    const nsteps = this.seq.numSteps;
    this._stepHandle = Tone.Transport.scheduleRepeat((time) => {
      const abs = this.absStep;
      if (abs % nsteps === 0) this.seq.advanceChain();
      const events = this.seq.eventsForStep(abs);
      for (const ev of events) {
        this.trigger(ev.voice, time + ev.offset * sixteenth, ev.velocity, ev);
      }
      const local = abs % nsteps;
      if (this.onStep) Tone.Draw.schedule(() => this.onStep(local), time);
      this.absStep = abs + 1;
    }, '16n');
    Tone.Transport.start();
  }

  stop() {
    if (this._stepHandle !== null) {
      Tone.Transport.clear(this._stepHandle);
      this._stepHandle = null;
    }
    Tone.Transport.stop();
    if (this.onStep) this.onStep(-1);
  }

  setBPM(bpm) { Tone.Transport.bpm.value = bpm; }

  // ---- parameter routing -------------------------------------------------
  applyVoiceParams(index) {
    const def = this.seq.voices[index];
    const voice = this.voices[index];
    voice.vol.gain.rampTo(def.mute ? 0 : def.volume, 0.02);
    voice.pan.pan.rampTo(def.pan, 0.02);
    voice.sendGain.gain.rampTo(def.reverbSend, 0.05);
    voice.drive.wet.value = def.drive > 0 ? 1 : 0;
    voice.drive.distortion = def.drive;
    if (def.filterType === 'off') {
      voice.filter.type = 'allpass';
    } else {
      voice.filter.type = def.filterType === 'hp' ? 'highpass' : 'lowpass';
      const f = def.filterType === 'hp'
        ? 40 + def.filterFreq * 4000
        : 200 + def.filterFreq * 17800;
      voice.filter.frequency.rampTo(f, 0.05);
    }
  }

  setDust(params) {
    if ('wow' in params) this.wow.depth.value = params.wow;            // 0..1
    if ('flutter' in params) this.flutter.depth.value = params.flutter; // 0..1
    if ('tape' in params) this.tapeSat.wet.value = params.tape;
    if ('crush' in params) {
      if (params.crush <= 0) {
        this.bitcrush.setMap((x) => x, 2048);                 // transparent
      } else {
        const bits = Math.max(2, Math.round(16 - params.crush * 12)); // 16 -> ~2 bits
        const levels = Math.pow(2, bits - 1);
        this.bitcrush.setMap((x) => Math.round(x * levels) / levels, 2048);
      }
    }
    if ('vinyl' in params) this.vinylGain.gain.rampTo(params.vinyl * 0.08, 0.1);
    if ('masterLP' in params) {
      this.masterLP.frequency.rampTo(400 + params.masterLP * 17600, 0.1);
    }
  }

  // ---- offline rendering (for demo bounces) ------------------------------
  /*
   * Render `bars` of the current sequencer state to a WAV. Runs the exact same
   * voice + Dust graph as live playback, just inside Tone.Offline, so a demo
   * bounce reflects what the instrument actually sounds like.
   * Returns a Blob (audio/wav).
   */
  static async renderToWavBlob(seq, opts) {
    opts = opts || {};
    const bpm = opts.bpm || 86;
    const bars = opts.bars || 2;
    const dust = Object.assign({}, AudioEngine.DEFAULT_DUST, opts.dust || {});
    const secPerBar = (60 / bpm) * 4;
    const seconds = bars * secPerBar + 1.2; // tail

    // Pre-load the break OUTSIDE Tone.Offline. Any `await` inside the offline
    // callback lets the global context revert before render() runs, which
    // silently breaks sample playback — so the callback below is synchronous.
    let breakBuf = null;
    if (opts.breakURL) { breakBuf = new Tone.ToneAudioBuffer(); await breakBuf.load(opts.breakURL); }

    const buffer = await Tone.Offline(() => {
      const eng = new AudioEngine(seq);
      eng.init({ offline: true });            // synchronous in offline mode (no awaits hit)
      if (breakBuf) eng._applyBreak(breakBuf, opts.breakOpts);
      for (let v = 0; v < seq.numVoices; v++) eng.applyVoiceParams(v);
      eng.setDust(dust);

      Tone.Transport.cancel(0);
      Tone.Transport.stop();
      Tone.Transport.position = 0;
      Tone.Transport.bpm.value = bpm;
      const sixteenth = Tone.Time('16n').toSeconds();
      const nsteps = seq.numSteps;
      let abs = 0;
      Tone.Transport.scheduleRepeat((time) => {
        if (abs % nsteps === 0) seq.advanceChain();
        seq.eventsForStep(abs).forEach((ev) =>
          eng.trigger(ev.voice, time + ev.offset * sixteenth, ev.velocity, ev));
        abs = abs + 1;
      }, '16n');
      Tone.Transport.start();
    }, seconds, 2, 44100);

    return AudioEngine.encodeWAV(buffer.get());
  }

  // Minimal 16-bit PCM WAV encoder. `audioBuffer` is a native AudioBuffer.
  static encodeWAV(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const sr = audioBuffer.sampleRate;
    const len = audioBuffer.length;
    const blockAlign = numCh * 2;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    let p = 0;
    const ws = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
    const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
    const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };
    ws('RIFF'); u32(36 + dataSize); ws('WAVE'); ws('fmt '); u32(16); u16(1);
    u16(numCh); u32(sr); u32(sr * blockAlign); u16(blockAlign); u16(16);
    ws('data'); u32(dataSize);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true); p += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }
}

// Sensible day-one Dust settings so the instrument sounds characterful at boot.
AudioEngine.DEFAULT_DUST = { wow: 0.18, flutter: 0.12, tape: 0.3, crush: 0.15, vinyl: 0.25, masterLP: 0.82 };

if (typeof window !== 'undefined') window.AudioEngine = AudioEngine;
