// EMS (Expanded Memory Specification) — INT 67h handler
// Provides LIM EMS 4.0 compatible expanded memory using linear memory above 1MB

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// INT number for VCPI PM service trap (called from PM via stub at VCPI entry point)
export const VCPI_PM_INT = 0xFA;

// EMS page frame at segment D000 (linear D0000-DFFFF = 64KB = 4 pages)
const EMS_PAGE_FRAME_SEG = 0xD000;
const EMS_PAGE_SIZE = 16384; // 16KB per page
const EMS_TOTAL_PAGES = 256; // 4MB of EMS
const EMS_MAX_HANDLES = 128;

interface EmsHandle {
  pages: number;        // number of 16KB pages allocated
  baseAddr: number;     // linear address in our memory where pages are stored
}

export function handleInt67(cpu: CPU, emu: Emulator): boolean {
  if (!emu.dosEnableEms) {
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400; // AH=84 function not supported
    return true;
  }

  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;

  // Initialize EMS state on first call
  if (!emu._emsHandles) {
    emu._emsHandles = new Map<number, EmsHandle>();
    emu._emsNextHandle = 1;
    emu._emsNextAddr = 0x200000; // Start EMS storage at 2MB linear
    emu._emsMapping = [-1, -1, -1, -1]; // 4 physical pages, each maps to a logical page addr
  }

  switch (ah) {
    case 0x40: // Get status
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0 (success)
      break;

    case 0x41: // Get page frame segment
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | EMS_PAGE_FRAME_SEG;
      break;

    case 0x42: { // Get page count
      // Count used pages
      let usedPages = 0;
      if (emu._emsHandles) {
        for (const h of emu._emsHandles.values()) usedPages += h.pages;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (EMS_TOTAL_PAGES - usedPages); // unallocated pages
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | EMS_TOTAL_PAGES; // total pages
      break;
    }

    case 0x43: { // Allocate pages (BX=count) → DX=handle
      const count = cpu.reg[EBX] & 0xFFFF;
      const handle = emu._emsNextHandle++;
      const baseAddr = emu._emsNextAddr;
      emu._emsNextAddr += count * EMS_PAGE_SIZE;
      emu._emsHandles.set(handle, { pages: count, baseAddr });
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | handle;
      break;
    }

    case 0x44: { // Map/unmap page (AL=physical page 0-3, BX=logical page, DX=handle)
      const physPage = cpu.reg[EAX] & 0xFF;
      const logPage = cpu.reg[EBX] & 0xFFFF;
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (physPage > 3) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8A00; // AH=8A invalid physical page
        break;
      }

      if (logPage === 0xFFFF) {
        // Unmap
        emu._emsMapping[physPage] = -1;
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
        break;
      }

      const emb = emu._emsHandles.get(handle);
      if (!emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300; // AH=83 invalid handle
        break;
      }

      // Map: copy logical page data to page frame
      const srcAddr = emb.baseAddr + logPage * EMS_PAGE_SIZE;
      const dstAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;

      // If there was a previously mapped page, save it back first
      const prevAddr = emu._emsMapping[physPage];
      if (prevAddr >= 0) {
        cpu.mem.copyBlock(prevAddr, dstAddr, EMS_PAGE_SIZE);
      }

      // Load new page into frame
      cpu.mem.copyBlock(dstAddr, srcAddr, EMS_PAGE_SIZE);
      emu._emsMapping[physPage] = srcAddr;

      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      break;
    }

    case 0x45: { // Deallocate pages (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      emu._emsHandles.delete(handle);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      break;
    }

    case 0x47: { // Save Page Map (DX=handle) — saves current mapping state
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (!emu._emsSavedMaps) emu._emsSavedMaps = new Map<number, number[]>();
      // Save both the mapping array AND the page frame contents for each mapped page
      const saved = [...emu._emsMapping];
      emu._emsSavedMaps.set(handle, saved);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0x48: { // Restore Page Map (DX=handle) — restores saved mapping state
      const handle = cpu.reg[EDX] & 0xFFFF;
      const saved = emu._emsSavedMaps?.get(handle);
      if (!saved) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300; // invalid handle
        break;
      }
      // Save back currently mapped pages, then restore saved mapping
      for (let p = 0; p < 4; p++) {
        const dstAddr = EMS_PAGE_FRAME_SEG * 16 + p * EMS_PAGE_SIZE;
        const curAddr = emu._emsMapping[p];
        if (curAddr >= 0) {
          cpu.mem.copyBlock(curAddr, dstAddr, EMS_PAGE_SIZE);
        }
        const savedAddr = saved[p];
        if (savedAddr >= 0) {
          cpu.mem.copyBlock(dstAddr, savedAddr, EMS_PAGE_SIZE);
        }
        emu._emsMapping[p] = savedAddr;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0x46: // Get version
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFFFF00) | 0x40; // AL=4.0
      break;

    case 0x4B: // Get handle count → BX
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (emu._emsHandles?.size ?? 0);
      break;

    case 0x4C: { // Get handle pages (DX=handle) → BX=pages
      const handle = cpu.reg[EDX] & 0xFFFF;
      const emb = emu._emsHandles?.get(handle);
      if (emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | emb.pages;
      } else {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
      }
      break;
    }

    case 0x4D: { // Get all handle pages → ES:DI filled, BX=count
      const esBase = cpu.segBase(cpu.es);
      const di = cpu.getReg16(7); // EDI
      let addr = esBase + di;
      let count = 0;
      if (emu._emsHandles) {
        for (const [h, info] of emu._emsHandles) {
          cpu.mem.writeU16(addr, h);
          cpu.mem.writeU16(addr + 2, info.pages);
          addr += 4;
          count++;
        }
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | count;
      break;
    }

    case 0x50: { // Map/unmap multiple pages
      const al = cpu.reg[EAX] & 0xFF;
      // AL=0: physical page + logical page pairs, AL=1: segment + logical page pairs
      // For simplicity, handle like AH=44 but multiple pages
      const count = cpu.reg[ECX] & 0xFFFF;
      const handle = cpu.reg[EDX] & 0xFFFF;
      const dsBase = cpu.segBase(cpu.ds);
      const si = cpu.getReg16(6); // ESI
      const emb = emu._emsHandles?.get(handle);

      for (let i = 0; i < count; i++) {
        const logPage = cpu.mem.readU16(dsBase + si + i * 4);
        let physPage: number;
        if (al === 0) {
          physPage = cpu.mem.readU16(dsBase + si + i * 4 + 2);
        } else {
          const seg = cpu.mem.readU16(dsBase + si + i * 4 + 2);
          physPage = Math.floor((seg - EMS_PAGE_FRAME_SEG) * 16 / EMS_PAGE_SIZE);
        }

        if (physPage >= 0 && physPage < 4 && emb) {
          const srcAddr = emb.baseAddr + logPage * EMS_PAGE_SIZE;
          const dstAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;
          const prevAddr = emu._emsMapping[physPage];
          if (prevAddr >= 0) {
            cpu.mem.copyBlock(prevAddr, dstAddr, EMS_PAGE_SIZE);
          }
          cpu.mem.copyBlock(dstAddr, srcAddr, EMS_PAGE_SIZE);
          emu._emsMapping[physPage] = srcAddr;
        }
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0x51: { // Reallocate pages (DX=handle, BX=new count)
      const handle = cpu.reg[EDX] & 0xFFFF;
      const newCount = cpu.reg[EBX] & 0xFFFF;
      const emb = emu._emsHandles?.get(handle);
      if (emb) {
        emb.pages = newCount;
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      } else {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
      }
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | newCount;
      break;
    }

    case 0x58: { // Get mappable physical address array
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) {
        // Return array at ES:DI
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        for (let i = 0; i < 4; i++) {
          cpu.mem.writeU16(esBase + di + i * 4, EMS_PAGE_FRAME_SEG + i * (EMS_PAGE_SIZE / 16));
          cpu.mem.writeU16(esBase + di + i * 4 + 2, i);
        }
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      } else {
        // Return count only
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0xDE: { // VCPI functions
      const al = cpu.reg[EAX] & 0xFF;
      switch (al) {
        case 0x00: // VCPI Installation Check
          // Return success — we support the VCPI interface
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0 success
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0100; // BX=version 1.0
          break;
        case 0x01: { // VCPI Get Protected Mode Interface
          // ES:DI → page table buffer (256 entries × 4 bytes = 1024 bytes)
          const esBase = cpu.segBase(cpu.es);
          const di = cpu.getReg16(7);
          // Fill page table: identity map first 1MB (256 × 4KB pages)
          for (let pg = 0; pg < 256; pg++) {
            // Each entry: 20-bit page frame + flags (present, writable, user)
            cpu.mem.writeU32(esBase + di + pg * 4, (pg * 0x1000) | 0x67);
          }
          // DS:SI → 3 GDT descriptors (8 bytes each = 24 bytes)
          const dsBase = cpu.segBase(cpu.ds);
          const si = cpu.getReg16(6);
          // Descriptor 1: code segment (base=0, limit=FFFFF, 32-bit, execute/read)
          cpu.mem.writeU32(dsBase + si + 0, 0x0000FFFF);
          cpu.mem.writeU32(dsBase + si + 4, 0x00CF9A00);
          // Descriptor 2: data segment (base=0, limit=FFFFF, 32-bit, read/write)
          cpu.mem.writeU32(dsBase + si + 8, 0x0000FFFF);
          cpu.mem.writeU32(dsBase + si + 12, 0x00CF9200);
          // Descriptor 3: data segment (same)
          cpu.mem.writeU32(dsBase + si + 16, 0x0000FFFF);
          cpu.mem.writeU32(dsBase + si + 20, 0x00CF9200);
          // EBX = offset of PM entry point in VCPI code segment
          // PM entry stub at F000:0B00 — traps into our VCPI PM service handler
          const VCPI_PM_OFF = 0x0B00;
          const vcpiPmLinear = 0xF0000 + VCPI_PM_OFF;
          // Write stub: INT FAh; RETF (FAR CALL convention, not IRET)
          cpu.mem.writeU8(vcpiPmLinear, 0xCD);
          cpu.mem.writeU8(vcpiPmLinear + 1, VCPI_PM_INT);
          cpu.mem.writeU8(vcpiPmLinear + 2, 0xCB); // RETF (32-bit far return)
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | vcpiPmLinear;
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x02: // VCPI Maximum Physical Address
          cpu.reg[EDX] = 0x00FFFFFF; // 16MB
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x03: // VCPI Get Number of Free Pages
          cpu.reg[EDX] = 4096; // 16MB of free pages
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x04: { // VCPI Allocate one Page
          if (!emu._vcpiNextPage) emu._vcpiNextPage = 0x110; // start at 1.1MB
          const page = emu._vcpiNextPage++;
          cpu.reg[EDX] = page << 12; // physical address
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x05: // VCPI Free Page
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x06: // VCPI Get Physical Address of Page in 1st MB
          // Identity map: physical = linear for first 1MB
          cpu.reg[EDX] = (cpu.getReg16(ECX) << 12) >>> 0;
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x0A: // VCPI Get PIC Vector Mappings
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x08; // primary PIC base
          cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 0x70; // secondary PIC base
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x0B: // VCPI Set PIC Vector Mappings
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x0C: { // VCPI Switch from V86/RM to Protected Mode
          // Enable A20 first — PM needs full address space for GDT/IDT/LDT
          emu.memory.a20Mask = 0xFFFFFFFF;
          // Save original V86 IVT on first switch (only the segment values, not offsets).
          // PM code modifies IVT entries with PM selectors; we need to detect these
          // to prevent IVT chaining to invalid RM addresses.
          if (!emu._vcpiSavedIVT) {
            emu._vcpiSavedIVT = new Uint16Array(256);
            for (let i = 0; i < 256; i++) emu._vcpiSavedIVT[i] = cpu.mem.readU16(i * 4 + 2);
          }
          // ESI = linear address of data structure
          const esi = cpu.reg[ESI] >>> 0;
          const newCR3 = cpu.mem.readU32(esi);
          const newLDTR = cpu.mem.readU16(esi + 0x0C);
          const newTR = cpu.mem.readU16(esi + 0x0E);
          const newEIP = cpu.mem.readU32(esi + 0x10);
          const newCS = cpu.mem.readU16(esi + 0x14);
          // Load GDT/IDT: On the first switch, read from the client's GDTR/IDTR.
          // On subsequent switches, reuse the emulator's current GDT/IDT — the PM
          // code may have modified them (via LGDT/LIDT or direct writes), and the
          // client's V86 save code may have overwritten the GDTR pseudo-descriptor
          // in the data structure with unrelated PM state data.
          if (!emu._vcpiPmGdtBase) {
            // First switch — read from structure
            const gdtrAddr = cpu.mem.readU32(esi + 4);
            const idtrAddr = cpu.mem.readU32(esi + 8);
            emu._gdtBase = cpu.mem.readU32(gdtrAddr + 2);
            emu._gdtLimit = cpu.mem.readU16(gdtrAddr);
            emu._idtBase = cpu.mem.readU32(idtrAddr + 2);
            emu._idtLimit = cpu.mem.readU16(idtrAddr);
            emu._vcpiPmGdtBase = emu._gdtBase;
            emu._vcpiPmGdtLimit = emu._gdtLimit;
            emu._vcpiPmIdtBase = emu._idtBase;
            emu._vcpiPmIdtLimit = emu._idtLimit;
          } else {
            // Subsequent switches — restore saved PM state
            emu._gdtBase = emu._vcpiPmGdtBase;
            emu._gdtLimit = emu._vcpiPmGdtLimit!;
            emu._idtBase = emu._vcpiPmIdtBase!;
            emu._idtLimit = emu._vcpiPmIdtLimit!;
          }
          // Store LDTR/TR
          emu._ldtr = newLDTR;
          emu._tr = newTR;
          // Set CR0 PE bit
          emu._cr0 = (emu._cr0 | 1) >>> 0;
          // Switch to protected mode
          // VCPI spec: only CS, EIP, SS:ESP are set (ESP from current value).
          // Other segment regs (DS, ES, FS, GS) are NOT loaded by the host.
          // SS must be a valid PM selector — use null (base=0) which the PM entry
          // code will immediately replace with a proper selector.
          cpu.realMode = false;
          cpu.loadCS(newCS);
          cpu.ss = 0;
          cpu.eip = (cpu.segBase(newCS) + newEIP) >>> 0;
          break;
        }
        default:
          console.warn(`[EMS] VCPI function 0xDE${al.toString(16).padStart(2, '0')} not supported`);
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400;
          break;
      }
      break;
    }

    default:
      console.warn(`[EMS] Unhandled INT 67h AH=0x${ah.toString(16).padStart(2, '0')}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400; // AH=84 function not supported
      break;
  }

  return true;
}

/**
 * Handle VCPI services called from Protected Mode (via INT FAh trap).
 * DOS4GW calls the VCPI PM entry point (CALL FAR vcpiCS:offset) with AX=function.
 * The stub does INT FAh which traps here. After handling, the stub does RETF
 * back to the caller.
 */
export function handleVcpiPM(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  const fn = ax & 0xFF;

  // For non-switch functions (0x04, 0x05), we need to return to the CALL FAR caller.
  // The CALL FAR pushed CS:EIP onto the stack. The caller may use 16-bit or 32-bit
  // operand size (with 66 prefix), creating a 4-byte or 8-byte frame. The stub's
  // RETF might not match. Instead, pop the return address ourselves and set EIP.
  // We detect the frame size by checking if the value at ESP+4 looks like a valid
  // PM selector (< 0x100 with valid GDT/LDT entry) → 32-bit, otherwise → 16-bit.
  const returnToCaller = () => {
    const ssBase = cpu.segBase(cpu.ss);
    const esp = cpu.reg[ESP] >>> 0;
    // Try 16-bit frame first (4 bytes: WORD IP + WORD CS)
    const ret16IP = cpu.mem.readU16(ssBase + esp);
    const ret16CS = cpu.mem.readU16(ssBase + esp + 2);
    // Try 32-bit frame (8 bytes: DWORD EIP + DWORD CS)
    const ret32EIP = cpu.mem.readU32(ssBase + esp);
    const ret32CS = cpu.mem.readU32(ssBase + esp + 4) & 0xFFFF;
    // Heuristic: if 32-bit CS is a small valid selector (< 0x100), use 32-bit
    if (ret32CS > 0 && ret32CS < 0x100 && (ret32CS & 0x3) === 0) {
      cpu.reg[ESP] = (esp + 8) | 0;
      cpu.loadCS(ret32CS);
      cpu.eip = (cpu.segBase(ret32CS) + ret32EIP) >>> 0;
    } else {
      cpu.reg[ESP] = (esp + 4) | 0;
      cpu.loadCS(ret16CS);
      cpu.eip = (cpu.segBase(ret16CS) + ret16IP) >>> 0;
    }
  };

  switch (fn) {
    case 0x04: { // Allocate 4KB Page
      if (!emu._vcpiNextPage) emu._vcpiNextPage = 0x110;
      const page = emu._vcpiNextPage++;
      cpu.reg[EDX] = page << 12;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      returnToCaller();
      return true;
    }
    case 0x05: // Free 4KB Page
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      returnToCaller();
      return true;

    case 0x0C: { // Switch from PM to V86 mode
      // The client pushes a return frame on the stack before CALL FAR to the entry point:
      //   PUSH GS, PUSH FS, PUSH DS, PUSH ES, PUSH SS
      //   PUSH ESP, PUSH EFLAGS, PUSH CS, PUSH EIP
      // Then CALL FAR pushes return CS:EIP (8 bytes for 32-bit).
      // Then the INT FAh in the stub pushes FLAGS+CS+EIP (varies by D bit).
      //
      // We need to skip the INT frame + CALL FAR frame to reach the V86 frame.
      // The stub is in a 16-bit segment (CS from DE01 descriptor 1 has D=0?
      // Actually DE01 sets it as 32-bit: 0x00CF9A00). Let's check opSize.
      // With 32-bit CS: INT pushes 12 bytes (EFLAGS+CS+EIP), CALL FAR pushed 8.
      // Total to skip: 20 bytes.
      const ssBase = cpu.segBase(cpu.ss);
      const esp = cpu.reg[ESP] >>> 0;
      // dispatchException doesn't push a frame for JS handlers, and INT CD FA
      // only called dispatchException which fell through to handleDosInt.
      // Only the CALL FAR frame (8 bytes: 32-bit CS + EIP) needs to be skipped.
      const frameBase = ssBase + esp + 8;
      const newEIP = cpu.mem.readU32(frameBase + 0);
      const newCS = cpu.mem.readU32(frameBase + 4) & 0xFFFF;
      const newEFLAGS = cpu.mem.readU32(frameBase + 8);
      const newESP = cpu.mem.readU32(frameBase + 12);
      const newSS = cpu.mem.readU32(frameBase + 16) & 0xFFFF;
      const newES = cpu.mem.readU32(frameBase + 20) & 0xFFFF;
      const newDS = cpu.mem.readU32(frameBase + 24) & 0xFFFF;
      const newFS = cpu.mem.readU32(frameBase + 28) & 0xFFFF;
      const newGS = cpu.mem.readU32(frameBase + 32) & 0xFFFF;

      // Switch to V86/real mode
      cpu.realMode = true;
      cpu.use32 = false;
      cpu._addrSize16 = true;
      cpu.cs = newCS;
      cpu.ds = newDS;
      cpu.es = newES;
      cpu.ss = newSS;
      cpu.fs = newFS;
      cpu.gs = newGS;
      cpu.reg[ESP] = newESP;
      cpu.eip = (newCS * 16 + newEIP) >>> 0;
      cpu.setFlags(newEFLAGS);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;
    }

    default:
      console.warn(`[VCPI-PM] Unhandled function AX=0x${ax.toString(16)}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8F00;
      return true;
  }
}
