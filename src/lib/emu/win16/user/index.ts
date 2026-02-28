import type { Emulator } from '../../emulator';
import type { MenuItem } from '../../../pe/types';
import { registerWin16UserWindow } from './window';
import { registerWin16UserMessage } from './message';
import { registerWin16UserPaint } from './paint';
import { registerWin16UserRect } from './rect';
import { registerWin16UserDialog } from './dialog';
import { registerWin16UserMenu } from './menu';
import { registerWin16UserResource } from './resource';
import { registerWin16UserMisc } from './misc';

export function findMenuItemById(items: MenuItem[], id: number): MenuItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findMenuItemById(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

export type ReadFarPtr = (byteOffset: number) => number;
export type ReadRect = (ptr: number) => { left: number; top: number; right: number; bottom: number };
export type WriteRect = (ptr: number, left: number, top: number, right: number, bottom: number) => void;

export type ResolveFarPtr = (raw: number) => number;

export interface Win16UserHelpers {
  readFarPtr: ReadFarPtr;
  resolveFarPtr: ResolveFarPtr;
  readRect: ReadRect;
  writeRect: WriteRect;
}

export function registerWin16User(emu: Emulator): void {
  const user = emu.registerModule16('USER');

  // Read a far pointer from the stack and convert segment:offset to linear address
  const readFarPtr: ReadFarPtr = (byteOffset: number) => {
    const raw = emu.readArg16DWord(byteOffset);
    const off = raw & 0xFFFF;
    const seg = (raw >>> 16) & 0xFFFF;
    if (!seg) return off; // NULL or near pointer
    return (emu.cpu.segBases.get(seg) ?? (seg * 16)) + off;
  };

  const readRect: ReadRect = (ptr: number) => ({
    left: emu.memory.readI16(ptr),
    top: emu.memory.readI16(ptr + 2),
    right: emu.memory.readI16(ptr + 4),
    bottom: emu.memory.readI16(ptr + 6),
  });

  const writeRect: WriteRect = (ptr: number, left: number, top: number, right: number, bottom: number) => {
    emu.memory.writeU16(ptr, left & 0xFFFF);
    emu.memory.writeU16(ptr + 2, top & 0xFFFF);
    emu.memory.writeU16(ptr + 4, right & 0xFFFF);
    emu.memory.writeU16(ptr + 6, bottom & 0xFFFF);
  };

  // Resolve a raw far pointer (offset:segment packed as U32) to a linear address
  const resolveFarPtr: ResolveFarPtr = (raw: number) => {
    const off = raw & 0xFFFF;
    const seg = (raw >>> 16) & 0xFFFF;
    if (!seg) return off;
    return (emu.cpu.segBases.get(seg) ?? (seg * 16)) + off;
  };

  const helpers: Win16UserHelpers = { readFarPtr, resolveFarPtr, readRect, writeRect };

  registerWin16UserWindow(emu, user, helpers);
  registerWin16UserMessage(emu, user, helpers);
  registerWin16UserPaint(emu, user, helpers);
  registerWin16UserRect(emu, user, helpers);
  registerWin16UserDialog(emu, user, helpers);
  registerWin16UserMenu(emu, user, helpers);
  registerWin16UserResource(emu, user, helpers);
  registerWin16UserMisc(emu, user, helpers);
}
