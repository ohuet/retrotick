import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleInt09, handleInt16 } from './keyboard';
import { handleInt10 } from './video';
import { handleInt21 } from './int21';
import { handleInt15, handleInt1A, handleInt20, handleInt2F, handleInt33 } from './misc';

export { handleInt21 } from './int21';
export { syncVideoMemory } from './video';

const EAX = 0;

/** Handle DOS/BIOS interrupts. Returns true if handled, false if not. */
export function handleDosInt(cpu: CPU, intNum: number, emu: Emulator): boolean {
  // For hardware interrupts that programs hook (INT 09h keyboard),
  // dispatch to the custom handler instead of built-in emulation.
  // But if CS == 0xF000, we're in a BIOS stub (program chained to original
  // vector), so use the built-in handler instead.
  if ((intNum === 0x08 || intNum === 0x09 || intNum === 0x16) && cpu.cs !== 0xF000) {
    const biosDefault = (0xF000 << 16) | (intNum * 3);
    const vec = emu._dosIntVectors.get(intNum) ?? biosDefault;
    if (vec !== biosDefault) {
      const seg = (vec >>> 16) & 0xFFFF;
      const off = vec & 0xFFFF;
      const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
      cpu.push16(cpu.getFlags() & 0xFFFF);
      cpu.push16(cpu.cs);
      cpu.push16(returnIP);
      cpu.cs = seg;
      cpu.eip = cpu.segBase(seg) + off;
      return true;
    }
  }

  switch (intNum) {
    case 0x08: // Timer tick (IRQ0) — update BIOS tick counter at 0x46C
      emu.memory.writeU32(0x46C, (emu.memory.readU32(0x46C) + 1) >>> 0);
      return true;
    case 0x09: return handleInt09(cpu, emu);
    case 0x12: // Get conventional memory size → AX = KB (640)
      cpu.setReg16(EAX, 640);
      return true;
    case 0x10: return handleInt10(cpu, emu);
    case 0x16: return handleInt16(cpu, emu, cpu.cs === 0xF000);
    case 0x20: return handleInt20(cpu, emu);
    case 0x21: return handleInt21(cpu, emu);
    case 0x15: return handleInt15(cpu, emu);
    case 0x33: return handleInt33(cpu, emu);
    case 0x2A: // Network — not installed
      cpu.setReg8(EAX, 0); // AL=0 means not installed
      return true;
    case 0x1A: return handleInt1A(cpu, emu);
    case 0x2F: return handleInt2F(cpu, emu);
    default:
      if (cpu.realMode) {
        // Check if program installed a custom handler via INT 21h AH=25h
        const biosDefault = (0xF000 << 16) | (intNum * 3);
        const vec = emu._dosIntVectors.get(intNum);
        if (vec && vec !== biosDefault) {
          const seg = (vec >>> 16) & 0xFFFF;
          const off = vec & 0xFFFF;
          const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
          cpu.push16(cpu.getFlags() & 0xFFFF);
          cpu.push16(cpu.cs);
          cpu.push16(returnIP);
          cpu.cs = seg;
          cpu.eip = cpu.segBase(seg) + off;
          return true;
        }
        // No custom handler — just IRET
        return true;
      }
      return false;
  }
}
