// EMS (Expanded Memory Specification) — INT 67h handler
// Provides LIM EMS 4.0 compatible expanded memory using linear memory above XMS

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleGetSetPageMap, handleMapMultiple, handleHandleName, handleMoveExchange } from './ems-ops';

// Register indices — exported for ems-ops.ts
export const EAX = 0, EBX = 3, ECX = 1, EDX = 2;

// EMS page frame at segment D000 (linear D0000-DFFFF = 64KB = 4 pages)
export const EMS_PAGE_FRAME_SEG = 0xD000;
export const EMS_PAGE_SIZE = 16384; // 16KB per page
const EMS_TOTAL_PAGES = 256; // 4MB of EMS

// Device driver header segment — programs detect EMS by checking "EMMXXXX0" at seg:000Ah
export const EMS_DEVICE_SEG = 0xE000;

interface EmsHandle {
  pages: number;        // number of 16KB pages allocated
  baseAddr: number;     // linear address in our memory where pages are stored
}

/** Write the EMS device driver header at E000:0000 for detection by programs. */
export function setupEmsDeviceHeader(mem: { writeU8(addr: number, val: number): void }): void {
  const base = EMS_DEVICE_SEG * 16;
  // Device driver header: link (FFFF:FFFF), attributes, strategy/interrupt offsets
  mem.writeU8(base + 0, 0xFF); mem.writeU8(base + 1, 0xFF);
  mem.writeU8(base + 2, 0xFF); mem.writeU8(base + 3, 0xFF); // next device: FFFF:FFFF
  mem.writeU8(base + 4, 0x00); mem.writeU8(base + 5, 0x80); // attributes: 0x8000 (char device)
  mem.writeU8(base + 6, 0x00); mem.writeU8(base + 7, 0x00); // strategy offset
  mem.writeU8(base + 8, 0x00); mem.writeU8(base + 9, 0x00); // interrupt offset
  // Device name at offset 0x0A: "EMMXXXX0"
  const name = 'EMMXXXX0';
  for (let i = 0; i < 8; i++) mem.writeU8(base + 0x0A + i, name.charCodeAt(i));
  // Stub code at E000:0012 (after the 18-byte header): just IRET
  mem.writeU8(base + 0x12, 0xCF); // IRET
}

function initEms(emu: Emulator): void {
  if (!emu._emsHandles) {
    emu._emsHandles = new Map<number, EmsHandle>();
    emu._emsNextHandle = 1;
    emu._emsMapping = [-1, -1, -1, -1]; // 4 physical pages, each maps to a logical page addr
    emu._emsHandleNames = new Map<number, string>();
  }
}

/** Save page frame data back to backing store for a physical page. */
export function saveBack(cpu: CPU, emu: Emulator, physPage: number): void {
  const prevAddr = emu._emsMapping![physPage];
  if (prevAddr >= 0) {
    const frameAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;
    cpu.mem.copyBlock(prevAddr, frameAddr, EMS_PAGE_SIZE);
  }
}

/** Map a logical page into a physical page slot. */
export function mapPage(cpu: CPU, emu: Emulator, physPage: number, logPage: number, emb: { baseAddr: number }): void {
  saveBack(cpu, emu, physPage);
  const srcAddr = emb.baseAddr + logPage * EMS_PAGE_SIZE;
  const frameAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;
  cpu.mem.copyBlock(frameAddr, srcAddr, EMS_PAGE_SIZE);
  emu._emsMapping![physPage] = srcAddr;
}

/** Unmap a physical page (save data back, mark unmapped). */
export function unmapPage(cpu: CPU, emu: Emulator, physPage: number): void {
  saveBack(cpu, emu, physPage);
  emu._emsMapping![physPage] = -1;
}

/** Save the current mapping state (both mapping array and page frame contents). */
function savePageMap(cpu: CPU, emu: Emulator): number[] {
  const saved: number[] = [];
  for (let p = 0; p < 4; p++) {
    saved.push(emu._emsMapping![p]);
    saveBack(cpu, emu, p);
  }
  return saved;
}

/** Restore a saved mapping state. */
function restorePageMap(cpu: CPU, emu: Emulator, saved: number[]): void {
  for (let p = 0; p < 4; p++) saveBack(cpu, emu, p);
  for (let p = 0; p < 4; p++) {
    const addr = saved[p];
    if (addr >= 0) {
      const frameAddr = EMS_PAGE_FRAME_SEG * 16 + p * EMS_PAGE_SIZE;
      cpu.mem.copyBlock(frameAddr, addr, EMS_PAGE_SIZE);
    }
    emu._emsMapping![p] = addr;
  }
}

