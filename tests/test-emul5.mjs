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

await emu.load(emul5Buf, peInfo, mockCanvas);

// Dump DOS4GW MZ header
{
  const dv = new DataView(dos4gwBuf);
  const magic = String.fromCharCode(dv.getUint8(0)) + String.fromCharCode(dv.getUint8(1));
  const ecblp = dv.getUint16(2, true);  // bytes in last page
  const ecp = dv.getUint16(4, true);    // pages in file
  const crlc = dv.getUint16(6, true);   // relocation count
  const cparhdr = dv.getUint16(8, true); // header paragraphs
  const hdrSize = cparhdr * 16;
  const fileSize = ecp === 0 ? dos4gwBuf.byteLength : (ecp - 1) * 512 + (ecblp || 512);
  const imgSize = fileSize - hdrSize;
  const csInit = dv.getInt16(0x16, true);
  const ipInit = dv.getUint16(0x14, true);
  const ssInit = dv.getInt16(0x0E, true);
  const spInit = dv.getUint16(0x10, true);
  console.log(`[DOS4GW HDR] magic=${magic} pages=${ecp} lastPage=${ecblp} relocs=${crlc} hdrParas=${cparhdr} hdrSize=${hdrSize} fileSize=${fileSize} imgSize=${imgSize}`);
  console.log(`[DOS4GW HDR] CS:IP=${csInit.toString(16)}:${ipInit.toString(16)} SS:SP=${ssInit.toString(16)}:${spInit.toString(16)}`);
  // Check what's at offset 0x1190 (where the filename should be)
  const off1190 = hdrSize + 0x1190;
  const off1192 = hdrSize + 0x1192;
  console.log(`[DOS4GW DATA] At file offset 0x${off1190.toString(16)} (img+0x1190): ${Array.from(new Uint8Array(dos4gwBuf, off1190, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  console.log(`[DOS4GW DATA] At file offset 0x${off1192.toString(16)} (img+0x1192): ${Array.from(new Uint8Array(dos4gwBuf, off1192, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

// Dump environment block to find program name
const envSeg = emu.memory.readU16(0x1000 + 0x2C); // PSP at 0x100 * 16 = 0x1000, env at +0x2C
const envLin = envSeg * 16;
console.log(`[ENV] envSeg=0x${envSeg.toString(16)} envLin=0x${envLin.toString(16)}`);
// Find double-null + word count + program name
let i = 0;
while (i < 1024) {
  if (emu.memory.readU8(envLin + i) === 0 && emu.memory.readU8(envLin + i + 1) === 0) {
    // Double null found
    const wordCount = emu.memory.readU16(envLin + i + 2);
    const nameStart = envLin + i + 4;
    let name = '';
    for (let j = 0; j < 128; j++) {
      const ch = emu.memory.readU8(nameStart + j);
      if (ch === 0) break;
      name += String.fromCharCode(ch);
    }
    console.log(`[ENV] double-null at offset ${i}, wordCount=${wordCount}, progName="${name}"`);
    // Also dump the 10 bytes before the name
    const before = [];
    for (let j = -5; j < name.length + 5; j++) before.push(emu.memory.readU8(nameStart + j).toString(16).padStart(2, '0'));
    console.log(`[ENV] bytes around name: ${before.join(' ')}`);
    break;
  }
  i++;
}

// Check memory at 0x2290 before overlay exec
console.log(`[PRE-EXEC] 0x2290: ${Array.from({length: 10}, (_, i) => emu.memory.readU8(0x2290 + i).toString(16).padStart(2, '0')).join(' ')}`);

// Verify DOS4GW file bytes at img offset 0x1190
const d4gDv = new DataView(dos4gwBuf);
const hdr = d4gDv.getUint16(8, true) * 16; // header size
console.log(`[FILE CHECK] dos4gw at offset 0x${(hdr + 0x1190).toString(16)}: ${Array.from(new Uint8Array(dos4gwBuf, hdr + 0x1190, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
console.log(`[FILE CHECK] dos4gw at offset 0x${(hdr + 0x118E).toString(16)}: ${Array.from(new Uint8Array(dos4gwBuf, hdr + 0x118E, 10)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

emu.traceApi = true;
emu.traceApi = true;
emu.run();

// Check memory at 0x2290 after run (overlay is loaded by now)
// We need to let a few steps execute to get past the overlay EXEC
import { cpuStep } from '../src/lib/emu/x86/dispatch.ts';
// Actually, run() starts the emulation. The EXEC happens during ticks.
// Let's just check after a tick.
emu.tick();
console.log(`[POST-TICK0] 0x2290: ${Array.from({length: 20}, (_, i) => emu.memory.readU8(0x2290 + i).toString(16).padStart(2, '0')).join(' ')}`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Restore all data files
import { readdirSync, statSync } from 'fs';
for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname !== 'EMUL5.EXE' && fname !== 'DOS4GW.EXE') {
    emu.additionalFiles.set(fname, readToArrayBuffer(fp));
  }
}
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

const MAX_TICKS = 5;
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
  if (i < 5 || i % 100 === 0) console.log(`[TICK ${i}] cpuSteps=${emu.cpuSteps} EIP=0x${eip.toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode}`);
}

// Set watchpoint on address 0xC9E to catch any write
emu.memory._watchAddr = 0xC9E;

// Check if address 0xC9E was ever written to
// We can't set a watchpoint, but let's check memory right after DPMI init vs at end
console.log(`[EARLY] @0xC9E: ${Array.from({length: 16}, (_, i) => emu.memory.readU8(0xC9E + i).toString(16).padStart(2, '0')).join(' ')}`);
// Also: how many non-zero bytes in 0x000-0x5970 (the limit of sel 0x98)?
let nz = 0;
for (let a = 0; a < 0x5970; a++) { if (emu.memory.readU8(a) !== 0) nz++; }
console.log(`[EARLY] Non-zero bytes in 0x0000-0x5970: ${nz}`);

// Check PM handler code — also check if code is at overlay base + offset
console.log(`[CODE] @0x1D9E (0x1100+0xC9E): ${Array.from({length: 16}, (_, i) => emu.memory.readU8(0x1D9E + i).toString(16).padStart(2, '0')).join(' ')}`);
// Check PM handler code at linear 0xC9E (sel 0x98 base=0, offset 0xC9E)
console.log(`[CODE] @0xC9E: ${Array.from({length: 16}, (_, i) => emu.memory.readU8(0xC9E + i).toString(16).padStart(2, '0')).join(' ')}`);
console.log(`[CODE] @0x1000 (PSP): ${Array.from({length: 8}, (_, i) => emu.memory.readU8(0x1000 + i).toString(16).padStart(2, '0')).join(' ')}`);

// Dump memory at the code segment where DOS4GW runs
const csSeg = 0x7364;
const csBase = csSeg * 16;
let nonZeroCount = 0;
for (let a = csBase; a < csBase + 0x30000; a += 256) {
  const b = emu.memory.readU8(a);
  if (b !== 0) nonZeroCount++;
}
console.log(`[MEM CHECK] CS=0x${csSeg.toString(16)} base=0x${csBase.toString(16)} non-zero 256-byte blocks in first 192K: ${nonZeroCount}/768`);
// Dump first 32 bytes
const first32 = Array.from({length: 32}, (_, i) => emu.memory.readU8(csBase + i).toString(16).padStart(2, '0'));
console.log(`[MEM CHECK] First 32 bytes: ${first32.join(' ')}`);

// Sample EIP at ~1M step intervals during last 10 ticks to find hot loops
if (totalTicks >= MAX_TICKS - 1) {
  const { cpuStep } = await import('../src/lib/emu/x86/dispatch.ts');
  const eipSamples = new Map();
  for (let s = 0; s < 200000; s++) {
    if (emu.cpu.halted) break;
    cpuStep(emu.cpu);
    if (s % 10000 === 0) {
      const e = emu.cpu.eip >>> 0;
      eipSamples.set(e, (eipSamples.get(e) || 0) + 1);
    }
  }
  // Top 5 most frequent EIPs
  const sorted = [...eipSamples.entries()].sort((a, b) => b[1] - a[1]);
  console.log('[HOT EIPs] ' + sorted.slice(0, 5).map(([eip, c]) => `0x${eip.toString(16)}(${c}x)`).join(' '));
  // Dump bytes at top EIP
  if (sorted.length > 0) {
    const topEip = sorted[0][0];
    const bytes = Array.from({length: 16}, (_, i) => emu.memory.readU8(topEip + i).toString(16).padStart(2, '0'));
    console.log(`[HOT CODE] @0x${topEip.toString(16)}: ${bytes.join(' ')}`);
  }
}
console.log(`[DONE] ticks=${totalTicks} cpuSteps=${emu.cpuSteps} halted=${emu.halted}`);
console.log(`  EIP=0x${(emu.cpu.eip >>> 0).toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode}`);
console.log(`  videoMode=0x${emu.videoMode.toString(16)} isGraphics=${emu.isGraphicsMode}`);
if (emu.cpu.haltReason) console.log(`  haltReason: ${emu.cpu.haltReason}`);

// Dump text-mode video memory (B8000) — first 4 lines
const VRAM = 0xB8000;
for (let row = 0; row < 4; row++) {
  let line = '';
  let attrs = '';
  for (let col = 0; col < 80; col++) {
    const ch = emu.memory.readU8(VRAM + (row * 80 + col) * 2);
    const at = emu.memory.readU8(VRAM + (row * 80 + col) * 2 + 1);
    line += ch >= 0x20 && ch < 0x7F ? String.fromCharCode(ch) : '.';
    if (col < 10) attrs += at.toString(16).padStart(2, '0') + ' ';
  }
  console.log(`  row${row}: "${line.trimEnd()}" attrs=[${attrs.trim()}]`);
}
