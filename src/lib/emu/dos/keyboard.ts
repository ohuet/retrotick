import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0;
const ZF = 0x040;

// --- INT 09h: Keyboard Hardware (BIOS default handler) ---
// Scancode-to-ASCII table for unshifted keys (index = scancode 0x00-0x3F)
const SCAN_TO_ASCII: (number | undefined)[] = [
  /*00*/ undefined, 0x1B, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36,  // ESC, 1-6
  /*08*/ 0x37, 0x38, 0x39, 0x30, 0x2D, 0x3D, 0x08, 0x09,       // 7-0, -, =, BS, TAB
  /*10*/ 0x71, 0x77, 0x65, 0x72, 0x74, 0x79, 0x75, 0x69,       // q w e r t y u i
  /*18*/ 0x6F, 0x70, 0x5B, 0x5D, 0x0D, undefined, 0x61, 0x73,  // o p [ ] Enter, Ctrl, a s
  /*20*/ 0x64, 0x66, 0x67, 0x68, 0x6A, 0x6B, 0x6C, 0x3B,       // d f g h j k l ;
  /*28*/ 0x27, 0x60, undefined, 0x5C, 0x7A, 0x78, 0x63, 0x76,  // ' `, LShift, \ z x c v
  /*30*/ 0x62, 0x6E, 0x6D, 0x2C, 0x2E, 0x2F, undefined, 0x2A,  // b n m , . /, RShift, *
  /*38*/ undefined, 0x20, undefined,                              // Alt, Space, CapsLock
  // F1-F10 (0x3B-0x44): extended keys, ascii=0
  undefined, undefined, undefined, undefined, undefined,
];

// Extended key scancodes (arrows, F-keys, Home, End, etc.) — always ascii=0
const EXTENDED_SCANCODES = new Set([
  0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, // F1-F10
  0x47, 0x48, 0x49, // Home, Up, PgUp
  0x4B, 0x4D,       // Left, Right
  0x4F, 0x50, 0x51, // End, Down, PgDn
  0x52, 0x53,       // Ins, Del
  0x57, 0x58,       // F11, F12
]);

export function handleInt09(cpu: CPU, emu: Emulator): boolean {
  const scancode = emu.portIn(0x60);
  const BDA = 0x400;
  const shiftFlags = emu.memory.readU8(BDA + 0x17);

  if (scancode & 0x80) {
    // Break code — update shift state for modifier releases
    const baseScan = scancode & 0x7F;
    if (baseScan === 0x2A || baseScan === 0x36) // LShift/RShift release
      emu.memory.writeU8(BDA + 0x17, shiftFlags & ~0x03);
    else if (baseScan === 0x1D) // Ctrl release
      emu.memory.writeU8(BDA + 0x17, shiftFlags & ~0x04);
    else if (baseScan === 0x38) // Alt release
      emu.memory.writeU8(BDA + 0x17, shiftFlags & ~0x08);
    return true;
  }

  // Make code — update shift state for modifier presses
  if (scancode === 0x2A || scancode === 0x36) { // LShift/RShift
    emu.memory.writeU8(BDA + 0x17, shiftFlags | (scancode === 0x2A ? 0x02 : 0x01));
    return true;
  }
  if (scancode === 0x1D) { // Ctrl
    emu.memory.writeU8(BDA + 0x17, shiftFlags | 0x04);
    return true;
  }
  if (scancode === 0x38) { // Alt
    emu.memory.writeU8(BDA + 0x17, shiftFlags | 0x08);
    return true;
  }

  // Determine ASCII based on scancode and modifiers
  let ascii: number;
  const isAlt = !!(shiftFlags & 0x08);
  const isCtrl = !!(shiftFlags & 0x04);

  if (isAlt || EXTENDED_SCANCODES.has(scancode)) {
    ascii = 0; // Extended key
  } else if (isCtrl && scancode >= 0x1E && scancode <= 0x32) {
    // Ctrl+letter: ASCII 1-26
    const ctrlBase = SCAN_TO_ASCII[scancode];
    ascii = ctrlBase ? (ctrlBase - 0x60) & 0x1F : 0;
  } else {
    ascii = (scancode < SCAN_TO_ASCII.length ? SCAN_TO_ASCII[scancode] : undefined) ?? 0;
  }

  // Push to dosKeyBuffer for BIOS INT 16h consumption.
  // This must happen HERE (after INT 09h handler set the "key available" signal)
  // rather than in ConsoleView (which would set data before signal).
  emu.dosKeyBuffer.push({ ascii, scan: scancode });
  emu.writeBdaKey(ascii, scancode);
  return true;
}

// --- INT 16h: Keyboard BIOS ---
export function handleInt16(cpu: CPU, emu: Emulator, fromBiosStub = false): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  switch (ah) {
    case 0x00: case 0x10: {
      // Read keystroke
      // In BIOS stub mode, limit to one key per tick so screen updates
      // between each key (prevents keys being processed all at once).
      if (emu.dosKeyBuffer.length > 0 && !(fromBiosStub && emu._dosKeyConsumedThisTick)) {
        const key = emu.dosKeyBuffer.shift()!;
        cpu.setReg16(EAX, (key.scan << 8) | key.ascii);
        if (fromBiosStub) emu._dosKeyConsumedThisTick = true;
      } else if (fromBiosStub) {
        // Buffer empty: return AX=0 so QBasic's handler sees "no key"
        // (QBasic checks OR AX,AX and loops if zero)
        cpu.setReg16(EAX, 0);
      } else {
        // Direct INT 16h from program — block until key available
        emu._dosWaitingForKey = 'read';
        emu.waitingForMessage = true;
      }
      break;
    }
    case 0x01: case 0x11: {
      // Check keystroke (non-blocking peek)
      if (emu.dosKeyBuffer.length > 0 && !(fromBiosStub && emu._dosKeyConsumedThisTick)) {
        const key = emu.dosKeyBuffer[0];
        cpu.setReg16(EAX, (key.scan << 8) | key.ascii);
        cpu.setFlag(ZF, false); // key available
      } else {
        cpu.setFlag(ZF, true); // no key
        // Peek is non-blocking — never suspend here.
        // Programs that busy-loop on peek will be throttled by the tick time limit.
      }
      break;
    }
    case 0x02: case 0x12: {
      // Get shift flags
      cpu.setReg8(EAX, 0); // no shift keys pressed
      break;
    }
    default:
      // Programs may use custom subfunctions (e.g. QBasic AH=0x55) that
      // only their own INT 16h handler understands. Silently ignore.
      break;
  }
  return true;
}
