import type { CPU } from './cpu';
import { LazyOp } from './lazy-op';

// Flag bits
const DF = 0x400;
const ZF = 0x040;

// Register indices
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// Helper: compute source (DS:SI) and dest (ES:DI) linear addresses, respecting 16-bit mode
function stringSrc(cpu: CPU): number {
  if (cpu._addrSize16) {
    const si = cpu.reg[ESI] & 0xFFFF;
    const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
    return (cpu.segBase(segSel) + si) >>> 0;
  }
  let addr = cpu.reg[ESI] >>> 0;
  if (cpu._segOverride === 0x64) addr = (addr + cpu.fsBase) >>> 0;
  else if (cpu._segOverride) addr = (addr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
  else if (!cpu.use32) addr = (addr + cpu.segBase(cpu.ds)) >>> 0;
  return addr;
}

function stringDst(cpu: CPU): number {
  if (cpu._addrSize16) {
    const di = cpu.reg[EDI] & 0xFFFF;
    return (cpu.segBase(cpu.es) + di) >>> 0;
  }
  // String destination is always ES (not overridable), but need ES base in real mode
  if (!cpu.use32) return (cpu.segBase(cpu.es) + (cpu.reg[EDI] >>> 0)) >>> 0;
  return cpu.reg[EDI] >>> 0;
}

function advanceSI(cpu: CPU, delta: number): void {
  if (cpu._addrSize16) {
    const si = ((cpu.reg[ESI] & 0xFFFF) + delta) & 0xFFFF;
    cpu.reg[ESI] = (cpu.reg[ESI] & ~0xFFFF) | si;
  } else {
    cpu.reg[ESI] = (cpu.reg[ESI] + delta) | 0;
  }
}

function advanceDI(cpu: CPU, delta: number): void {
  if (cpu._addrSize16) {
    const di = ((cpu.reg[EDI] & 0xFFFF) + delta) & 0xFFFF;
    cpu.reg[EDI] = (cpu.reg[EDI] & ~0xFFFF) | di;
  } else {
    cpu.reg[EDI] = (cpu.reg[EDI] + delta) | 0;
  }
}

function decCount(cpu: CPU): void {
  if (cpu._addrSize16) {
    const cx = ((cpu.reg[ECX] & 0xFFFF) - 1) & 0xFFFF;
    cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | cx;
  } else {
    cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
  }
}

function getCount(cpu: CPU): number {
  return cpu._addrSize16 ? (cpu.reg[ECX] & 0xFFFF) : (cpu.reg[ECX] | 0);
}

export function doMovs(cpu: CPU, unitSize: number, rep: boolean): void {
  const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
  const doOne = () => {
    const src = stringSrc(cpu);
    const dst = stringDst(cpu);
    if (unitSize === 1) cpu.mem.writeU8(dst, cpu.mem.readU8(src));
    else if (unitSize === 2) cpu.mem.writeU16(dst, cpu.mem.readU16(src));
    else cpu.mem.writeU32(dst, cpu.mem.readU32(src));
    advanceSI(cpu, delta);
    advanceDI(cpu, delta);
  };

  if (rep) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
    }
  } else {
    doOne();
  }
}

export function doStos(cpu: CPU, unitSize: number, rep: boolean): void {
  const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
  const val = unitSize === 1 ? cpu.getReg8(EAX) : unitSize === 2 ? cpu.getReg16(EAX) : cpu.reg[EAX] | 0;
  const doOne = () => {
    const dst = stringDst(cpu);
    if (unitSize === 1) cpu.mem.writeU8(dst, val);
    else if (unitSize === 2) cpu.mem.writeU16(dst, val);
    else cpu.mem.writeU32(dst, val >>> 0);
    advanceDI(cpu, delta);
  };

  if (rep) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
    }
  } else {
    doOne();
  }
}

export function doLods(cpu: CPU, unitSize: number, rep: boolean): void {
  const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
  const doOne = () => {
    const src = stringSrc(cpu);
    if (unitSize === 1) cpu.setReg8(EAX, cpu.mem.readU8(src));
    else if (unitSize === 2) cpu.setReg16(EAX, cpu.mem.readU16(src));
    else cpu.reg[EAX] = cpu.mem.readU32(src) | 0;
    advanceSI(cpu, delta);
  };

  if (rep) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
    }
  } else {
    doOne();
  }
}

export function doCmps(cpu: CPU, unitSize: number, repE: boolean, repNE: boolean): void {
  const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
  const doOne = () => {
    const src = stringSrc(cpu);
    const dst = stringDst(cpu);
    let a: number, b: number;
    if (unitSize === 1) { a = cpu.mem.readU8(src); b = cpu.mem.readU8(dst); }
    else if (unitSize === 2) { a = cpu.mem.readU16(src); b = cpu.mem.readU16(dst); }
    else { a = cpu.mem.readU32(src); b = cpu.mem.readU32(dst); }
    const subOp = unitSize === 1 ? LazyOp.SUB8 : unitSize === 2 ? LazyOp.SUB16 : LazyOp.SUB32;
    cpu.setLazy(subOp, (a - b) | 0, a, b);
    advanceSI(cpu, delta);
    advanceDI(cpu, delta);
  };

  if (repE) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
      if (!cpu.getFlag(ZF)) break;
    }
  } else if (repNE) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
      if (cpu.getFlag(ZF)) break;
    }
  } else {
    doOne();
  }
}

export function doScas(cpu: CPU, unitSize: number, repE: boolean, repNE: boolean): void {
  const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
  const doOne = () => {
    const dst = stringDst(cpu);
    let a: number, b: number;
    if (unitSize === 1) { a = cpu.getReg8(EAX); b = cpu.mem.readU8(dst); }
    else if (unitSize === 2) { a = cpu.getReg16(EAX); b = cpu.mem.readU16(dst); }
    else { a = cpu.reg[EAX] | 0; b = cpu.mem.readU32(dst) | 0; }
    const subOp = unitSize === 1 ? LazyOp.SUB8 : unitSize === 2 ? LazyOp.SUB16 : LazyOp.SUB32;
    cpu.setLazy(subOp, (a - b) | 0, a, b);
    advanceDI(cpu, delta);
  };

  if (repE) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
      if (!cpu.getFlag(ZF)) break;
    }
  } else if (repNE) {
    while (getCount(cpu) !== 0) {
      doOne();
      decCount(cpu);
      if (cpu.getFlag(ZF)) break;
    }
  } else {
    doOne();
  }
}
