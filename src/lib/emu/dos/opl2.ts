/**
 * OPL2 (YM3812) FM synthesis emulation.
 *
 * Emulates the AdLib-compatible FM chip at ports 0x388-0x389.
 * 9 channels, 18 operators, 4 waveforms, envelope generation with
 * attack/decay/sustain/release, feedback, FM/additive connection modes,
 * tremolo (AM), vibrato, KSL, EG type, percussion mode, and CSM.
 */

const OPL_RATE = 49716; // OPL2 native sample rate
const NUM_CHANNELS = 9;
const NUM_OPERATORS = 18;

// Operator index within a channel: channel i → operators [CH_OP[i][0], CH_OP[i][1]]
const CH_OP: [number, number][] = [
  [0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17],
];

// Register offset → operator index mapping
const OP_OFFSET = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];

// Multiplier table
const MULTI = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

// Sine table (10-bit, 1024 entries, output = 0..8191 representing -log2 attenuation)
const SINE_TABLE = new Float64Array(1024);
for (let i = 0; i < 1024; i++) {
  SINE_TABLE[i] = Math.sin((i + 0.5) * Math.PI / 512);
}

// FM modulation depth: operator output ±1 maps to ±MOD_DEPTH cycles of phase shift.
// Real OPL2: ~4 cycles at max volume. This determines timbre richness.
const MOD_DEPTH = 4.0;

// OPL2 envelope rate system: the 4-bit register value is combined with the
// octave (block) and F-number to get an "effective rate" (0-63). The effective
// rate indexes into 64-entry timing tables.
//
// effectiveRate = min(63, registerRate * 4 + Rof)
// where Rof = (block*2 + fnum_bit) >> (KSR ? 0 : 2)
//
// Attack: time (ms) from max attenuation to zero. Grouped in fours — each
// group has the same base time, with sub-rates giving slight variation.
// Values derived from YM3812 application manual and die analysis.
const ATTACK_TIMES = new Float64Array(64);
const DECAY_TIMES = new Float64Array(64);
// Rate 0-3: infinity (envelope frozen)
for (let i = 0; i < 4; i++) { ATTACK_TIMES[i] = Infinity; DECAY_TIMES[i] = Infinity; }
// Rates 4-63: each group of 4 halves the time from the previous group
// Base time at rate 4: attack ~2826ms, decay ~39280ms (from OPL2 datasheet)
for (let i = 4; i < 64; i++) {
  const group = i >> 2;            // which group (1-15)
  const sub = i & 3;              // position within group (0-3)
  const groupScale = Math.pow(2, -(group - 1)); // halves each group
  // Sub-rate scaling: 0=base, 1=~91.7%, 2=~83.3%, 3=~75%
  const subScale = 1 - sub / 12;
  ATTACK_TIMES[i] = 2826 * groupScale * subScale;
  DECAY_TIMES[i] = 39280 * groupScale * subScale;
}
// Rates 60-63: instant (effectively zero time)
for (let i = 60; i < 64; i++) { ATTACK_TIMES[i] = 0; DECAY_TIMES[i] = 0; }

// ---- KSL (Key Scale Level) ----

// KSL ROM table (from OPL2 die analysis, indexed by fnum bits 9-6)
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];

// KSL shift amounts indexed by register bits (D7:D6 of reg 0x40):
//   0 (00) = 0 dB/oct    → shift 31 (effectively 0)
//   1 (01) = 3.0 dB/oct  → shift 1
//   2 (10) = 1.5 dB/oct  → shift 2
//   3 (11) = 6.0 dB/oct  → shift 0
const KSL_SHIFT = [31, 1, 2, 0];

// ---- LFO frequencies ----

// Tremolo (AM): ~3.7 Hz triangle wave
const TREMOLO_FREQ = OPL_RATE / 13432;
// Vibrato: ~6.1 Hz triangle wave
const VIBRATO_FREQ = OPL_RATE / 8192;

// ---- Operator state ----

const ENV_OFF = 0;
const ENV_ATTACK = 1;
const ENV_DECAY = 2;
const ENV_SUSTAIN = 3;
const ENV_RELEASE = 4;

