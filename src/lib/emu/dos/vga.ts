// VGA state management, palette, mode 13h framebuffer sync

import type { Emulator } from '../emulator';

export interface VGAMode {
  mode: number;
  width: number;
  height: number;
  bpp: number;
  isText: boolean;
  cols: number;
  rows: number;
  charHeight: number;
  memBase: number;
  planar: boolean;
}

export const VGA_MODES: Record<number, VGAMode> = {
  0x03: { mode: 0x03, width: 720, height: 400, bpp: 4, isText: true, cols: 80, rows: 25, charHeight: 16, memBase: 0xB8000, planar: false },
  0x04: { mode: 0x04, width: 320, height: 200, bpp: 2, isText: false, cols: 40, rows: 25, charHeight: 8, memBase: 0xB8000, planar: false },
  0x06: { mode: 0x06, width: 640, height: 200, bpp: 1, isText: false, cols: 80, rows: 25, charHeight: 8, memBase: 0xB8000, planar: false },
  0x0E: { mode: 0x0E, width: 640, height: 200, bpp: 4, isText: false, cols: 80, rows: 25, charHeight: 8, memBase: 0xA0000, planar: true },
  0x10: { mode: 0x10, width: 640, height: 350, bpp: 4, isText: false, cols: 80, rows: 25, charHeight: 14, memBase: 0xA0000, planar: true },
  0x12: { mode: 0x12, width: 640, height: 480, bpp: 4, isText: false, cols: 80, rows: 30, charHeight: 16, memBase: 0xA0000, planar: true },
  0x13: { mode: 0x13, width: 320, height: 200, bpp: 8, isText: false, cols: 40, rows: 25, charHeight: 8, memBase: 0xA0000, planar: false },
};

// Build default VGA 256-color palette (6-bit per component)
function buildDefaultPalette(): Uint8Array {
  const pal = new Uint8Array(256 * 3);

  // Standard 16 EGA colors (6-bit values)
  const ega16 = [
    0,0,0,  0,0,42,  0,42,0,  0,42,42,  42,0,0,  42,0,42,  42,21,0,  42,42,42,
    21,21,21, 21,21,63, 21,63,21, 21,63,63, 63,21,21, 63,21,63, 63,63,21, 63,63,63,
  ];
  for (let i = 0; i < 48; i++) pal[i] = ega16[i];

  // 216-color cube (indices 16-231): 6 levels each of R, G, B
  const levels = [0, 5, 9, 13, 18, 22, 27, 31, 36, 40, 45, 49, 54, 58, 63];
  // Actually the standard VGA 256 palette uses a different scheme.
  // Use the common "mode 13h default" pattern:
  // 16-31: grayscale ramp
  for (let i = 0; i < 16; i++) {
    const v = Math.round((i / 15) * 63);
    pal[(16 + i) * 3 + 0] = v;
    pal[(16 + i) * 3 + 1] = v;
    pal[(16 + i) * 3 + 2] = v;
  }

  // 32-247: color cube (6 intensity levels × 6 × 6 = 216, but standard uses different layout)
  // For simplicity, fill with a reasonable 6×6×6 cube for indices 16+16=32..247
  let idx = 32;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        if (idx < 256) {
          pal[idx * 3 + 0] = Math.round(r * 63 / 5);
          pal[idx * 3 + 1] = Math.round(g * 63 / 5);
          pal[idx * 3 + 2] = Math.round(b * 63 / 5);
          idx++;
        }
      }
    }
  }

  // 248-255: grayscale tail
  for (let i = 248; i < 256; i++) {
    const v = Math.round(((i - 248) / 7) * 63);
    pal[i * 3 + 0] = v;
    pal[i * 3 + 1] = v;
    pal[i * 3 + 2] = v;
  }

  return pal;
}

export class VGAState {
  currentMode: VGAMode = VGA_MODES[0x03];
  palette = buildDefaultPalette(); // 256 entries × 3 components, 6-bit each
  dacWriteIndex = 0;
  dacReadIndex = 0;
  dacComponent = 0; // 0=R, 1=G, 2=B

  seqIndex = 0;
  gcIndex = 0;
  writeMapMask = 0x0F;
  readMapSelect = 0;

  framebuffer: ImageData | null = null;
  dirty = false;

  // VGA retrace toggle for port 0x3DA
  private retraceToggle = false;

  portWrite(port: number, value: number): void {
    switch (port) {
      case 0x3C4: // Sequencer index
        this.seqIndex = value;
        break;
      case 0x3C5: // Sequencer data
        if (this.seqIndex === 0x02) this.writeMapMask = value & 0x0F;
        break;
      case 0x3CE: // Graphics controller index
        this.gcIndex = value;
        break;
      case 0x3CF: // Graphics controller data
        if (this.gcIndex === 0x04) this.readMapSelect = value & 0x03;
        break;
      case 0x3C8: // DAC write index
        this.dacWriteIndex = value;
        this.dacComponent = 0;
        break;
      case 0x3C7: // DAC read index
        this.dacReadIndex = value;
        this.dacComponent = 0;
        break;
      case 0x3C9: // DAC data (write R, G, B sequentially)
        this.palette[this.dacWriteIndex * 3 + this.dacComponent] = value & 0x3F;
        this.dacComponent++;
        if (this.dacComponent >= 3) {
          this.dacComponent = 0;
          this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF;
          this.dirty = true;
        }
        break;
      case 0x3D4: // CRTC index (ignore)
      case 0x3D5: // CRTC data (ignore)
        break;
    }
  }

  portRead(port: number): number {
    switch (port) {
      case 0x3DA: // Input status register 1 — toggle retrace bit
        this.retraceToggle = !this.retraceToggle;
        return this.retraceToggle ? 0x09 : 0x00; // bit 0 = display, bit 3 = vretrace
      case 0x3C9: { // DAC data read
        const val = this.palette[this.dacReadIndex * 3 + this.dacComponent];
        this.dacComponent++;
        if (this.dacComponent >= 3) {
          this.dacComponent = 0;
          this.dacReadIndex = (this.dacReadIndex + 1) & 0xFF;
        }
        return val;
      }
      case 0x3C8:
        return this.dacWriteIndex;
      case 0x3C7:
        return this.dacReadIndex;
      default:
        return 0xFF;
    }
  }

  initFramebuffer(width: number, height: number): void {
    if (typeof ImageData !== 'undefined') {
      this.framebuffer = new ImageData(width, height);
    }
  }
}

const VGA_PORT_START = 0x3C0;
const VGA_PORT_END = 0x3DA;

export function isVGAPort(port: number): boolean {
  return port >= VGA_PORT_START && port <= VGA_PORT_END;
}

/** Sync mode 13h (320x200x256) framebuffer from linear memory at A0000 */
export function syncMode13h(emu: Emulator): void {
  const vga = emu.vga;
  if (!vga.framebuffer) return;

  const mem = emu.memory;
  const pal = vga.palette;
  const data = vga.framebuffer.data;
  const buf32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);

  for (let i = 0; i < 64000; i++) {
    const colorIdx = mem.readU8(0xA0000 + i);
    const r = (pal[colorIdx * 3 + 0] * 255 / 63) | 0;
    const g = (pal[colorIdx * 3 + 1] * 255 / 63) | 0;
    const b = (pal[colorIdx * 3 + 2] * 255 / 63) | 0;
    buf32[i] = 0xFF000000 | (b << 16) | (g << 8) | r; // ABGR for little-endian
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}
