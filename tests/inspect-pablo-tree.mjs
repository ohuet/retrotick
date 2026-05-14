import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';

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

const EXE_PATH = 'C:/Users/Olivier/Downloads/PabloDraw-2.0.8.70/PabloDraw.exe';
const buf = readFileSync(EXE_PATH);
const ab = new ArrayBuffer(buf.byteLength);
new Uint8Array(ab).set(buf);

const peInfo = parsePE(ab);
const emu = new Emulator();
emu.screenWidth = 1024;
emu.screenHeight = 768;
emu.registryStore = new RegistryStore();

// silence noisy logs
const origLog = console.log;
console.log = () => {};
await emu.load(ab, peInfo, mockCanvas);
emu.run();

const MAX = 2_000_000;
let ticks = 0, lastEip = 0, stuck = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX) {
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuck++; else { stuck = 0; lastEip = emu.cpu.eip; }
  if (stuck > 5000) break;
}
console.log = origLog;
console.log(`Reached msg loop after ${ticks} ticks`);

function dumpTree(hwnd, depth = 0) {
  const w = emu.handles.get(hwnd);
  if (!w) return;
  const indent = '  '.repeat(depth);
  const cn = w.classInfo?.className || '?';
  console.log(`${indent}0x${hwnd.toString(16)} ${cn.padEnd(36)} vis=${w.visible} pos=(${w.x},${w.y}) size=${w.width}x${w.height} ctrlId=${w.controlId ?? '-'} style=0x${(w.style >>> 0).toString(16)}`);
  if (w.childList) {
    for (const ch of w.childList) dumpTree(ch, depth + 1);
  }
}

console.log(`\n=== Main window 0x${emu.mainWindow.toString(16)} tree ===`);
dumpTree(emu.mainWindow);

// Now simulate the overlay collection (same logic as emu-render.ts collectChildren)
console.log('\n=== Overlays emitted by collectChildren ===');
function collect(wnd, ox, oy, out) {
  if (!wnd.childList) return;
  for (const childHwnd of wnd.childList) {
    const child = emu.handles.get(childHwnd);
    if (!child) continue;
    const cn = child.classInfo?.className?.toUpperCase();
    if (cn === 'MDICLIENT') {
      if (child.childList) {
        for (const mch of child.childList) {
          const mc = emu.handles.get(mch);
          if (!mc) continue;
          if (!mc.visible && !mc.minimized) continue;
          out.push({ hwnd: mch, info: mc, ox: ox + child.x, oy: oy + child.y, isMdi: true });
          if (!mc.minimized && mc.childList) {
            collect(mc, ox + child.x + mc.x, oy + child.y + mc.y, out);
          }
        }
      }
      continue;
    }
    if (!child.visible) continue;
    out.push({ hwnd: childHwnd, info: child, ox, oy });
    if (child.childList) collect(child, ox + child.x, oy + child.y, out);
  }
}
const out = [];
const main = emu.handles.get(emu.mainWindow);
collect(main, 0, 0, out);
for (const { hwnd, info, ox, oy } of out) {
  const cn = info.classInfo?.className || '?';
  console.log(`  0x${hwnd.toString(16)} ${cn.padEnd(30)} world=(${info.x+ox},${info.y+oy}) size=${info.width}x${info.height}`);
}
process.exit(0);
