import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

// Mock Canvas/OffscreenCanvas for headless Node.js
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

const baseDir = 'C:/Users/Olivier/Downloads/modplay230/v230/';
const exeBuf = readToArrayBuffer(baseDir + 'MOD4WIN.EXE');
const peInfo = parsePE(exeBuf);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.exePath = 'D:\\MODPLAY230\\V230\\MOD4WIN.EXE';
emu.exeName = 'MOD4WIN.EXE';

// Make companion files available so the loader/runtime can find them.
const dllPrefix = 'modplay230/v230/';
emu.additionalFiles.set(dllPrefix + 'MOD4WIN.EXE', exeBuf);
emu.additionalFiles.set(dllPrefix + 'PLAYER32.DLL', readToArrayBuffer(baseDir + 'PLAYER32.DLL'));
emu.additionalFiles.set(dllPrefix + 'RES_USA.DLL', readToArrayBuffer(baseDir + 'RES_USA.DLL'));
emu.additionalFiles.set(dllPrefix + 'RES_FRE.DLL', readToArrayBuffer(baseDir + 'RES_FRE.DLL'));
emu.additionalFiles.set(dllPrefix + 'RES_GER.DLL', readToArrayBuffer(baseDir + 'RES_GER.DLL'));
emu.additionalFiles.set(dllPrefix + 'RES_SPA.DLL', readToArrayBuffer(baseDir + 'RES_SPA.DLL'));
emu.additionalFiles.set(dllPrefix + 'MOD4WIN.INI', readToArrayBuffer(baseDir + 'MOD4WIN.INI'));
emu.additionalFiles.set(dllPrefix + 'MOD4WIN.STA', readToArrayBuffer(baseDir + 'MOD4WIN.STA'));

await emu.load(exeBuf, peInfo, mockCanvas);

// Trace API calls during startup to see what MOD4WIN does
emu.traceApi = process.env.TRACE === '1' || process.env.TRACE_API === '1';
emu.traceDosInt = process.env.TRACE === '1' || process.env.TRACE_FS === '1';

// Wrap the FAR call dispatcher to log enters/exits of integrity-related ords
const originalCs = emu.cpu.cs;
let lastTrace = -1;

emu.run();

const MAX_TICKS = 1000;
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX_TICKS) {
  emu.tick();
  ticks++;
}


if (emu.waitingForMessage) {
  console.log(`[TEST] SUCCESS: Reached message loop after ${ticks} ticks`);
  const mainWnd = emu.mainWindow ? emu.handles.get(emu.mainWindow) : null;
  console.log(`[TEST] MainWindow: 0x${(emu.mainWindow ?? 0).toString(16)} class=${mainWnd?.classInfo?.className} children=${mainWnd?.childList?.length ?? 0} title="${mainWnd?.title ?? ''}"`);
  if (mainWnd?.childList) {
    for (const ch of mainWnd.childList) {
      const w = emu.handles.get(ch);
      if (!w) continue;
      const cn = w.classInfo?.className || '?';
      console.log(`  child 0x${ch.toString(16)} class="${cn}" vis=${w.visible} pos=(${w.x},${w.y}) size=${w.width}x${w.height} children=${w.childList?.length || 0}`);
    }
  }
  // Diagnose if no main window
  if (!emu.mainWindow) {
    console.log(`[TEST] No main window. Registered classes: ${[...(emu.windowClasses?.keys?.() ?? [])].join(', ')}`);
  }
} else if (emu.halted) {
  console.error(`[TEST] HALTED after ${ticks} ticks: reason=${emu.haltReason}`);
} else {
  console.error(`[TEST] TIMEOUT after ${MAX_TICKS} ticks`);
}