interface OpState {
  phase: number;          // 0..1 accumulator
  envLevel: number;       // 0 = max volume, 1 = silent
  envState: number;       // ENV_*
  feedback0: number;      // previous output for feedback
  feedback1: number;      // previous-previous output for feedback
}

// ---- OPL2 Emulator ----

export class OPL2 {
  private regs = new Uint8Array(256);
  private regIndex = 0; // address latch
  private ops: OpState[] = [];
  private sampleRate: number;
  private outputBuf: Float32Array;
  private bufPos = 0;
  private accumPhase = 0; // fractional resampling accumulator

  // Global LFO state
  private tremoloPhase = 0;   // 0..1 triangle at ~3.7 Hz
  private vibratoPhase = 0;   // 0..1 triangle at ~6.1 Hz
  private noiseRNG = 1;       // 23-bit LFSR for percussion noise

  // Timer state
  private timer1Value = 0;
  private timer2Value = 0;
  private timer1Start = 0;  // performance.now() when timer started
  private timer2Start = 0;
  private timer1Running = false;
  private timer2Running = false;
  private timer1Expired = false;
  private timer2Expired = false;
  private timer1Mask = false;
  private timer2Mask = false;
  private timer1IRQFired = false; // track if IRQ already fired for this timer cycle
  private timer2IRQFired = false;

