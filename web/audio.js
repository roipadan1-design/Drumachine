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

  async init() {
    if (this.ready) return;
    await Tone.start();
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
    await this.reverb.generate();
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

  // Built-in BoC-leaning synth voices (soft, filtered, a touch dusty).
  _makeSynth(role, out) {
    const T = Tone;
    switch (role) {
      case 'kick':
        return new T.MembraneSynth({ pitchDecay: 0.05, octaves: 6, envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.1 } }).connect(out);
      case 'snare': {
        const s = new T.NoiseSynth({ noise: { type: 'white' }, envelope: { attack: 0.001, decay: 0.18, sustain: 0 } });
        const body = new T.Filter({ type: 'bandpass', frequency: 1800, Q: 0.8 }).connect(out);
        s.connect(body);
        return s;
      }
      case 'clap':
        return new T.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.002, decay: 0.13, sustain: 0 } }).connect(out);
      case 'hat_closed':
        return new T.MetalSynth({ frequency: 320, envelope: { attack: 0.001, decay: 0.06, release: 0.01 }, harmonicity: 5.1, modulationIndex: 32, resonance: 7000, octaves: 1.5 }).connect(out);
      case 'hat_open':
        return new T.MetalSynth({ frequency: 320, envelope: { attack: 0.001, decay: 0.35, release: 0.1 }, harmonicity: 5.1, modulationIndex: 32, resonance: 6000, octaves: 1.5 }).connect(out);
      case 'perc1':
        return new T.MembraneSynth({ pitchDecay: 0.02, octaves: 4, envelope: { attack: 0.001, decay: 0.2, sustain: 0 } }).connect(out);
      case 'perc2':
        return new T.MetalSynth({ frequency: 200, envelope: { attack: 0.001, decay: 0.12, release: 0.02 }, harmonicity: 3.1, modulationIndex: 20, resonance: 3000, octaves: 1 }).connect(out);
      default: // fx / tom
        return new T.MembraneSynth({ pitchDecay: 0.1, octaves: 3, envelope: { attack: 0.002, decay: 0.5, sustain: 0 } }).connect(out);
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
    const detune = (def.pitch || 0) * 100;

    if (bank && bank[def.sampleIndex]) {
      this._ensurePlayer(voice, bank[def.sampleIndex].buffer);
      voice.player.volume.value = Tone.gainToDb(velocity);
      voice.player.playbackRate = Math.pow(2, (def.pitch || 0) / 12);
      voice.player.start(time);
    } else {
      const s = voice.synth;
      const dur = (0.12 + 0.5 * (def.decay || 1));
      if (s instanceof Tone.MembraneSynth) {
        const notes = { kick: 'C1', perc1: 'G2', fx: 'A1' };
        s.triggerAttackRelease(notes[def.role] || 'C2', dur, time, velocity);
      } else if (s instanceof Tone.MetalSynth) {
        s.triggerAttackRelease(dur, time, velocity);
      } else {
        s.triggerAttackRelease(dur, time, velocity);
      }
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
}

window.AudioEngine = AudioEngine;
