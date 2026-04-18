import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

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
  width: 800, height: 600,
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

const EXE_PATH = 'C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo-win32.exe';
const realArrayBuffer = readToArrayBuffer(EXE_PATH);
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.registryStore = new RegistryStore();
emu.profileStore = new ProfileStore();

// Capture console output for missing API detection
const notFound = new Set();
const origWarn = console.warn.bind(console);
const origLog = console.log.bind(console);
console.log = (...args) => {
  const s = args.join(' ');
  const m = s.match(/\[GetProcAddress\] Not found: "([^"]+)"/);
  if (m) notFound.add(m[1]);
  origLog(...args);
};

// Copy demo.dat into the emulator's virtual filesystem so the demo can open it
const demoDatBytes = readFileSync('C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo.dat');
emu.additionalFiles.set('demo.dat', demoDatBytes.buffer.slice(demoDatBytes.byteOffset, demoDatBytes.byteOffset + demoDatBytes.byteLength));

await emu.load(realArrayBuffer, peInfo, mockCanvas);
emu.run();

const MAX_TICKS = 5_000_000;
let ticks = 0;
let stuckCount = 0;
let lastEip = 0;
let waitCount = 0;
while (!emu.halted && ticks < MAX_TICKS) {
  if (emu.waitingForMessage) {
    // Feed an idle message so main loop keeps running
    emu.waitingForMessage = false;
    waitCount++;
    if (waitCount > 1000) break;
  }
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuckCount++; else { stuckCount = 0; lastEip = emu.cpu.eip; }
  if (stuckCount > 500) break;
}

console.log(`\n[TEST] ticks=${ticks} waiting=${emu.waitingForMessage} halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'}`);
console.log(`[TEST] Missing APIs: ${notFound.size}`);
for (const name of notFound) console.log(`  - ${name}`);

if (emu.waitingForMessage) {
  console.log('[TEST] SUCCESS: Reached message loop');
  process.exit(0);
} else if (emu.halted) {
  console.log('[TEST] HALTED');
  process.exit(1);
} else {
  console.log('[TEST] TIMEOUT or stuck');
  process.exit(1);
}
