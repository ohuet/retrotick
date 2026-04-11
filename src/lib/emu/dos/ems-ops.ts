// EMS sub-function handlers (AH=4E, 50, 53, 57) — split from ems.ts for size

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { EMS_PAGE_FRAME_SEG, EMS_PAGE_SIZE, EAX, EBX, ECX, EDX, saveBack, mapPage, unmapPage } from './ems';

/** AH=4E: Get/Set Page Map */
export function handleGetSetPageMap(cpu: CPU, emu: Emulator): void {
  const al = cpu.reg[EAX] & 0xFF;
  // Page map save area: 4 × 4 bytes (logicalAddr per physical page)
  const PAGE_MAP_SIZE = 16;

  if (al === 0 || al === 2) { // Get (or Get & Set: first get)
    const esBase = cpu.segBase(cpu.es);
    const di = cpu.getReg16(7);
    for (let p = 0; p < 4; p++) {
      // Save current frame data back before capturing state
      saveBack(cpu, emu, p);
    }
    for (let p = 0; p < 4; p++) {
      const addr = emu._emsMapping![p];
      cpu.mem.writeU32(esBase + di + p * 4, addr);
    }
  }

  if (al === 1 || al === 2) { // Set (or Get & Set: then set)
    const dsBase = cpu.segBase(cpu.ds);
    const si = cpu.getReg16(6);
    // Save current pages back
    for (let p = 0; p < 4; p++) saveBack(cpu, emu, p);
    // Restore from provided map
    for (let p = 0; p < 4; p++) {
      const addr = cpu.mem.readI32(dsBase + si + p * 4);
      if (addr >= 0) {
        const frameAddr = EMS_PAGE_FRAME_SEG * 16 + p * EMS_PAGE_SIZE;
        cpu.mem.copyBlock(frameAddr, addr, EMS_PAGE_SIZE);
      }
      emu._emsMapping![p] = addr;
    }
  }

  if (al === 3) { // Get size of page map save array
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFFFF00) | PAGE_MAP_SIZE;
    return;
  }

  cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
}

/** AH=50: Map/Unmap Multiple Pages */
export function handleMapMultiple(cpu: CPU, emu: Emulator): void {
  const al = cpu.reg[EAX] & 0xFF;
  const count = cpu.reg[ECX] & 0xFFFF;
  const handle = cpu.reg[EDX] & 0xFFFF;
  const dsBase = cpu.segBase(cpu.ds);
  const si = cpu.getReg16(6); // ESI
  const emb = emu._emsHandles!.get(handle);

  if (!emb) {
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300; // invalid handle
    return;
  }

  for (let i = 0; i < count; i++) {
    const logPage = cpu.mem.readU16(dsBase + si + i * 4);
    let physPage: number;
    if (al === 0) {
      physPage = cpu.mem.readU16(dsBase + si + i * 4 + 2);
    } else {
      const seg = cpu.mem.readU16(dsBase + si + i * 4 + 2);
      physPage = Math.floor((seg - EMS_PAGE_FRAME_SEG) * 16 / EMS_PAGE_SIZE);
    }

    if (physPage < 0 || physPage > 3) continue;

    if (logPage === 0xFFFF) {
      unmapPage(cpu, emu, physPage);
    } else {
      mapPage(cpu, emu, physPage, logPage, emb);
    }
  }
  cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
}

