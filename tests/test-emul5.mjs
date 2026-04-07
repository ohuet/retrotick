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

// Check memory at 0x13060 (CS:[5680h] for dos4gw handler data)
console.log(`[PRE-DPMI] Mem at 0x13060 = 0x${emu.memory.readU16(0x13060).toString(16)} (before any ticks)`);
// Verify GDT memory works
const gdtBase = emu._gdtBase;
console.log(`[DIAG] _gdtBase=0x${(gdtBase>>>0).toString(16)} a20=0x${emu.memory.a20Mask.toString(16)}`);
// Check initial entry (0x08 = index 1)
const hi1 = emu.memory.readU32(gdtBase + 1 * 8 + 4);
console.log(`[DIAG] GDT[0x08] hi=0x${(hi1>>>0).toString(16).padStart(8,'0')}`);
// Write test value to a high entry and read it back
const testAddr = gdtBase + 0x14c8 + 4;
emu.memory.writeU32(testAddr, 0xDEADBEEF);
const readBack = emu.memory.readU32(testAddr);
console.log(`[DIAG] Write 0xDEADBEEF to 0x${(testAddr>>>0).toString(16)} → read back 0x${(readBack>>>0).toString(16).padStart(8,'0')}`);
// Reset it
emu.memory.writeU32(testAddr, 0);

