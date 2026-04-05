import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';

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

// Helper: read file into proper ArrayBuffer
function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

// Load PBRUSH.EXE + companion DLLs
const realArrayBuffer = readToArrayBuffer('H:/WINDOWS/PBRUSH.EXE');
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.registryStore = new RegistryStore();
// Load companion DLLs that PBRUSH imports
emu.additionalFiles.set('PBRUSH.DLL', readToArrayBuffer('H:/WINDOWS/PBRUSH.DLL'));
emu.additionalFiles.set('OLESVR.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/OLESVR.DLL'));
await emu.load(realArrayBuffer, peInfo, mockCanvas);
emu.run();

// Tick until message loop reached or MessageBox shown
const MAX_TICKS = 500;
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX_TICKS) {
  emu.tick();
  ticks++;
}

if (emu.waitingForMessage) {
  const mainWnd = emu.handles.get(emu.mainWindow);
  console.log(`[TEST] SUCCESS: Reached message loop after ${ticks} ticks`);
  console.log(`[TEST] MainWindow: 0x${emu.mainWindow.toString(16)} class="${mainWnd?.classInfo?.className}" title="${mainWnd?.title}" size=${mainWnd?.width}x${mainWnd?.height} style=0x${(mainWnd?.style||0).toString(16)}`);
} else if (emu.halted) {
  console.error(`[TEST] HALTED after ${ticks} ticks: ${emu.cpu.haltReason}`);
} else {
  console.error(`[TEST] TIMEOUT after ${MAX_TICKS} ticks`);
}
