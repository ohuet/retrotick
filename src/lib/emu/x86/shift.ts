import type { CPU } from './cpu';
import { LazyOp } from './lazy-op';

// Flag bits
const CF = 0x001;
const OF = 0x800;

export function doShift(cpu: CPU, op: number, val: number, count: number, size: 8 | 16 | 32): number {
  const mask = size === 8 ? 0xFF : size === 16 ? 0xFFFF : 0xFFFFFFFF;
  let v = val & mask;

  switch (op) {
    case 0: { // ROL
      const c = count % size;
      const result = ((v << c) | (v >>> (size - c))) & mask;
      const lastBitOut = result & 1;
      const f = cpu.getFlags() & ~(CF | OF);
      cpu.setFlags(f | (lastBitOut ? CF : 0) |
        ((count === 1 && ((result ^ (result >>> (size - 1))) & 1)) ? OF : 0));
      return size === 32 ? result >>> 0 : result;
    }
    case 1: { // ROR
      const c = count % size;
      const result = ((v >>> c) | (v << (size - c))) & mask;
      const lastBitOut = (result >>> (size - 1)) & 1;
      const f = cpu.getFlags() & ~(CF | OF);
      cpu.setFlags(f | (lastBitOut ? CF : 0) |
        ((count === 1 && (((result >>> (size - 1)) ^ ((result >>> (size - 2)))) & 1)) ? OF : 0));
      return size === 32 ? result >>> 0 : result;
    }
    case 2: { // RCL
      let carry = cpu.getFlag(CF) ? 1 : 0;
      const total = size + 1;
      const c = count % total;
      for (let i = 0; i < c; i++) {
        const topBit = (v >>> (size - 1)) & 1;
        v = ((v << 1) | carry) & mask;
        carry = topBit;
      }
      const f = cpu.getFlags() & ~(CF | OF);
      cpu.setFlags(f | (carry ? CF : 0));
      return size === 32 ? v >>> 0 : v;
    }
    case 3: { // RCR
      let carry = cpu.getFlag(CF) ? 1 : 0;
      const total = size + 1;
      const c = count % total;
      for (let i = 0; i < c; i++) {
        const lowBit = v & 1;
        v = ((v >>> 1) | (carry << (size - 1))) & mask;
        carry = lowBit;
      }
      const f = cpu.getFlags() & ~(CF | OF);
      cpu.setFlags(f | (carry ? CF : 0));
      return size === 32 ? v >>> 0 : v;
    }
    case 4: case 6: { // SHL/SAL
      const lastOut = (v >>> (size - count)) & 1;
      const result = (v << count) & mask;
      cpu.setLazy(
        size === 8 ? LazyOp.SHL8 : size === 16 ? LazyOp.SHL16 : LazyOp.SHL32,
        result, val, lastOut
      );
      return size === 32 ? result >>> 0 : result;
    }
    case 5: { // SHR
      const lastOut = (v >>> (count - 1)) & 1;
      const result = (v >>> count) & mask;
      cpu.setLazy(
        size === 8 ? LazyOp.SHR8 : size === 16 ? LazyOp.SHR16 : LazyOp.SHR32,
        result, val, lastOut
      );
      return size === 32 ? result >>> 0 : result;
    }
    case 7: { // SAR
      let sv: number;
      if (size === 8) sv = (v << 24) >> 24;
      else if (size === 16) sv = (v << 16) >> 16;
      else sv = v | 0;
      const lastOut = (sv >> (count - 1)) & 1;
      const result = (sv >> count) & mask;
      cpu.setLazy(
        size === 8 ? LazyOp.SAR8 : size === 16 ? LazyOp.SAR16 : LazyOp.SAR32,
        result, val, lastOut
      );
      return size === 32 ? result >>> 0 : result;
    }
    default:
      return val;
  }
}

export function doShld(dest: number, src: number, count: number, size: number): { result: number; carryOut: number } {
  const mask = size === 16 ? 0xFFFF : 0xFFFFFFFF;
  const d = dest & mask;
  const s = src & mask;

  if (size === 16) {
    const combined = ((d << 16) | s);
    const result = ((combined << count) >>> 16) & 0xFFFF;
    const carryOut = (combined >>> (32 - count)) & 1;
    return { result, carryOut };
  }

  const result = (count < 32) ? ((d << count) | ((s >>> 0) >>> (32 - count))) : 0;
  const carryOut = (d >>> (32 - count)) & 1;
  return { result: result | 0, carryOut };
}

export function doShrd(dest: number, src: number, count: number, size: number): { result: number; carryOut: number } {
  const mask = size === 16 ? 0xFFFF : 0xFFFFFFFF;
  const d = dest & mask;
  const s = src & mask;

  if (size === 16) {
    const combined = ((s << 16) | d);
    const result = ((combined >>> count) & 0xFFFF);
    const carryOut = (combined >>> (count - 1)) & 1;
    return { result, carryOut };
  }

  const result = (count < 32) ? (((d >>> 0) >>> count) | (s << (32 - count))) : 0;
  const carryOut = ((d >>> 0) >>> (count - 1)) & 1;
  return { result: result | 0, carryOut };
}