export function handleInt67(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;
  initEms(emu);

  switch (ah) {
    case 0x40: // Get status
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF); // AH=0 (success)
      break;

    case 0x41: // Get page frame segment
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | EMS_PAGE_FRAME_SEG;
      break;

    case 0x42: { // Get page count
      let usedPages = 0;
      for (const h of emu._emsHandles!.values()) usedPages += h.pages;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (EMS_TOTAL_PAGES - usedPages);
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | EMS_TOTAL_PAGES;
      break;
    }

    case 0x43: { // Allocate pages (BX=count) → DX=handle
      const count = cpu.reg[EBX] & 0xFFFF;
      let used43 = 0;
      for (const h of emu._emsHandles!.values()) used43 += h.pages;
      if (count > EMS_TOTAL_PAGES - used43) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8700; // not enough pages
        break;
      }
      const handle = emu._emsNextHandle++;
      const baseAddr = emu._emsNextAddr;
      emu._emsNextAddr += count * EMS_PAGE_SIZE;
      emu._emsHandles!.set(handle, { pages: count, baseAddr });
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | handle;
      break;
    }

    case 0x44: { // Map/unmap page (AL=physical page 0-3, BX=logical page, DX=handle)
      const physPage = cpu.reg[EAX] & 0xFF;
      const logPage = cpu.reg[EBX] & 0xFFFF;
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (physPage > 3) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8A00;
        break;
      }
      if (logPage === 0xFFFF) {
        unmapPage(cpu, emu, physPage);
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
        break;
      }
      const emb = emu._emsHandles!.get(handle);
      if (!emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      if (logPage >= emb.pages) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8A00;
        break;
      }
      mapPage(cpu, emu, physPage, logPage, emb);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x45: { // Deallocate pages (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (!emu._emsHandles!.has(handle)) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      emu._emsHandles!.delete(handle);
      emu._emsHandleNames?.delete(handle);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x46: // Get version
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0040; // AH=0, AL=0x40 (EMS 4.0)
      break;

    case 0x47: { // Save Page Map (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (!emu._emsSavedMaps) emu._emsSavedMaps = new Map<number, number[]>();
      emu._emsSavedMaps.set(handle, savePageMap(cpu, emu));
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x48: { // Restore Page Map (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      const saved = emu._emsSavedMaps?.get(handle);
      if (!saved) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      restorePageMap(cpu, emu, saved);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x4B: // Get handle count → BX
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (emu._emsHandles!.size);
      break;

    case 0x4C: { // Get handle pages (DX=handle) → BX=pages
      const handle = cpu.reg[EDX] & 0xFFFF;
      const emb = emu._emsHandles!.get(handle);
      if (emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | emb.pages;
      } else {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
      }
      break;
    }

    case 0x4D: { // Get all handle pages → ES:DI filled, BX=count
      const esBase = cpu.segBase(cpu.es);
      const di = cpu.getReg16(7);
      let addr = esBase + di;
      let count = 0;
      for (const [h, info] of emu._emsHandles!) {
        cpu.mem.writeU16(addr, h);
        cpu.mem.writeU16(addr + 2, info.pages);
        addr += 4;
        count++;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | count;
      break;
    }

    case 0x4E: handleGetSetPageMap(cpu, emu); break;
    case 0x50: handleMapMultiple(cpu, emu); break;

    case 0x51: { // Reallocate pages (DX=handle, BX=new count)
      const handle = cpu.reg[EDX] & 0xFFFF;
      const newCount = cpu.reg[EBX] & 0xFFFF;
      const emb = emu._emsHandles!.get(handle);
      if (!emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      if (newCount > emb.pages) {
        let used51 = 0;
        for (const h of emu._emsHandles!.values()) used51 += h.pages;
        if (newCount - emb.pages > EMS_TOTAL_PAGES - used51) {
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8700;
          break;
        }
        const oldBase = emb.baseAddr;
        const oldEnd = oldBase + emb.pages * EMS_PAGE_SIZE;
        // Flush any mapped pages back to old backing before copying
        for (let p = 0; p < 4; p++) {
          const m = emu._emsMapping![p];
          if (m >= oldBase && m < oldEnd) saveBack(cpu, emu, p);
        }
        const newBase = emu._emsNextAddr;
        emu._emsNextAddr += newCount * EMS_PAGE_SIZE;
        if (emb.pages > 0) cpu.mem.copyBlock(newBase, oldBase, emb.pages * EMS_PAGE_SIZE);
        emb.baseAddr = newBase;
        // Update any active mapping entries that pointed to old backing
        for (let p = 0; p < 4; p++) {
          const m = emu._emsMapping![p];
          if (m >= oldBase && m < oldEnd) {
            emu._emsMapping![p] = m - oldBase + newBase;
          }
        }
      }
      emb.pages = newCount;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | newCount;
      break;
    }

    case 0x52: { // Get/Set Handle Attribute
      const al = cpu.reg[EAX] & 0xFF;
      if (al <= 1 && !emu._emsHandles!.has(cpu.reg[EDX] & 0xFFFF)) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      if (al === 0) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0000; // AH=0, AL=0 (volatile)
      } else if (al === 1) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF); // succeed (ignore)
      } else { // al===2: Get capability
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0000; // volatile only
      }
      break;
    }

    case 0x53: handleHandleName(cpu, emu); break;

    case 0x54: { // Get Handle Directory
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) { // Get directory → ES:DI
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        let addr = esBase + di;
        let count = 0;
        for (const [h] of emu._emsHandles!) {
          cpu.mem.writeU16(addr, h);
          const hname = emu._emsHandleNames?.get(h) ?? '';
          for (let i = 0; i < 8; i++) {
            cpu.mem.writeU8(addr + 2 + i, i < hname.length ? hname.charCodeAt(i) : 0);
          }
          addr += 10;
          count++;
        }
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFFFF00) | (count & 0xFF);
      } else { // al===1: Search for named handle
        const dsBase = cpu.segBase(cpu.ds);
        const si = cpu.getReg16(6);
        let searchName = '';
        for (let i = 0; i < 8; i++) {
          const c = cpu.mem.readU8(dsBase + si + i);
          if (c === 0) break;
          searchName += String.fromCharCode(c);
        }
        let found = -1;
        for (const [h, n] of emu._emsHandleNames!) {
          if (n === searchName) { found = h; break; }
        }
        if (found >= 0) {
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
          cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | found;
        } else {
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0xA100;
        }
      }
      break;
    }

    case 0x57: handleMoveExchange(cpu, emu); break;

    case 0x58: { // Get mappable physical address array
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) {
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        for (let i = 0; i < 4; i++) {
          cpu.mem.writeU16(esBase + di + i * 4, EMS_PAGE_FRAME_SEG + i * (EMS_PAGE_SIZE / 16));
          cpu.mem.writeU16(esBase + di + i * 4 + 2, i);
        }
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      } else {
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x59: { // Get hardware info
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) {
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        cpu.mem.writeU16(esBase + di + 0, EMS_PAGE_SIZE / 16);
        cpu.mem.writeU16(esBase + di + 2, 0);
        cpu.mem.writeU16(esBase + di + 4, 16); // page map save area: 4 pages × 4 bytes
        cpu.mem.writeU16(esBase + di + 6, 0);
        cpu.mem.writeU16(esBase + di + 8, 0);
      } else if (al === 1) {
        let usedPages = 0;
        for (const h of emu._emsHandles!.values()) usedPages += h.pages;
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (EMS_TOTAL_PAGES - usedPages);
        cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | EMS_TOTAL_PAGES;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x5A: { // Allocate standard/raw pages (same as 0x43 for us)
      const count = cpu.reg[EBX] & 0xFFFF;
      let used5A = 0;
      for (const h of emu._emsHandles!.values()) used5A += h.pages;
      if (count > EMS_TOTAL_PAGES - used5A) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8700;
        break;
      }
      const handle = emu._emsNextHandle++;
      const baseAddr = emu._emsNextAddr;
      emu._emsNextAddr += count * EMS_PAGE_SIZE;
      emu._emsHandles!.set(handle, { pages: count, baseAddr });
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | handle;
      break;
    }

    case 0x5B: { // Alternate Map Register Set — stub
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000);
      break;
    }

    default:
      console.warn(`[EMS] Unhandled INT 67h AH=0x${ah.toString(16).padStart(2, '0')}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400; // function not supported
      break;
  }

  return true;
}
