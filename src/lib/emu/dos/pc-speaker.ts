/**
 * PC Speaker emulation via Web Audio OscillatorNode.
 *
 * PIT channel 2 square wave gated through port 0x61 bits 0-1.
 */

export class PCSpeaker {
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
