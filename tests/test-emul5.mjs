// Test: EMUL5.EXE (DOS/4GW DPMI application)
import { readFileSync, readdirSync, statSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
  drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
  setTransform: noop, resetTransform: noop, transform: noop,
  beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
  arc: noop, arcTo: noop, rect: noop, ellipse: noop,
  fill: noop, stroke: noop, clip: noop,
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => null,
  font: '', textAlign: 'left', textBaseline: 'top',
  fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent',
  canvas: null,
};
const mockCanvas = {
  width: 640, height: 480,
  getContext: () => mockCtx,
  toDataURL: () => 'data:image/png;base64,',
  addEventListener: noop, removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/emul5';

const emul5Buf = readToArrayBuffer(`${BASE}/EMUL5.EXE`);
const dos4gwBuf = readToArrayBuffer(`${BASE}/DOS4GW.EXE`);
const peInfo = parsePE(emul5Buf);

const emu = new Emulator();
emu.screenWidth = 640;
emu.screenHeight = 480;
emu.exeName = 'emul5/EMUL5.EXE';
emu.exePath = 'D:\\emul5\\EMUL5.EXE';
emu.dosEnableDpmi = false; // Force VCPI path (DOS4GW manages its own PM)
emu.additionalFiles.set('DOS4GW.EXE', dos4gwBuf);

// Add all companion files
for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname !== 'EMUL5.EXE' && fname !== 'DOS4GW.EXE') {
    emu.additionalFiles.set(fname, readToArrayBuffer(fp));
  }
}

await emu.load(emul5Buf, peInfo, mockCanvas);
emu.run();

// Ring buffer to trace last 512 EIP+CS before crash
const RING_SIZE = 512;
const ringEIP = new Uint32Array(RING_SIZE);
const ringCS = new Uint16Array(RING_SIZE);
const ringRM = new Uint8Array(RING_SIZE);
let ringIdx = 0;
const origStep = emu.cpu.step.bind(emu.cpu);
emu.cpu.step = function() {
  ringEIP[ringIdx] = this.eip >>> 0;
  ringCS[ringIdx] = this.cs;
  ringRM[ringIdx] = this.realMode ? 1 : 0;
  ringIdx = (ringIdx + 1) & (RING_SIZE - 1);
  origStep();
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_TICKS = 200;
let totalTicks = 0;

for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) {
    console.log(`[HALT] after ${totalTicks} ticks: ${emu.cpu.haltReason}`);
    // Dump last 64 ring buffer entries
    console.log(`[RING] Last 64:`);
    for (let j = RING_SIZE - 64; j < RING_SIZE; j++) {
      const idx2 = (ringIdx + j) & (RING_SIZE - 1);
      const e = ringEIP[idx2], c = ringCS[idx2], r = ringRM[idx2];
      if (!e && !c) continue;
      const bytes = [];
      for (let b = 0; b < 8; b++) bytes.push(emu.memory.readU8(e + b).toString(16).padStart(2, '0'));
      const prev = ringCS[(ringIdx + j - 1 + RING_SIZE) & (RING_SIZE - 1)];
      const mark = (c !== prev) ? ' <<<' : '';
      console.log(`  CS=0x${c.toString(16)} EIP=0x${e.toString(16)} RM=${r} [${bytes.join(' ')}]${mark}`);
    }
    break;
  }
  if (emu._dosHalted) await sleep(60);
  emu.tick();
  totalTicks++;
  if (i < 5 || i % 10 === 0) {
    const eip = emu.cpu.eip >>> 0;
    console.log(`[TICK ${i}] cpuSteps=${emu.cpuSteps} EIP=0x${eip.toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode}`);
  }
}

console.log(`[DONE] ticks=${totalTicks} cpuSteps=${emu.cpuSteps} halted=${emu.halted}`);
console.log(`  videoMode=0x${emu.videoMode.toString(16)} isGraphics=${emu.isGraphicsMode}`);
if (emu.cpu.haltReason) console.log(`  haltReason: ${emu.cpu.haltReason}`);
