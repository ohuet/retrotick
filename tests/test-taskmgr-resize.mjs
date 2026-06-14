// Test: taskmgr.exe Performance-tab resize regression.
// Two bugs hit when resizing while the Performance tab was active, both caused by
// callStdcall not being transparent to the paused x86 CPU state when invoked from
// a JS render path (renderChildControls/sendCtlColor/sendDrawItem, depth 0):
//   1. EIP leak: the callback's `ret` lands on the WNDPROC_RETURN thunk
//      (0x00FE0000) whose handler does not advance EIP; the leftover leaked into
//      the main emuTick loop → stale WNDPROC_RETURN → [ESP]=0 → EIP=0 → WILD EIP.
//   2. EAX clobber: an overlay repaint clobbered the paused pump's EAX (which held
//      a just-delivered GetMessage result), so `call GetMessage; test eax; jz exit`
//      took the exit branch → taskmgr quit on resize.
// Fixed by making callStdcall save/restore EIP + EAX/ECX/EDX on synchronous return.
// This test drives the real browser resize flow (applyCanvasToEmu: WM_GETMINMAXINFO
// + setupCanvasSize + wnd size update + WM_SIZE + notifyControlOverlays) across many
// sizes and asserts the app never halts (stays in its message loop).
import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mkCtx = () => ({
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
});
const mkCanvas = (w = 640, h = 480) => {
  const c = { width: w, height: h, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,',
    addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
  const ctx = mkCtx(); ctx.canvas = c; return c;
};
const mockCanvas = mkCanvas();
globalThis.document = { createElement: () => mkCanvas(), title: '', getElementById: () => null, body: { appendChild: noop } };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { const x = mkCtx(); x.canvas = this; return x; } };
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

const buf = readToArrayBuffer('C:/Users/Olivier/Downloads/taskmgr.exe');
const peInfo = parsePE(buf);
const emu = new Emulator();
emu.screenWidth = 640; emu.screenHeight = 480;
emu.exeName = 'taskmgr.exe'; emu.exePath = 'C:\\taskmgr.exe';
const makeLParam = (lo, hi) => ((lo & 0xFFFF) | ((hi & 0xFFFF) << 16)) >>> 0;

// Capture overlays so owner-draw companion canvases get domCanvas set (browser-like)
emu.onControlsChanged = (controls) => {
  for (const c of controls) {
    if (c.className === 'BUTTON' && (c.style & 0xF) === 0xB) {
      const wnd = emu.handles.get(c.childHwnd);
      if (wnd && !wnd.domCanvas) wnd.domCanvas = mkCanvas(c.width || 10, c.height || 10);
    }
  }
};

await emu.load(buf, peInfo, mockCanvas);
emu.run();

const WM_SIZE = 0x0005, WM_NOTIFY = 0x004E;
const TCN_SELCHANGING = (-552) >>> 0, TCN_SELCHANGE = (-551) >>> 0;
function pump(n) { for (let i = 0; i < n; i++) { emu.tick(); if (emu.halted) return false; } return true; }

let reached = false;
for (let i = 0; i < 4000; i++) { if (emu.halted) break; emu.tick(); if (emu.waitingForMessage) { reached = true; break; } }
console.log(`[LOOP] reached=${reached} cpuSteps=${emu.cpuSteps} halted=${emu.halted}`);
pump(50);

const wnd = emu.handles.get(emu.mainWindow);
let tabHwnd = 0, tabId = 0;
for (const ch of (wnd?.childList || [])) {
  const c = emu.handles.get(ch);
  if (c?.classInfo?.className?.toUpperCase() === 'SYSTABCONTROL32') { tabHwnd = ch; tabId = c.controlId ?? 0; break; }
}
function mkNmhdr(code) { const p = emu.allocHeap(12); emu.memory.writeU32(p, tabHwnd); emu.memory.writeU32(p + 4, tabId); emu.memory.writeU32(p + 8, code >>> 0); return p; }
const tabWnd = emu.handles.get(tabHwnd);
// Switch to the Performance tab (index 2) via WM_NOTIFY TCN_SELCHANGE.
emu.postMessage(emu.mainWindow, WM_NOTIFY, tabId, mkNmhdr(TCN_SELCHANGING));
if (tabWnd) tabWnd.tabSelectedIndex = 2;
emu.postMessage(emu.mainWindow, WM_NOTIFY, tabId, mkNmhdr(TCN_SELCHANGE));
pump(80);
console.log(`[PERF TAB] halted=${emu.halted}`);

// Mirror the browser's applyCanvasToEmu() EXACTLY: update wnd.width/height to
// the FULL window size (client + borders + caption + menu), post WM_SIZE with
// the CLIENT size as lParam, then notifyControlOverlays.
const WM_GETMINMAXINFO = 0x0024;
// taskmgr main window: WS_THICKFRAME (bw=4) + WS_CAPTION (19) + menu (19)
const BW = 4, CAPTION = 19, MENU = 19;
function applyCanvasToEmu(w, h) {
  const wnd = emu.handles.get(emu.mainWindow);
  emu.setupCanvasSize(w, h);
  wnd.width = w + 2 * BW;
  wnd.height = h + 2 * BW + CAPTION + MENU;
  const queue = emu.messageQueue;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].hwnd === emu.mainWindow && queue[i].message === WM_SIZE) queue.splice(i, 1);
  }
  emu.postMessage(emu.mainWindow, WM_SIZE, 0, makeLParam(w, h));
  wnd.needsPaint = true; wnd.needsErase = true;
  emu.notifyControlOverlays();
}
let crashed = false;
for (let round = 0; round < 6 && !emu.halted; round++) {
  const [w, h] = [[404,446],[300,320],[520,500],[260,280],[600,460],[404,446]][round];
  const mmi = emu.allocHeap(40);
  emu.postMessage(emu.mainWindow, WM_GETMINMAXINFO, 0, mmi);
  applyCanvasToEmu(w, h);
  for (let i = 0; i < 120; i++) {
    if (emu.halted) break;
    emu.tick();
    if (emu.halted) { crashed = true; console.log(`[HALT] round=${round} i=${i} eip=0x${(emu.cpu.eip>>>0).toString(16)} reason="${emu.cpu.haltReason || emu.haltReason}" exitedNormally=${emu.exitedNormally}`); break; }
  }
  console.log(`[ROUND ${round}] ${w}x${h} halted=${emu.halted} cpuSteps=${emu.cpuSteps}`);
}
console.log(`[DONE] halted=${emu.halted} wfm=${emu.waitingForMessage} eip=0x${(emu.cpu.eip>>>0).toString(16)}`);
if (crashed || emu.halted) {
  console.log('[TEST] FAIL: taskmgr halted during Performance-tab resize');
  process.exit(1);
}
console.log('[TEST] SUCCESS: survived all Performance-tab resizes, still in message loop');
process.exit(0);