// Trap: detect when CS transitions away from 0x14c8 to an unexpected value
const RING_SIZE = 256;
const ringEIP = new Uint32Array(RING_SIZE);
const ringCS = new Uint16Array(RING_SIZE);
const ringSP = new Uint32Array(RING_SIZE);
let ringIdx = 0;
let trapFired = false;
const origStep = emu.cpu.step.bind(emu.cpu);
emu.cpu.step = function() {
  const prevCS = this.cs;
  ringEIP[ringIdx] = this.eip >>> 0;
  ringCS[ringIdx] = this.cs;
  ringSP[ringIdx] = this.reg[4] >>> 0;
  ringIdx = (ringIdx + 1) & (RING_SIZE - 1);
  origStep();
  // Only trap on actual halts (disable CS-transition trap for now)
  if (false) {
    trapFired = true;
    trapFired = true;
    console.log(`[TRAP] CS changed from 0x${prevCS.toString(16)} to 0x${this.cs.toString(16)} at step ${emu.cpuSteps}`);
    // Dump ring buffer for the handler execution
    console.log(`[RING] Last ${RING_SIZE} instructions:`);
    for (let j = 0; j < RING_SIZE; j++) {
      const idx2 = (ringIdx + j) & (RING_SIZE - 1);
      const eip2 = ringEIP[idx2];
      const cs2 = ringCS[idx2];
      const esp2 = ringSP[idx2];
      if (eip2 === 0 && cs2 === 0) continue;
      const bytes = [];
      for (let b = 0; b < 6; b++) bytes.push(emu.memory.readU8(eip2 + b).toString(16).padStart(2, '0'));
      console.log(`  [${j}] CS=0x${cs2.toString(16)} EIP=0x${eip2.toString(16)} ESP=0x${esp2.toString(16)} [${bytes.join(' ')}]`);
    }
    // Halt to prevent further execution
    this.halted = true;
    this.haltReason = 'trap';
    return;
    // Dump the far pointer that was just read (at DS:0x0022)
    const dsBase = emu.cpu.segBases.get(this.ds) || 0;
    console.log(`  dsBase=0x${(dsBase>>>0).toString(16)} [DS:0022]=off:0x${emu.memory.readU16(dsBase+0x22).toString(16)} sel:0x${emu.memory.readU16(dsBase+0x24).toString(16)}`);
    // Dump GDT entry for the source CS and new CS
    const gdtBase = emu._gdtBase;
    console.log(`  _gdtBase=0x${(gdtBase>>>0).toString(16)} _gdtLimit=0x${emu._gdtLimit.toString(16)}`);
    for (const s of [0x14c8, this.cs]) {
      const idx = (s & 0xFFF8) >>> 3;
      const dAddr = gdtBase + idx * 8;
      const lo = emu.memory.readU32(dAddr);
      const hi = emu.memory.readU32(dAddr + 4);
      const base = ((hi >>> 24) << 24) | ((hi & 0xFF) << 16) | ((lo >>> 16) & 0xFFFF);
      const limitLo = lo & 0xFFFF;
      const limitHi = (hi >>> 16) & 0x0F;
      const limit = (limitHi << 16) | limitLo;
      const access = (hi >>> 8) & 0xFF;
      const flags = (hi >>> 20) & 0x0F;
      const dBit = (flags & 0x04) !== 0;
      const gBit = (flags & 0x08) !== 0;
      console.log(`  GDT[0x${s.toString(16)}] base=0x${(base>>>0).toString(16)} limit=0x${limit.toString(16)} access=0x${access.toString(16)} flags=0x${flags.toString(16)} D=${dBit?1:0} G=${gBit?1:0}`);
      console.log(`    raw: lo=0x${(lo>>>0).toString(16).padStart(8,'0')} hi=0x${(hi>>>0).toString(16).padStart(8,'0')}`);
    }
    // Dump last 32 instructions before this transition
    console.log(`  Last 32 instructions before transition:`);
    for (let j = 32; j >= 1; j--) {
      const idx = (ringIdx - j + RING_SIZE) & (RING_SIZE - 1);
      const bytes = [];
      for (let b = 0; b < 8; b++) bytes.push(emu.memory.readU8(ringEIP[idx] + b).toString(16).padStart(2, '0'));
      console.log(`    CS=0x${ringCS[idx].toString(16)} EIP=0x${ringEIP[idx].toString(16)} ESP=0x${ringSP[idx].toString(16)} [${bytes.join(' ')}]`);
    }
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_TICKS = 200;
let totalTicks = 0;

for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) {
    console.log(`[HALT] after ${totalTicks} ticks: ${emu.cpu.haltReason}`);
    // Dump ring buffer
    console.log(`[TRACE] Last ${RING_SIZE} instructions before crash:`);
    let prevCS = -1;
    for (let j = 0; j < RING_SIZE; j++) {
      const idx = (ringIdx + j) & (RING_SIZE - 1);
      const eip = ringEIP[idx];
      const cs = ringCS[idx];
      const esp = ringSP[idx];
      const rm = ringRM[idx];
      if (eip !== 0 || cs !== 0) {
        const csChanged = cs !== prevCS;
        const marker = csChanged ? ' <<<' : '';
        // Show bytes for all entries near CS transition
        const nearTransition = j >= 0 && j <= 25;
        let extra = '';
        if (nearTransition) {
          const bytes = [];
          for (let b = 0; b < 8; b++) bytes.push(emu.memory.readU8(eip + b).toString(16).padStart(2, '0'));
          extra = ` [${bytes.join(' ')}]`;
        }
        console.log(`  [${j}] CS=0x${cs.toString(16)} EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)} RM=${rm}${extra}${marker}`);
        if (csChanged && prevCS !== -1) {
          const base = emu.cpu.segBases.get(cs);
          console.log(`       segBase(0x${cs.toString(16)})=${base !== undefined ? '0x'+base.toString(16) : 'undefined'}`);
          // Dump stack at transition point
          const prevIdx = (ringIdx + j - 1) & (RING_SIZE - 1);
          const prevESP = ringSP[prevIdx];
          const ssBase = emu.cpu.segBases.get(emu.cpu.ss) || 0;
          console.log(`       SS=0x${emu.cpu.ss.toString(16)} ssBase=0x${ssBase.toString(16)}`);
          console.log(`       Stack before RETF (at SS:${prevESP.toString(16)}):`);
          for (let s = 0; s < 8; s++) {
            const addr = ssBase + prevESP + s * 2;
            const w = emu.memory.readU16(addr);
            console.log(`         [SP+${(s*2).toString(16)}] = 0x${w.toString(16).padStart(4, '0')} (linear 0x${addr.toString(16)})`);
          }
        }
        prevCS = cs;
      }
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
  // Check LDT entry for selector 0xF34 at address 0xF30
  if (i <= 10) {
    const ldtVal = emu.memory.readU32(0xF30);
    if (ldtVal !== 0) console.log(`[LDT-WATCH] tick${i}: @0xF30 = 0x${(ldtVal>>>0).toString(16)}`);
  }
  // Check key memory locations during execution
  if (i <= 5 && emu._gdtBase) {
    // CS=0x98 base is 0xD9E0, offset 0x5680 → linear 0x13060
    const val5680 = emu.memory.readU16(0x13060);
    console.log(`[MEM @tick${i}] CS:[5680h]=0x${val5680.toString(16)} (at linear 0x13060)`);
  }
  // Dump GDT entries at specific ticks after DPMI is active
  if ((i === 2 || i === 5 || i === 10) && emu._gdtBase) {
    const gb = emu._gdtBase;
    console.log(`[GDT @tick${i}] base=0x${(gb>>>0).toString(16)} a20=0x${emu.memory.a20Mask.toString(16)}`);
    for (const sel of [0x08, 0x98, 0x14c8]) {
      const idx = (sel & 0xFFF8) >>> 3;
      const dA = gb + idx * 8;
      const lo = emu.memory.readU32(dA);
      const hi = emu.memory.readU32(dA + 4);
      console.log(`  [0x${sel.toString(16)}] lo=0x${(lo>>>0).toString(16).padStart(8,'0')} hi=0x${(hi>>>0).toString(16).padStart(8,'0')}`);
    }
  }
}

console.log(`[DONE] ticks=${totalTicks} cpuSteps=${emu.cpuSteps} halted=${emu.halted}`);
console.log(`  videoMode=0x${emu.videoMode.toString(16)} isGraphics=${emu.isGraphicsMode}`);
if (emu.cpu.haltReason) console.log(`  haltReason: ${emu.cpu.haltReason}`);
