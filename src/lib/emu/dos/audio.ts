/**
 * DOS audio subsystem: PC Speaker, AdLib/OPL2 FM synthesis, Sound Blaster DSP detection.
 *
 * PC Speaker: PIT channel 2 square wave gated through port 0x61 bits 0-1.
 * AdLib: OPL2 FM chip at ports 0x388-0x389 (and SB mirror at 0x228-0x229).
 * Sound Blaster: DSP at 0x220-0x22F — detection/reset only (no DMA audio).
 */

import type { Emulator } from '../emulator';

// ---- OPL2 constants ----

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

// Attack rate timing (ms approximate) — indexed by effective rate 0-15
const ATTACK_TIMES = [Infinity, 1500, 750, 500, 375, 250, 187, 125, 93, 62, 46, 31, 23, 15, 7, 0];
const DECAY_TIMES = [Infinity, 24000, 12000, 6000, 4800, 3600, 2400, 1800, 1200, 900, 600, 480, 360, 240, 120, 0];

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

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.outputBuf = new Float32Array(4096);
    for (let i = 0; i < NUM_OPERATORS; i++) {
      this.ops.push({ phase: 0, envLevel: 1, envState: ENV_OFF, feedback0: 0, feedback1: 0 });
    }
  }

  writeAddr(val: number): void { this.regIndex = val & 0xFF; }

  readStatus(): number {
    // Bit 7: IRQ flag, Bit 6: Timer 1 flag, Bit 5: Timer 2 flag
    // Return 0 = ready (no timers expired)
    return 0x00;
  }

  writeData(val: number): void {
    const reg = this.regIndex;
    const old = this.regs[reg];
    this.regs[reg] = val;

    // Key-on/off: registers 0xB0-0xB8
    if (reg >= 0xB0 && reg <= 0xB8) {
      const ch = reg - 0xB0;
      const keyOn = (val >> 5) & 1;
      const wasOn = (old >> 5) & 1;
      const [op1, op2] = CH_OP[ch];
      if (keyOn && !wasOn) {
        // Key on: start attack
        this.ops[op1].envState = ENV_ATTACK;
        this.ops[op1].envLevel = 1;
        this.ops[op1].phase = 0;
        this.ops[op2].envState = ENV_ATTACK;
        this.ops[op2].envLevel = 1;
        this.ops[op2].phase = 0;
      } else if (!keyOn && wasOn) {
        // Key off: start release
        if (this.ops[op1].envState !== ENV_OFF) this.ops[op1].envState = ENV_RELEASE;
        if (this.ops[op2].envState !== ENV_OFF) this.ops[op2].envState = ENV_RELEASE;
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
  private getTotalLevel(opIdx: number): number { return (this.opReg(opIdx, 0x40) & 0x3F) / 63; }
  private getAttackRate(opIdx: number): number { return (this.opReg(opIdx, 0x60) >> 4) & 0x0F; }
  private getDecayRate(opIdx: number): number { return this.opReg(opIdx, 0x60) & 0x0F; }
  private getSustainLevel(opIdx: number): number { return ((this.opReg(opIdx, 0x80) >> 4) & 0x0F) / 15; }
  private getReleaseRate(opIdx: number): number { return this.opReg(opIdx, 0x80) & 0x0F; }
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
  private updateEnvelope(op: OpState, opIdx: number, dt: number): number {
    if (op.envState === ENV_OFF) return 0;

    const tl = this.getTotalLevel(opIdx);
    const maxAmp = 1 - tl; // total level attenuation

    switch (op.envState) {
      case ENV_ATTACK: {
        const rate = this.getAttackRate(opIdx);
        if (rate === 0) { op.envLevel = 1; break; }
        if (rate >= 15) { op.envLevel = 0; op.envState = ENV_DECAY; break; }
        const attackTime = ATTACK_TIMES[rate] / 1000;
        op.envLevel -= dt / attackTime;
        if (op.envLevel <= 0) { op.envLevel = 0; op.envState = ENV_DECAY; }
        break;
      }
      case ENV_DECAY: {
        const rate = this.getDecayRate(opIdx);
        const sl = this.getSustainLevel(opIdx);
        if (rate === 0) break;
        const decayTime = DECAY_TIMES[rate] / 1000;
        op.envLevel += dt / decayTime;
        if (op.envLevel >= sl) { op.envLevel = sl; op.envState = ENV_SUSTAIN; }
        break;
      }
      case ENV_SUSTAIN:
        // Stay at sustain level (EG type determines if it stays or decays, simplified here)
        break;
      case ENV_RELEASE: {
        const rate = this.getReleaseRate(opIdx);
        if (rate === 0) break;
        const relTime = DECAY_TIMES[rate] / 1000;
        op.envLevel += dt / relTime;
        if (op.envLevel >= 1) { op.envLevel = 1; op.envState = ENV_OFF; }
        break;
      }
    }

    const amplitude = (1 - op.envLevel) * maxAmp;
    return Math.max(0, Math.min(1, amplitude));
  }

  // Generate one sample at OPL_RATE
  private generateOneSample(): number {
    let output = 0;
    const dt = 1 / OPL_RATE;

    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const freq = this.getChannelFreq(ch);
      if (freq <= 0) continue;

      const [opIdx1, opIdx2] = CH_OP[ch];
      const op1 = this.ops[opIdx1];
      const op2 = this.ops[opIdx2];
      const connection = this.getConnection(ch);
      const feedback = this.getFeedback(ch);

      // Update envelopes
      const amp1 = this.updateEnvelope(op1, opIdx1, dt);
      const amp2 = this.updateEnvelope(op2, opIdx2, dt);

      if (amp1 === 0 && amp2 === 0) continue;

      const multi1 = this.getMulti(opIdx1);
      const multi2 = this.getMulti(opIdx2);
      const wave1 = this.getWaveform(opIdx1);
      const wave2 = this.getWaveform(opIdx2);

      // Advance phases
      const phaseInc1 = freq * multi1 / OPL_RATE;
      const phaseInc2 = freq * multi2 / OPL_RATE;
      op1.phase += phaseInc1;
      op2.phase += phaseInc2;

      // Operator 1 (modulator) with feedback
      let mod1 = 0;
      if (feedback > 0) {
        mod1 = (op1.feedback0 + op1.feedback1) / 2 * (1 << (feedback - 1)) / 8;
      }
      const out1 = this.waveform(op1.phase + mod1, wave1) * amp1;
      op1.feedback1 = op1.feedback0;
      op1.feedback0 = out1;

      if (connection === 0) {
        // FM: op1 modulates op2
        const modulation = out1 * 0.5; // modulation depth
        const out2 = this.waveform(op2.phase + modulation, wave2) * amp2;
        output += out2;
      } else {
        // Additive: both operators output directly
        output += out1 + this.waveform(op2.phase, wave2) * amp2;
      }
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

// ---- Sound Blaster DSP (detection only) ----

const SB_DSP_READY = 0xAA;
const SB_DSP_VERSION_HI = 2;
const SB_DSP_VERSION_LO = 1;

class SoundBlasterDSP {
  private resetState = 0; // 0=idle, 1=reset pulse received
  private dataQueue: number[] = [];
  private lastCommand = 0;

  reset(): void {
    this.dataQueue = [SB_DSP_READY]; // After reset, 0xAA is readable
    this.resetState = 0;
  }

  writeReset(val: number): void {
    if (val === 1) {
      this.resetState = 1;
    } else if (val === 0 && this.resetState === 1) {
      this.reset();
    }
  }

  writeCommand(val: number): void {
    switch (val) {
      case 0xE1: // Get DSP version
        this.dataQueue.push(SB_DSP_VERSION_HI, SB_DSP_VERSION_LO);
        break;
      case 0xD1: // Enable speaker
      case 0xD3: // Disable speaker
        break;
      default:
        this.lastCommand = val;
        break;
    }
  }

  readData(): number {
    return this.dataQueue.length > 0 ? this.dataQueue.shift()! : 0xFF;
  }

  readStatus(): number {
    // Bit 7: data available to read
    return this.dataQueue.length > 0 ? 0xFF : 0x7F;
  }
}

// ---- PC Speaker ----

class PCSpeaker {
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private enabled = false;
  private frequency = 0;

  constructor(ctx: AudioContext | null) {
    this.ctx = ctx;
    if (ctx) {
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(ctx.destination);
    }
  }

  update(port61: number, pitReload: number): void {
    const speakerOn = (port61 & 0x03) === 0x03; // both gate and enable
    const freq = pitReload > 0 ? 1193182 / pitReload : 0;

    if (speakerOn && freq >= 20 && freq <= 20000) {
      if (!this.enabled || Math.abs(this.frequency - freq) > 0.5) {
        this.frequency = freq;
        this.startTone(freq);
      }
      this.enabled = true;
    } else {
      if (this.enabled) {
        this.stopTone();
      }
      this.enabled = false;
    }
  }

  private startTone(freq: number): void {
    if (!this.ctx || !this.gain) return;
    if (!this.oscillator) {
      this.oscillator = this.ctx.createOscillator();
      this.oscillator.type = 'square';
      this.oscillator.connect(this.gain);
      this.oscillator.start();
    }
    this.oscillator.frequency.setValueAtTime(freq, this.ctx.currentTime);
    this.gain.gain.setValueAtTime(0.08, this.ctx.currentTime); // Low volume for speaker
  }

  private stopTone(): void {
    if (this.gain && this.ctx) {
      this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }

  destroy(): void {
    this.stopTone();
    if (this.oscillator) {
      this.oscillator.stop();
      this.oscillator.disconnect();
      this.oscillator = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
  }
}

// ---- DosAudio: ties everything together ----

export class DosAudio {
  private opl2: OPL2;
  private speaker: PCSpeaker;
  private sbDsp: SoundBlasterDSP;
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private started = false;
  /** Shared ring buffer for passing OPL2 samples to the AudioWorklet. */
  private sharedBuf: Float32Array | null = null;
  private writePos = 0;
  private fillTimer = 0;

  constructor() {
    this.opl2 = new OPL2(44100); // will be updated when AudioContext is created
    this.speaker = new PCSpeaker(null);
    this.sbDsp = new SoundBlasterDSP();
  }

  /** Initialize audio (must be called from user gesture). */
  init(audioContext: AudioContext): void {
    if (this.started) return;
    this.ctx = audioContext;
    this.started = true;

    this.opl2 = new OPL2(audioContext.sampleRate);
    this.speaker = new PCSpeaker(audioContext);

    // Use SharedArrayBuffer if available for lock-free audio, otherwise fall back
    // to a message-based approach with regular ArrayBuffer.
    const RING_SIZE = 8192;
    const useShared = typeof SharedArrayBuffer !== 'undefined';
    const ringBuf = useShared
      ? new SharedArrayBuffer(RING_SIZE * 4 + 8) // samples + writePos + readPos
      : null;

    // AudioWorklet processor code — injected via Blob URL
    const processorCode = `
class OPLProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ring = null;
    this.readPos = 0;
    this.pendingSamples = [];
    const shared = options.processorOptions?.sharedBuffer;
    if (shared) {
      this.ring = new Float32Array(shared, 0, ${RING_SIZE});
      this.pointers = new Int32Array(shared, ${RING_SIZE * 4}, 2);
    } else {
      this.port.onmessage = (e) => {
        if (e.data.samples) {
          this.pendingSamples.push(...e.data.samples);
        }
      };
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (this.ring) {
      const wp = Atomics.load(this.pointers, 0);
      for (let i = 0; i < out.length; i++) {
        if (this.readPos !== wp) {
          out[i] = this.ring[this.readPos % ${RING_SIZE}];
          this.readPos++;
        } else {
          out[i] = 0;
        }
      }
      Atomics.store(this.pointers, 1, this.readPos);
    } else {
      for (let i = 0; i < out.length; i++) {
        out[i] = this.pendingSamples.length > 0 ? this.pendingSamples.shift() : 0;
      }
    }
    return true;
  }
}
registerProcessor('opl-processor', OPLProcessor);`;

    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    audioContext.audioWorklet.addModule(url).then(() => {
      URL.revokeObjectURL(url);
      if (!this.ctx) return;
      const node = new AudioWorkletNode(this.ctx, 'opl-processor', {
        outputChannelCount: [1],
        processorOptions: { sharedBuffer: ringBuf },
      });
      node.connect(this.ctx.destination);
      this.workletNode = node;

      if (ringBuf) {
        this.sharedBuf = new Float32Array(ringBuf, 0, RING_SIZE);
        // Periodically generate OPL2 samples into the shared ring buffer
        const pointers = new Int32Array(ringBuf, RING_SIZE * 4, 2);
        const tmpBuf = new Float32Array(512);
        const fill = () => {
          if (!this.ctx) return;
          const rp = Atomics.load(pointers, 1);
          const wp = this.writePos;
          const available = RING_SIZE - (wp - rp);
          if (available > 512) {
            this.opl2.generateSamples(tmpBuf, 512);
            for (let i = 0; i < 512; i++) {
              this.sharedBuf![((wp + i) % RING_SIZE)] = tmpBuf[i];
            }
            this.writePos = wp + 512;
            Atomics.store(pointers, 0, this.writePos);
          }
          this.fillTimer = requestAnimationFrame(fill) as unknown as number;
        };
        this.fillTimer = requestAnimationFrame(fill) as unknown as number;
      } else {
        // Fallback: periodically post samples via message port
        const tmpBuf = new Float32Array(512);
        const fill = () => {
          if (!this.workletNode) return;
          this.opl2.generateSamples(tmpBuf, 512);
          this.workletNode.port.postMessage({ samples: Array.from(tmpBuf) });
          this.fillTimer = requestAnimationFrame(fill) as unknown as number;
        };
        this.fillTimer = requestAnimationFrame(fill) as unknown as number;
      }
    }).catch(() => {
      // AudioWorklet not supported — no OPL2 audio (PC speaker still works)
      URL.revokeObjectURL(url);
    });
  }

  /** Handle I/O port read. Returns value or -1 if not an audio port. */
  portIn(port: number): number {
    // AdLib ports
    if (port === 0x388 || port === 0x228) return this.opl2.readStatus();
    if (port === 0x389 || port === 0x229) return 0; // data read not meaningful

    // Sound Blaster DSP ports (base 0x220)
    if (port === 0x22A) return this.sbDsp.readData();    // Read data
    if (port === 0x22E) return this.sbDsp.readStatus();   // Read status (data available?)
    if (port === 0x22C) return 0x00; // Write status — always ready (bit 7 = 0)

    return -1; // Not an audio port
  }

  /** Handle I/O port write. Returns true if handled. */
  portOut(port: number, value: number): boolean {
    // AdLib ports
    if (port === 0x388 || port === 0x228) { this.opl2.writeAddr(value); return true; }
    if (port === 0x389 || port === 0x229) { this.opl2.writeData(value); return true; }

    // Sound Blaster DSP ports (base 0x220)
    if (port === 0x226) { this.sbDsp.writeReset(value); return true; }
    if (port === 0x22C) { this.sbDsp.writeCommand(value); return true; }

    return false; // Not an audio port
  }

  /** Update PC speaker state (call when port 0x61 or PIT ch2 changes). */
  updateSpeaker(port61: number, pitCh2Reload: number): void {
    this.speaker.update(port61, pitCh2Reload);
  }

  destroy(): void {
    this.speaker.destroy();
    if (this.fillTimer) cancelAnimationFrame(this.fillTimer);
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
  }
}
