// Virtual DMA Services (VDS) — INT 4Bh AX=81xx
//
// VDS lets DOS programs running under a memory manager (EMM386, DPMI host,
// V86 monitor) safely program DMA controllers. Under paging, a program's
// virtual/linear address doesn't match the physical DMA address, so the
// program asks VDS to translate and lock buffer regions.
//
// In this emulator memory is flat linear (no paging), so physical == linear.
// Every service can succeed as a trivial no-op that reports the caller's
// own linear address back as the physical address.
//
// Spec reference: Ralf Brown's Interrupt List, INT 4Bh.
// Presence: BDA byte 40h:7Bh bit 5 set (done in emu-load.ts).

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;
const CF = 0x001;

/** Read a 32-bit linear address from a DDS (DMA Descriptor Structure).
 *  DDS layout:
 *    +0  DWORD region size
 *    +4  DWORD linear offset
 *    +8  WORD  segment/selector
 *    +A  WORD  buffer ID
 *    +C  DWORD physical address (output) */
function ddsLinear(cpu: CPU, ddsAddr: number): number {
  const off = cpu.mem.readU32(ddsAddr + 4) >>> 0;
  const sel = cpu.mem.readU16(ddsAddr + 8);
  // In real/V86 mode the "segment/selector" field is a real-mode segment;
  // linear = seg*16 + offset. In PM this is a selector (base from GDT).
  const base = cpu.realMode ? (sel * 16) : cpu.segBase(sel);
  return (base + off) >>> 0;
}

export function handleInt4B(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.reg[EAX] & 0xFFFF;
  const ah = (ax >>> 8) & 0xFF;
  const al = ax & 0xFF;

  if (ah !== 0x81) return false; // not VDS — let default INT 4Bh dispatch

  // ES:DI points to DDS for most services
  const esBase = cpu.realMode ? (cpu.es * 16) : cpu.segBase(cpu.es);
  const di = cpu.reg[EDI] & 0xFFFF;
  const ddsAddr = (esBase + di) >>> 0;

  switch (al) {
    case 0x02: { // Get Version
      // AH=0 success; AL=2; BX=2.0 (BCD major.minor); CX=max_dma_buffer_size;
      // DX=flags (bit 0: PC/XT 0/1; we say AT-class).
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0200;  // AH=02, AL=00 (success)
      cpu.setReg16(EBX, 0x0200);    // v2.0 BCD
      cpu.setReg16(ECX, 0xFFFF);    // max buffer size — we can do any size
      cpu.setReg16(EDX, 0x0000);    // AT-class, no translations needed
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x03: { // Lock DMA Region
      // Fill DDS.PhysicalAddress with linear (since we have no paging).
      const phys = ddsLinear(cpu, ddsAddr);
      cpu.mem.writeU32(ddsAddr + 0x0C, phys >>> 0);
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;  // AH=0, AL=0 success
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x04: { // Unlock DMA Region
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x05: { // Scatter/Gather Lock Region — same as 0x03 for flat mem
      const phys = ddsLinear(cpu, ddsAddr);
      cpu.mem.writeU32(ddsAddr + 0x0C, phys >>> 0);
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x06: { // Scatter/Gather Unlock Region
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x07: { // Request DMA Buffer
      // Simple policy: the DDS already carries a client-provided buffer
      // (region_size, linear_offset, segment/selector). Confirm it by
      // reporting physical = linear. Real DMA controllers need buffer in
      // low (<16 MB) memory; our emulator has flat low memory so this is
      // always fine for typical DOS buffer sizes.
      const phys = ddsLinear(cpu, ddsAddr);
      cpu.mem.writeU32(ddsAddr + 0x0C, phys >>> 0);
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x08: { // Release DMA Buffer
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x09: { // Copy Into DMA Buffer (no-op: buffer IS client memory)
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x0A: { // Copy Out of DMA Buffer
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x0B: // Disable DMA Translation
    case 0x0C: { // Enable DMA Translation
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    default:
      // Unknown VDS function — return failure with CF=1
      console.warn(`[VDS] Unknown INT 4Bh AX=81${al.toString(16).padStart(2,'0')}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0F00; // AL=0F (function not supported)
      cpu.setFlag(CF, true);
      return true;
  }
}