/** AH=53: Get/Set Handle Name */
export function handleHandleName(cpu: CPU, emu: Emulator): void {
  const al = cpu.reg[EAX] & 0xFF;
  const handle = cpu.reg[EDX] & 0xFFFF;

  if (!emu._emsHandles!.has(handle)) {
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
    return;
  }

  if (al === 0) { // Get name → ES:DI (8 bytes)
    const esBase = cpu.segBase(cpu.es);
    const di = cpu.getReg16(7);
    const name = emu._emsHandleNames?.get(handle) ?? '';
    for (let i = 0; i < 8; i++) {
      cpu.mem.writeU8(esBase + di + i, i < name.length ? name.charCodeAt(i) : 0);
    }
  } else { // al===1: Set name from DS:SI (8 bytes)
    const dsBase = cpu.segBase(cpu.ds);
    const si = cpu.getReg16(6);
    let name = '';
    for (let i = 0; i < 8; i++) {
      const c = cpu.mem.readU8(dsBase + si + i);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    emu._emsHandleNames!.set(handle, name);
  }
  cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
}

/** AH=57: Move/Exchange Memory Region */
export function handleMoveExchange(cpu: CPU, emu: Emulator): void {
  const al = cpu.reg[EAX] & 0xFF; // 0=move, 1=exchange
  const dsBase = cpu.segBase(cpu.ds);
  const si = cpu.getReg16(6);

  // Move/exchange structure at DS:SI:
  //   +0: DWORD region_length
  //   +4: BYTE  source_memory_type (0=conventional, 1=expanded)
  //   +5: WORD  source_handle
  //   +7: WORD  source_offset
  //   +9: WORD  source_seg_or_page
  //  +11: BYTE  dest_memory_type (0=conventional, 1=expanded)
  //  +12: WORD  dest_handle
  //  +14: WORD  dest_offset
  //  +16: WORD  dest_seg_or_page
  const length = cpu.mem.readU32(dsBase + si) >>> 0;
  const srcType = cpu.mem.readU8(dsBase + si + 4);
  const srcHandle = cpu.mem.readU16(dsBase + si + 5);
  const srcOffset = cpu.mem.readU16(dsBase + si + 7);
  const srcSegOrPage = cpu.mem.readU16(dsBase + si + 9);
  const dstType = cpu.mem.readU8(dsBase + si + 11);
  const dstHandle = cpu.mem.readU16(dsBase + si + 12);
  const dstOffset = cpu.mem.readU16(dsBase + si + 14);
  const dstSegOrPage = cpu.mem.readU16(dsBase + si + 16);

  // Flush page frame → backing store so the backing store has latest data
  // (the program may have written to the page frame directly)
  for (let p = 0; p < 4; p++) saveBack(cpu, emu, p);

  const srcAddr = resolveEmsAddr(emu, srcType, srcHandle, srcOffset, srcSegOrPage);
  const dstAddr = resolveEmsAddr(emu, dstType, dstHandle, dstOffset, dstSegOrPage);

  if (srcAddr < 0 || dstAddr < 0) {
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300; // invalid handle
    return;
  }

  if (al === 0) {
    cpu.mem.copyBlock(dstAddr, srcAddr, length);
  } else {
    // Exchange: swap byte by byte (safe for overlapping)
    for (let i = 0; i < length; i++) {
      const a = cpu.mem.readU8(srcAddr + i);
      const b = cpu.mem.readU8(dstAddr + i);
      cpu.mem.writeU8(srcAddr + i, b);
      cpu.mem.writeU8(dstAddr + i, a);
    }
  }

  // Sync page frame ↔ backing store after the move/exchange.
  // The move may have written to the page frame (conventional dest in D000 range)
  // AND/OR to the backing store (EMS dest). We must:
  //  1) saveBack pages whose FRAME was written (so backing gets the new data)
  //  2) reload pages whose BACKING was written (so frame gets the new data)
  // Doing saveBack first for frame-modified pages, then reload all, is safe:
  // saveBack persists frame changes to backing, then reload round-trips them back.
  const FRAME_START = EMS_PAGE_FRAME_SEG * 16;
  const FRAME_END = FRAME_START + 4 * EMS_PAGE_SIZE;

  // Ranges that were written to (dest for move, both for exchange)
  const writeRanges: [number, number][] = [[dstAddr, dstAddr + length]];
  if (al === 1) writeRanges.push([srcAddr, srcAddr + length]);

  for (let p = 0; p < 4; p++) {
    const fStart = FRAME_START + p * EMS_PAGE_SIZE;
    const fEnd = fStart + EMS_PAGE_SIZE;
    for (const [wStart, wEnd] of writeRanges) {
      if (wStart < fEnd && wEnd > fStart) {
        saveBack(cpu, emu, p);
        break;
      }
    }
  }

  // Reload all mapped pages from backing → frame
  for (let p = 0; p < 4; p++) {
    const mapped = emu._emsMapping![p];
    if (mapped >= 0) {
      const frameAddr = FRAME_START + p * EMS_PAGE_SIZE;
      cpu.mem.copyBlock(frameAddr, mapped, EMS_PAGE_SIZE);
    }
  }

  cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
}

/** Resolve an EMS address from type/handle/offset/segment-or-page to linear address. */
function resolveEmsAddr(
  emu: Emulator, memType: number, handle: number, offset: number, segOrPage: number
): number {
  if (memType === 0) {
    // Conventional memory: seg:off
    return segOrPage * 16 + offset;
  }
  // Expanded memory: handle + logical page + offset within page
  const emb = emu._emsHandles!.get(handle);
  if (!emb) return -1;
  return emb.baseAddr + segOrPage * EMS_PAGE_SIZE + offset;
}
