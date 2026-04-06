// Test: EMUL5.EXE (DOS/4GW DPMI application)
import { readFileSync } from 'fs';
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
  addEventListener: noop,
  removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
mockCtx.canvas = mockCanvas;

globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { ...mockCtx, canvas: this }; }
};
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
console.log(`[INIT] peInfo: isMZ=${peInfo.isMZ} isCOM=${peInfo.isCOM} isPE=${!!peInfo.pe}`);

const emu = new Emulator();
emu.screenWidth = 640;
emu.screenHeight = 480;
emu.exeName = 'emul5/EMUL5.EXE';
emu.exePath = 'D:\\emul5\\EMUL5.EXE';
emu.additionalFiles.set('DOS4GW.EXE', dos4gwBuf);
// Add all data files EMUL5 might need
import { readdirSync, statSync } from 'fs';
for (const name of readdirSync(BASE)) {
  const fullPath = `${BASE}/${name}`;
  if (statSync(fullPath).isFile() && name !== 'EMUL5.EXE' && name !== 'DOS4GW.EXE') {
    emu.additionalFiles.set(name, readToArrayBuffer(fullPath));
  }
}

await emu.load(emul5Buf, peInfo, mockCanvas);
emu.run();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Capture INT 21h AH value before each call
const origInt21Log = console.log;
let lastInt21AH = -1;
const origHandleDosInt = globalThis._origHandleDosInt;
// Intercept CPU-HALT to show AH
const origWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('[CPU-HALT]')) {
    origWarn(`  AX=0x${(emu.cpu.reg[0] & 0xFFFF).toString(16)} AH=0x${((emu.cpu.reg[0] >>> 8) & 0xFF).toString(16)}`);
  }
  origWarn(...args);
};

const MAX_TICKS = 500;
let totalTicks = 0;

for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) {
    console.log(`[HALT] after ${totalTicks} ticks: ${emu.cpu.haltReason}`);
    break;
  }
  // Add real-time delay when dosHalted so PIT timer fires
  if (emu._dosHalted) await sleep(60);
  emu.tick();
  totalTicks++;
  const eip = emu.cpu.eip >>> 0;
  const prevSteps = i > 0 ? emu.cpuSteps : 0;
  if (i < 5 || i % 50 === 0) console.log(`[TICK ${i}] cpuSteps=${emu.cpuSteps} EIP=0x${eip.toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode} dosHalted=${emu._dosHalted}`);
}

console.log(`[DONE] ticks=${totalTicks} cpuSteps=${emu.cpuSteps} halted=${emu.halted}`);
console.log(`  EIP=0x${(emu.cpu.eip >>> 0).toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode}`);
if (emu.cpu.haltReason) console.log(`  haltReason: ${emu.cpu.haltReason}`);