  /** Callback fired when an OPL2 timer expires (triggers hardware IRQ 7). */
  onTimerIRQ: () => void = () => {};

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.outputBuf = new Float32Array(4096);
    for (let i = 0; i < NUM_OPERATORS; i++) {
      this.ops.push({ phase: 0, envLevel: 1, envState: ENV_OFF, feedback0: 0, feedback1: 0 });
    }
  }

  /** Update the output sample rate (preserves all register/operator state). */
  setSampleRate(rate: number): void { this.sampleRate = rate; }

  writeAddr(val: number): void { this.regIndex = val & 0xFF; }

  /** Check timer expiry and fire hardware IRQ if newly expired. */
  tickTimers(): void {
    const now = performance.now();
    if (this.timer1Running && !this.timer1Expired) {
      const period = (256 - this.timer1Value) * 0.080; // 80µs per tick, in ms
      if (now - this.timer1Start >= period) {
        this.timer1Expired = true;
        if (!this.timer1Mask && !this.timer1IRQFired) {
          this.timer1IRQFired = true;
          this.onTimerIRQ();
        }
        // CSM mode (reg 0x08 bit 7): key-on all channels when timer 1 overflows
        if (this.regs[0x08] & 0x80) {
          for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const [op1, op2] = CH_OP[ch];
            this.ops[op1].envState = ENV_ATTACK;
            this.ops[op1].envLevel = 1;
            this.ops[op2].envState = ENV_ATTACK;
            this.ops[op2].envLevel = 1;
          }
        }
      }
    }
    if (this.timer2Running && !this.timer2Expired) {
      const period = (256 - this.timer2Value) * 0.320; // 320µs per tick, in ms
      if (now - this.timer2Start >= period) {
        this.timer2Expired = true;
        if (!this.timer2Mask && !this.timer2IRQFired) {
          this.timer2IRQFired = true;
          this.onTimerIRQ();
        }
      }
    }
  }

  readStatus(): number {
    this.tickTimers();
    // Bit 7: IRQ (any unmasked timer expired), Bit 6: Timer 1, Bit 5: Timer 2
    let status = 0;
    if (this.timer1Expired && !this.timer1Mask) status |= 0x40;
    if (this.timer2Expired && !this.timer2Mask) status |= 0x20;
    if (status) status |= 0x80; // IRQ flag
    return status;
  }

  /** Trigger key-on for a single operator. */
  private keyOnOp(opIdx: number): void {
    const op = this.ops[opIdx];
    op.envState = ENV_ATTACK;
    op.envLevel = 1;
    op.phase = 0;
  }

  /** Trigger key-off for a single operator. */
  private keyOffOp(opIdx: number): void {
    const op = this.ops[opIdx];
    if (op.envState !== ENV_OFF) op.envState = ENV_RELEASE;
  }

  writeData(val: number): void {
    const reg = this.regIndex;
    const old = this.regs[reg];
    this.regs[reg] = val;

    // Timer registers
    if (reg === 0x02) { this.timer1Value = val; return; }
    if (reg === 0x03) { this.timer2Value = val; return; }
    if (reg === 0x04) {
      // Timer control register
      if (val & 0x80) {
        // Reset IRQ flags
        this.timer1Expired = false;
        this.timer2Expired = false;
        this.timer1IRQFired = false;
        this.timer2IRQFired = false;
        return;
      }
      this.timer1Mask = !!(val & 0x40);
      this.timer2Mask = !!(val & 0x20);
      const t1Start = !!(val & 0x01);
      const t2Start = !!(val & 0x02);
      if (t1Start && !this.timer1Running) {
        this.timer1Running = true;
        this.timer1Start = performance.now();
        this.timer1Expired = false;
        this.timer1IRQFired = false;
      } else if (!t1Start) {
        this.timer1Running = false;
      }
      if (t2Start && !this.timer2Running) {
        this.timer2Running = true;
        this.timer2Start = performance.now();
        this.timer2Expired = false;
        this.timer2IRQFired = false;
      } else if (!t2Start) {
        this.timer2Running = false;
      }
      return;
    }

    // Key-on/off: registers 0xB0-0xB8
    if (reg >= 0xB0 && reg <= 0xB8) {
      const ch = reg - 0xB0;
      const keyOn = (val >> 5) & 1;
      const wasOn = (old >> 5) & 1;
      const [op1, op2] = CH_OP[ch];
      if (keyOn && !wasOn) {
        this.keyOnOp(op1);
        this.keyOnOp(op2);
      } else if (!keyOn && wasOn) {
        this.keyOffOp(op1);
        this.keyOffOp(op2);
      }
    }

    // Rhythm mode key-on/off: register 0xBD bits 0-4 control percussion instruments
    if (reg === 0xBD) {
      const rhythmOn = val & 0x20;
      if (rhythmOn) {
        // Bass drum (bit 4): channel 6, both operators
        if ((val & 0x10) && !(old & 0x10)) { this.keyOnOp(CH_OP[6][0]); this.keyOnOp(CH_OP[6][1]); }
        if (!(val & 0x10) && (old & 0x10)) { this.keyOffOp(CH_OP[6][0]); this.keyOffOp(CH_OP[6][1]); }
        // Snare drum (bit 3): channel 7, operator 2
        if ((val & 0x08) && !(old & 0x08)) this.keyOnOp(CH_OP[7][1]);
        if (!(val & 0x08) && (old & 0x08)) this.keyOffOp(CH_OP[7][1]);
        // Tom-tom (bit 2): channel 8, operator 1
        if ((val & 0x04) && !(old & 0x04)) this.keyOnOp(CH_OP[8][0]);
        if (!(val & 0x04) && (old & 0x04)) this.keyOffOp(CH_OP[8][0]);
        // Top cymbal (bit 1): channel 8, operator 2
        if ((val & 0x02) && !(old & 0x02)) this.keyOnOp(CH_OP[8][1]);
        if (!(val & 0x02) && (old & 0x02)) this.keyOffOp(CH_OP[8][1]);
        // Hi-hat (bit 0): channel 7, operator 1
        if ((val & 0x01) && !(old & 0x01)) this.keyOnOp(CH_OP[7][0]);
        if (!(val & 0x01) && (old & 0x01)) this.keyOffOp(CH_OP[7][0]);
      }
    }
  }

  // Get operator register values
  private opReg(opIdx: number, baseReg: number): number {
    // Convert operator index to register offset
    const offset = opIdx < 6 ? opIdx : opIdx < 12 ? opIdx + 2 : opIdx + 4;
    return this.regs[baseReg + offset] ?? 0;
  }

  private getMulti(opIdx: number): number { return MULTI[this.opReg(opIdx, 0x20) & 0x0F]; }
  /** Total level: 0-63, each step = 0.75 dB attenuation. Returns linear amplitude 0..1. */
  private getTotalLevel(opIdx: number): number {
    const tl = this.opReg(opIdx, 0x40) & 0x3F;
    return Math.pow(10, -tl * 0.75 / 20); // dB to linear
  }

  /** Map operator index to its parent channel (0-8). */
  private opChannel(opIdx: number): number {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (CH_OP[ch][0] === opIdx || CH_OP[ch][1] === opIdx) return ch;
    }
    return 0;
  }

  /** Calculate OPL2 effective rate (0-63) from a 4-bit register rate value.
   *  effectiveRate = min(63, regRate * 4 + Rof)
   *  Rof = (block*2 + fnum_bit) >> (KSR ? 0 : 2)
   *  Note-Select (reg 0x08 bit 6) controls which fnum bit is used. */
  private effectiveRate(opIdx: number, regRate: number): number {
    if (regRate === 0) return 0;
    const ch = this.opChannel(opIdx);
    const block = (this.regs[0xB0 + ch] >> 2) & 0x07;
    const nts = (this.regs[0x08] >> 6) & 1;
    // NTS=0: fnum bit 9 (B0 bit 1), NTS=1: fnum bit 8 (B0 bit 0)
    const fnumBit = nts
      ? (this.regs[0xB0 + ch] & 0x01)
      : ((this.regs[0xB0 + ch] >> 1) & 0x01);
    const ksr = (this.opReg(opIdx, 0x20) >> 4) & 0x01;  // KSR bit from reg 0x20
    const rof = (block * 2 + fnumBit) >> (ksr ? 0 : 2);
    return Math.min(63, regRate * 4 + rof);
  }

  private getAttackRate(opIdx: number): number {
    return this.effectiveRate(opIdx, (this.opReg(opIdx, 0x60) >> 4) & 0x0F);
  }
  private getDecayRate(opIdx: number): number {
    return this.effectiveRate(opIdx, this.opReg(opIdx, 0x60) & 0x0F);
  }
  /** Sustain level: 0-15, each step = 3 dB. Returns dB attenuation (0=max, 1=silent). */
  private getSustainLevel(opIdx: number): number {
    const sl = (this.opReg(opIdx, 0x80) >> 4) & 0x0F;
    if (sl === 15) return 1; // -45 dB ≈ silent
    return 1 - Math.pow(10, -sl * 3 / 20); // convert to envLevel (0=max, 1=silent)
  }
  private getReleaseRate(opIdx: number): number {
    return this.effectiveRate(opIdx, this.opReg(opIdx, 0x80) & 0x0F);
  }
  private getWaveform(opIdx: number): number {
    if (!(this.regs[0x01] & 0x20)) return 0; // waveform select not enabled
    return this.opReg(opIdx, 0xE0) & 0x03;
  }

  private getChannelFreq(ch: number): number {
    const fnum = this.regs[0xA0 + ch] | ((this.regs[0xB0 + ch] & 0x03) << 8);
    const block = (this.regs[0xB0 + ch] >> 2) & 0x07;
    return fnum * Math.pow(2, block - 1) * OPL_RATE / (1 << 19);
  }

  private getFeedback(ch: number): number {
    return (this.regs[0xC0 + ch] >> 1) & 0x07;
  }

  private getConnection(ch: number): number {
    return this.regs[0xC0 + ch] & 0x01;
  }

  /** KSL attenuation as a linear multiplier (0..1). */
  private getKSL(opIdx: number, ch: number): number {
    const kslBits = (this.opReg(opIdx, 0x40) >> 6) & 0x03;
    if (kslBits === 0) return 1; // no attenuation
    const fnum = this.regs[0xA0 + ch] | ((this.regs[0xB0 + ch] & 0x03) << 8);
    const block = (this.regs[0xB0 + ch] >> 2) & 0x07;
    const fnumHigh = (fnum >> 6) & 0x0F;
    const baseLevel = KSL_ROM[fnumHigh] * 4 - (7 - block) * 32;
    const level = Math.max(0, baseLevel);
    const shift = KSL_SHIFT[kslBits];
    const attenUnits = shift >= 31 ? 0 : level >> shift;
    const attenDB = attenUnits * 0.1875; // each unit = 0.1875 dB
    return Math.pow(10, -attenDB / 20);
  }

  // Apply waveform shaping
  private waveform(phase: number, type: number): number {
    // Normalize phase to 0..1
    const p = ((phase % 1) + 1) % 1;
    const idx = (p * 1024) | 0;
    switch (type) {
      case 0: return SINE_TABLE[idx & 1023]; // sine
      case 1: return p < 0.5 ? SINE_TABLE[idx & 1023] : 0; // half-sine
      case 2: return Math.abs(SINE_TABLE[idx & 1023]); // abs-sine
      case 3: return (p % 0.5) < 0.25 ? SINE_TABLE[(idx * 2) & 1023] : 0; // quarter-sine (pulse)
      default: return SINE_TABLE[idx & 1023];
    }
  }

  // Update envelope for one operator, returns current amplitude (0..1)
  // envLevel: 0 = max volume, 1 = silent (linear scale representing dB attenuation)
  private updateEnvelope(op: OpState, opIdx: number, dt: number): number {
    if (op.envState === ENV_OFF) return 0;

    const tl = this.getTotalLevel(opIdx); // linear amplitude from total level

    switch (op.envState) {
      case ENV_ATTACK: {
        const rate = this.getAttackRate(opIdx);
        if (rate < 4) { op.envLevel = 1; break; }
        if (rate >= 60) { op.envLevel = 0; op.envState = ENV_DECAY; break; }
        const attackTime = ATTACK_TIMES[rate] / 1000;
        // Real OPL2 attack is exponential (fast start, slow finish).
        // ODE: dL/dt = -ln(1+K)/(K*T) * (1 + K*L), where T=attackTime.
        // K=7 gives a good match to the OPL2 capacitor-charge curve.
        // Total time from L=1 to L=0 is exactly attackTime.
        op.envLevel -= dt / attackTime * 0.2970 * (1 + 7 * op.envLevel);
        if (op.envLevel <= 0) { op.envLevel = 0; op.envState = ENV_DECAY; }
        break;
      }
      case ENV_DECAY: {
        const rate = this.getDecayRate(opIdx);
        const sl = this.getSustainLevel(opIdx);
        if (rate < 4) break;
        if (rate >= 60) { op.envLevel = sl; op.envState = ENV_SUSTAIN; break; }
        const decayTime = DECAY_TIMES[rate] / 1000;
        op.envLevel += dt / decayTime;
        if (op.envLevel >= sl) { op.envLevel = sl; op.envState = ENV_SUSTAIN; }
        break;
      }
      case ENV_SUSTAIN: {
        // EG type (reg 0x20 bit 5): 1=hold at sustain, 0=continue decay with release rate
        const egType = (this.opReg(opIdx, 0x20) >> 5) & 1;
        if (egType === 0) {
          const rate = this.getReleaseRate(opIdx);
          if (rate >= 4) {
            const relTime = (rate >= 60) ? 0 : DECAY_TIMES[rate] / 1000;
            if (relTime <= 0) { op.envLevel = 1; op.envState = ENV_OFF; }
            else {
              op.envLevel += dt / relTime;
              if (op.envLevel >= 1) { op.envLevel = 1; op.envState = ENV_OFF; }
            }
          }
        }
        break;
      }
      case ENV_RELEASE: {
        const rate = this.getReleaseRate(opIdx);
        if (rate < 4) break;
        if (rate >= 60) { op.envLevel = 1; op.envState = ENV_OFF; break; }
        const relTime = DECAY_TIMES[rate] / 1000;
        op.envLevel += dt / relTime;
        if (op.envLevel >= 1) { op.envLevel = 1; op.envState = ENV_OFF; }
        break;
      }
    }

    // Convert envLevel (0=max, 1=silent) to linear amplitude, scaled by total level
    const amplitude = (1 - op.envLevel) * tl;
    return Math.max(0, Math.min(1, amplitude));
  }

  /** Process one melodic channel. Returns its contribution to the output. */
  private processChannel(
    ch: number, dt: number, tremoDB: number, vibMul: number,
  ): number {
    const freq = this.getChannelFreq(ch);
    if (freq <= 0) return 0;

    const [opIdx1, opIdx2] = CH_OP[ch];
    const op1 = this.ops[opIdx1];
    const op2 = this.ops[opIdx2];

    // Update envelopes
    let amp1 = this.updateEnvelope(op1, opIdx1, dt);
    let amp2 = this.updateEnvelope(op2, opIdx2, dt);
    if (amp1 === 0 && amp2 === 0) return 0;

    // Apply KSL
    amp1 *= this.getKSL(opIdx1, ch);
    amp2 *= this.getKSL(opIdx2, ch);

    // Apply tremolo (AM): register 0x20 bit 7 per operator
    if (this.opReg(opIdx1, 0x20) & 0x80) amp1 *= Math.pow(10, -tremoDB / 20);
    if (this.opReg(opIdx2, 0x20) & 0x80) amp2 *= Math.pow(10, -tremoDB / 20);

    // Advance phases with vibrato: register 0x20 bit 6 per operator
    const multi1 = this.getMulti(opIdx1);
    const multi2 = this.getMulti(opIdx2);
    const vib1 = (this.opReg(opIdx1, 0x20) & 0x40) ? vibMul : 1;
    const vib2 = (this.opReg(opIdx2, 0x20) & 0x40) ? vibMul : 1;
    op1.phase += freq * multi1 * vib1 / OPL_RATE;
    op2.phase += freq * multi2 * vib2 / OPL_RATE;

    const connection = this.getConnection(ch);
    const feedback = this.getFeedback(ch);
    const wave1 = this.getWaveform(opIdx1);
    const wave2 = this.getWaveform(opIdx2);

    // Operator 1 (modulator) with feedback
    let mod1 = 0;
    if (feedback > 0) {
      mod1 = (op1.feedback0 + op1.feedback1) * MOD_DEPTH * Math.pow(2, feedback - 9);
    }
    const out1 = this.waveform(op1.phase + mod1, wave1) * amp1;
    op1.feedback1 = op1.feedback0;
    op1.feedback0 = out1;

    if (connection === 0) {
      // FM: op1 modulates op2's phase
      return this.waveform(op2.phase + out1 * MOD_DEPTH, wave2) * amp2;
    } else {
      // Additive: both operators output directly
      return out1 + this.waveform(op2.phase, wave2) * amp2;
    }
  }

  /** Compute operator amplitude with KSL + tremolo applied. Also advances phase. */
  private percOpAmp(
    opIdx: number, ch: number, dt: number, tremoDB: number, vibMul: number,
  ): number {
    const op = this.ops[opIdx];
    let amp = this.updateEnvelope(op, opIdx, dt);
    if (amp === 0) return 0;
    amp *= this.getKSL(opIdx, ch);
    if (this.opReg(opIdx, 0x20) & 0x80) amp *= Math.pow(10, -tremoDB / 20);
    // Advance phase
    const freq = this.getChannelFreq(ch);
    if (freq > 0) {
      const vib = (this.opReg(opIdx, 0x20) & 0x40) ? vibMul : 1;
      op.phase += freq * this.getMulti(opIdx) * vib / OPL_RATE;
    }
    return amp;
  }

  /** Generate percussion output for channels 6-8 in rhythm mode. */
  private generatePercussion(dt: number, tremoDB: number, vibMul: number): number {
    let output = 0;

    // Bass drum (channel 6): normal FM with both operators
    output += this.processChannel(6, dt, tremoDB, vibMul);

    // Phase-based noise (from OPL2 die analysis):
    // Uses phase bits from channel 7 op1 (hi-hat) and channel 8 op2 (cymbal)
    const ph7 = ((this.ops[CH_OP[7][0]].phase * 1024) | 0) & 0x3FF;
    const ph8 = ((this.ops[CH_OP[8][1]].phase * 1024) | 0) & 0x3FF;
    const phaseNoise = (
      (((ph7 >> 2) ^ (ph7 >> 7)) & 1) |
      (((ph8 >> 3) ^ (ph8 >> 5)) & 1) |
      (((ph7 >> 3) ^ (ph8 >> 2)) & 1)
    ) !== 0;

    // LFSR noise bit (for snare drum)
    const lfsrBit = (this.noiseRNG & 1) !== 0;

    // Hi-hat (channel 7, operator 1): noise-based rectangular wave
    {
      const amp = this.percOpAmp(CH_OP[7][0], 7, dt, tremoDB, vibMul);
      if (amp > 0) output += (phaseNoise ? 0.5 : -0.5) * amp;
    }

    // Snare drum (channel 7, operator 2): noise XOR phase high bit
    {
      const opIdx = CH_OP[7][1];
      const amp = this.percOpAmp(opIdx, 7, dt, tremoDB, vibMul);
      if (amp > 0) {
        const phaseBit = (((this.ops[opIdx].phase * 1024) | 0) & 0x200) !== 0;
        const snareBit = phaseNoise !== phaseBit !== lfsrBit;
        output += (snareBit ? 0.5 : -0.5) * amp;
      }
    }

    // Tom-tom (channel 8, operator 1): normal sine, no noise
    {
      const opIdx = CH_OP[8][0];
      const amp = this.percOpAmp(opIdx, 8, dt, tremoDB, vibMul);
      if (amp > 0) output += this.waveform(this.ops[opIdx].phase, this.getWaveform(opIdx)) * amp;
    }

    // Top cymbal (channel 8, operator 2): noise-based rectangular wave
    {
      const amp = this.percOpAmp(CH_OP[8][1], 8, dt, tremoDB, vibMul);
      if (amp > 0) output += (phaseNoise ? 0.5 : -0.5) * amp;
    }

    return output;
  }

  // Generate one sample at OPL_RATE
  private generateOneSample(): number {
    let output = 0;
    const dt = 1 / OPL_RATE;

    // Advance global LFOs
    this.tremoloPhase = (this.tremoloPhase + TREMOLO_FREQ / OPL_RATE) % 1;
    this.vibratoPhase = (this.vibratoPhase + VIBRATO_FREQ / OPL_RATE) % 1;

    // Advance 23-bit LFSR noise generator (taps at bits 0, 14, 15)
    const nbit = ((this.noiseRNG ^ (this.noiseRNG >> 14) ^ (this.noiseRNG >> 15)) & 1);
    this.noiseRNG = (this.noiseRNG >> 1) | (nbit << 22);

    // Compute tremolo: triangle wave 0→peak→0, converted to dB attenuation
    const tremoloTriangle = 1 - 2 * Math.abs(this.tremoloPhase - 0.5); // 0..1..0
    const deepTrem = (this.regs[0xBD] & 0x80) !== 0;
    const tremoDB = tremoloTriangle * (deepTrem ? 4.8 : 1.0);

    // Compute vibrato: triangle wave -1..+1, converted to frequency multiplier
    const vibTriangle = 4 * Math.abs(this.vibratoPhase - 0.5) - 1; // -1..+1..-1
    const deepVib = (this.regs[0xBD] & 0x40) !== 0;
    const vibCents = vibTriangle * (deepVib ? 14 : 7);
    const vibMul = Math.pow(2, vibCents / 1200);

    const rhythmMode = (this.regs[0xBD] & 0x20) !== 0;
    const melodicEnd = rhythmMode ? 6 : 9;

    // Melodic channels (always 0-5, plus 6-8 when rhythm mode is off)
    for (let ch = 0; ch < melodicEnd; ch++) {
      output += this.processChannel(ch, dt, tremoDB, vibMul);
    }

    // Percussion channels 6-8 when rhythm mode is on
    if (rhythmMode) {
      output += this.generatePercussion(dt, tremoDB, vibMul);
    }

    return output / NUM_CHANNELS; // Normalize
  }

  /** Fill a Float32Array with audio samples at the target sample rate. */
  generateSamples(out: Float32Array, length: number): void {
    const ratio = OPL_RATE / this.sampleRate;
    for (let i = 0; i < length; i++) {
      this.accumPhase += ratio;
      while (this.accumPhase >= 1) {
        this.accumPhase -= 1;
        this.outputBuf[this.bufPos & 4095] = this.generateOneSample();
        this.bufPos++;
      }
      out[i] = this.outputBuf[(this.bufPos - 1) & 4095];
    }
  }
}
