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

class AudioEngine {
  constructor(seq) {
    this.seq = seq;
    this.ready = false;
    this.voices = [];          // per-voice node graphs
    this.buffers = {};         // role -> [Tone.ToneAudioBuffer] user samples
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

    this.bitcrush = new T.BitCrusher({ bits: 16 });
    this.bitcrush.wet.value = 0;                 // off until dialed in
    this.bitcrush.connect(this.masterLP);

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

    return { index, role, vol, pan, drive, filter, sendGain, player: null, synth: this._makeSynth(role, filter) };
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
        return { node: s, play: (t, v, d) => {
          const semis = (d && d.pitch) || 0;
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
        return { node: s, play: (t, v) => {
          s.detune.setValueAtTime(wob(15), t);
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
        return { node: s, play: (t, v, d) => {
          const semis = (d && d.pitch) || 0;
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

  _ensurePlayer(voice, buffer) {
    if (voice.player) voice.player.dispose();
    voice.player = new Tone.Player(buffer).connect(voice.filter);
  }

  // ---- triggering --------------------------------------------------------
  trigger(voiceIndex, time, velocity) {
    const voice = this.voices[voiceIndex];
    const def = this.seq.voices[voiceIndex];
    const bank = this.buffers[def.role];

    if (bank && bank[def.sampleIndex]) {
      this._ensurePlayer(voice, bank[def.sampleIndex].buffer);
      voice.player.volume.value = Tone.gainToDb(velocity);
      voice.player.playbackRate = Math.pow(2, (def.pitch || 0) / 12);
      voice.player.start(time);
    } else {
      // uniform synth interface: each voice knows how to play itself
      voice.synth.play(time, velocity, def);
    }
    // choke groups: cut other voices in the same group
    if (def.chokeGroup) {
      for (let i = 0; i < this.voices.length; i++) {
        if (i === voiceIndex) continue;
        if (this.seq.voices[i].chokeGroup === def.chokeGroup && this.voices[i].player) {
          this.voices[i].player.stop(time);
        }
      }
    }
  }

  // ---- transport ---------------------------------------------------------
  start() {
    if (this._stepHandle !== null) return;
    this.currentStep = 0;
    const sixteenth = Tone.Time('16n').toSeconds();
    this._stepHandle = Tone.Transport.scheduleRepeat((time) => {
      const i = this.currentStep;
      if (i === 0) this.seq.advanceChain();
      const events = this.seq.eventsForStep(i);
      for (const ev of events) {
        this.trigger(ev.voice, time + ev.offset * sixteenth, ev.velocity);
      }
      if (this.onStep) Tone.Draw.schedule(() => this.onStep(i), time);
      this.currentStep = (i + 1) % this.seq.numSteps;
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
      this.bitcrush.wet.value = params.crush > 0 ? 1 : 0;
      this.bitcrush.bits.value = Math.round(16 - params.crush * 12); // 16 -> 4 bits
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

    const buffer = await Tone.Offline(async () => {
      const eng = new AudioEngine(seq);
      await eng.init({ offline: true });
      for (let v = 0; v < seq.numVoices; v++) eng.applyVoiceParams(v);
      eng.setDust(dust);

      // clear any transport state left over from a previous render in this page
      Tone.Transport.cancel(0);
      Tone.Transport.stop();
      Tone.Transport.position = 0;
      Tone.Transport.bpm.value = bpm;
      const sixteenth = Tone.Time('16n').toSeconds();
      let step = 0;
      Tone.Transport.scheduleRepeat((time) => {
        const i = step;
        if (i === 0) seq.advanceChain();
        seq.eventsForStep(i).forEach((ev) =>
          eng.trigger(ev.voice, time + ev.offset * sixteenth, ev.velocity));
        step = (i + 1) % seq.numSteps;
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
