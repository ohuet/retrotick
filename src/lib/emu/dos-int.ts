import type { CPU } from './x86/cpu';
import type { Emulator } from './emulator';
import type { DirEntry } from './file-manager';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
const CF = 0x001;
const ZF = 0x040;

// Video memory base (B800:0000 in real mode)
const VIDEO_MEM_BASE = 0xB8000;
const SCREEN_COLS = 80;
const SCREEN_ROWS = 25;

/** Resolve a DOS path using per-process current drive/directory. */
function dosResolvePath(emu: Emulator, input: string): string {
  let p = input.replace(/\//g, '\\');
  p = p.replace(/(?!^)\\\\+/g, '\\');
  let resolved: string;
  if (/^[A-Za-z]:\\/.test(p)) {
    resolved = p;
  } else if (/^[A-Za-z]:$/.test(p)) {
    const drive = p[0].toUpperCase();
    resolved = emu.currentDirs.get(drive) || (drive + ':\\');
  } else if (/^[A-Za-z]:/.test(p) && p[2] !== '\\') {
    const drive = p[0].toUpperCase();
    const rel = p.substring(2);
    const base = emu.currentDirs.get(drive) || (drive + ':\\');
    resolved = base.endsWith('\\') ? base + rel : base + '\\' + rel;
  } else if (p.startsWith('\\')) {
    resolved = emu.currentDrive + ':' + p;
  } else {
    const base = emu.currentDirs.get(emu.currentDrive) || (emu.currentDrive + ':\\');
    resolved = base.endsWith('\\') ? base + p : base + '\\' + p;
  }
  return resolved.toUpperCase();
}

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

function handleInt09(cpu: CPU, emu: Emulator): boolean {
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

// --- INT 10h: Video BIOS ---
function handleInt10(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  const al = cpu.reg[EAX] & 0xFF;

  switch (ah) {
    case 0x00: // Set video mode
      // Mode 03h = 80x25 text color. Just clear screen.
      if (al === 0x03 || al === 0x07) {
        clearVideoMem(cpu, emu, 0x07);
        emu.consoleCursorX = 0;
        emu.consoleCursorY = 0;
      }
      break;

    case 0x01: // Set cursor shape (CX = start/end scan lines)
      // Ignore — we always show a block cursor
      break;

    case 0x02: { // Set cursor position (BH=page, DH=row, DL=col)
      const row = (cpu.reg[EDX] >> 8) & 0xFF;
      const col = cpu.reg[EDX] & 0xFF;
      emu.consoleCursorY = Math.min(row, SCREEN_ROWS - 1);
      emu.consoleCursorX = Math.min(col, SCREEN_COLS - 1);
      break;
    }

    case 0x03: { // Get cursor position (BH=page) → DH=row, DL=col, CX=cursor shape
      const row = emu.consoleCursorY;
      const col = emu.consoleCursorX;
      cpu.setReg16(EDX, (row << 8) | col);
      cpu.setReg16(ECX, 0x0607); // default cursor shape
      break;
    }

    case 0x06: { // Scroll up (AL=lines, BH=attr, CX=top-left, DX=bottom-right)
      const lines = al || SCREEN_ROWS; // 0 = clear entire window
      const attr = (cpu.reg[EBX] >> 8) & 0xFF;
      const top = (cpu.reg[ECX] >> 8) & 0xFF;
      const left = cpu.reg[ECX] & 0xFF;
      const bottom = (cpu.reg[EDX] >> 8) & 0xFF;
      const right = cpu.reg[EDX] & 0xFF;
      scrollUp(cpu, emu, lines, attr, top, left, bottom, right);
      break;
    }

    case 0x07: { // Scroll down
      const lines = al || SCREEN_ROWS;
      const attr = (cpu.reg[EBX] >> 8) & 0xFF;
      const top = (cpu.reg[ECX] >> 8) & 0xFF;
      const left = cpu.reg[ECX] & 0xFF;
      const bottom = (cpu.reg[EDX] >> 8) & 0xFF;
      const right = cpu.reg[EDX] & 0xFF;
      scrollDown(cpu, emu, lines, attr, top, left, bottom, right);
      break;
    }

    case 0x08: { // Read char+attr at cursor (BH=page) → AH=attr, AL=char
      const off = (emu.consoleCursorY * SCREEN_COLS + emu.consoleCursorX) * 2;
      const ch = cpu.mem.readU8(VIDEO_MEM_BASE + off);
      const attr = cpu.mem.readU8(VIDEO_MEM_BASE + off + 1);
      cpu.setReg16(EAX, (attr << 8) | ch);
      break;
    }

    case 0x09: { // Write char+attr at cursor (AL=char, BH=page, BL=attr, CX=count)
      const ch = al;
      const attr = cpu.reg[EBX] & 0xFF;
      const count = cpu.getReg16(ECX);
      let cx = emu.consoleCursorX;
      let cy = emu.consoleCursorY;
      for (let i = 0; i < count; i++) {
        const off = (cy * SCREEN_COLS + cx) * 2;
        cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
        cpu.mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
        cx++;
        if (cx >= SCREEN_COLS) { cx = 0; cy++; }
        if (cy >= SCREEN_ROWS) break;
      }
      break;
    }

    case 0x0A: { // Write char at cursor (no attr change)
      const ch = al;
      const count = cpu.getReg16(ECX);
      let cx = emu.consoleCursorX;
      let cy = emu.consoleCursorY;
      for (let i = 0; i < count; i++) {
        const off = (cy * SCREEN_COLS + cx) * 2;
        cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
        cx++;
        if (cx >= SCREEN_COLS) { cx = 0; cy++; }
        if (cy >= SCREEN_ROWS) break;
      }
      break;
    }

    case 0x0E: { // Teletype output (AL=char, BL=color)
      teletypeOutput(cpu, emu, al);
      break;
    }

    case 0x0F: // Get video mode → AH=cols, AL=mode, BH=page
      cpu.setReg16(EAX, (SCREEN_COLS << 8) | 0x03);
      cpu.setReg8(7 /* BH */, 0); // page 0  — setReg8(7) not available, use full reg
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF00FF); // BH=0
      break;

    case 0x10: // Set palette registers — ignore
      break;

    case 0x11: { // Character generator
      if (al === 0x30) {
        // Get font info: BH=pointer specifier
        // Return: CX=bytes per character, DL=rows-1
        cpu.setReg16(ECX, 16); // 16 bytes per character (8x16 font)
        const dl = SCREEN_ROWS - 1; // 24
        cpu.setReg16(EDX, (cpu.getReg16(EDX) & 0xFF00) | dl);
      }
      break;
    }

    case 0x12: // Alternate select (video subsystem config)
      // BL=10h: get video configuration info
      // Return BH=0 (color), BL=03 (256K), CX=0
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0003;
      cpu.setReg16(ECX, 0);
      break;

    case 0x1A: // Get/set display combination
      if (al === 0x00) {
        // Get: AL=1A (function supported), BL=08 (VGA color), BH=00
        cpu.setReg8(EAX, 0x1A);
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0008;
      }
      break;

    case 0x05: // Select active display page (AL=page number)
      // We only support page 0 — ignore silently
      break;

    case 0x1B: { // Functionality/state information (BX=implementation type)
      // Return AL=1B if supported. Write 64-byte state table at ES:DI.
      const esBas = cpu.segBase(cpu.es);
      const di = cpu.getReg16(EDI);
      const addr = esBas + di;
      // Zero 64 bytes
      for (let i = 0; i < 64; i++) cpu.mem.writeU8(addr + i, 0);
      // Static functionality table pointer (offset 0): null
      cpu.mem.writeU32(addr + 0x00, 0);
      // Video mode (offset 4): 03h
      cpu.mem.writeU8(addr + 0x04, 0x03);
      // Number of columns (offset 5-6)
      cpu.mem.writeU16(addr + 0x05, SCREEN_COLS);
      // Regen buffer length (offset 7-8)
      cpu.mem.writeU16(addr + 0x07, SCREEN_COLS * SCREEN_ROWS * 2);
      // Cursor position page 0 (offset 0x0B-0x0C)
      cpu.mem.writeU8(addr + 0x0B, emu.consoleCursorX);
      cpu.mem.writeU8(addr + 0x0C, emu.consoleCursorY);
      // Cursor type (offset 0x23-0x24)
      cpu.mem.writeU16(addr + 0x23, 0x0607);
      // Active page (offset 0x25)
      cpu.mem.writeU8(addr + 0x25, 0);
      // Rows on screen -1 (offset 0x29)
      cpu.mem.writeU8(addr + 0x29, SCREEN_ROWS - 1);
      // Character height (offset 0x2A)
      cpu.mem.writeU8(addr + 0x2A, 16);
      // Active display code (offset 0x2B): 08 = VGA color
      cpu.mem.writeU8(addr + 0x2B, 0x08);
      cpu.setReg8(EAX, 0x1B); // AL=1Bh = supported
      break;
    }

    case 0xFE: // Get video buffer — ignore (return original ES:DI)
      break;

    default:
      // Silently ignore unknown subfunctions (includes vendor-specific EFh, FAh, etc.)
      break;
  }
  return true;
}

// --- INT 16h: Keyboard BIOS ---
function handleInt16(cpu: CPU, emu: Emulator, fromBiosStub = false): boolean {
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

// --- INT 20h: Terminate ---
function handleInt20(cpu: CPU, emu: Emulator): boolean {
  emu.exitedNormally = true;
  emu.halted = true;
  cpu.halted = true;
  return true;
}

// --- INT 21h: DOS Services ---
function handleInt21(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  const al = cpu.reg[EAX] & 0xFF;
  switch (ah) {
    case 0x00: // Old-style terminate (same as INT 20h)
      emu.halted = true;
      cpu.halted = true;
      break;

    case 0x01: { // Read character with echo (blocking)
      if (emu.dosKeyBuffer.length > 0) {
        const key = emu.dosKeyBuffer.shift()!;
        cpu.setReg8(EAX, key.ascii);
        teletypeOutput(cpu, emu, key.ascii);
      } else {
        emu._dosWaitingForKey = 'read';
        emu.waitingForMessage = true;
      }
      break;
    }

    case 0x02: { // Write character to stdout
      const ch = cpu.reg[EDX] & 0xFF;
      teletypeOutput(cpu, emu, ch);
      break;
    }

    case 0x07: // Direct char input without echo (blocking, no Ctrl-C check)
    case 0x08: { // Char input without echo (blocking, Ctrl-C check)
      if (emu.dosKeyBuffer.length > 0) {
        const key = emu.dosKeyBuffer.shift()!;
        cpu.setReg8(EAX, key.ascii);
      } else {
        emu._dosWaitingForKey = 'read';
        emu.waitingForMessage = true;
      }
      break;
    }

    case 0x06: { // Direct console I/O
      const dl = cpu.reg[EDX] & 0xFF;
      if (dl === 0xFF) {
        // Input: check for keystroke
        if (emu.dosKeyBuffer.length > 0) {
          const key = emu.dosKeyBuffer.shift()!;
          cpu.setReg8(EAX, key.ascii);
          cpu.setFlag(ZF, false);
        } else {
          cpu.setReg8(EAX, 0);
          cpu.setFlag(ZF, true);
        }
      } else {
        // Output
        teletypeOutput(cpu, emu, dl);
      }
      break;
    }

    case 0x09: { // Write '$'-terminated string (DS:DX)
      const dsBase = cpu.segBase(cpu.ds);
      const dx = cpu.getReg16(EDX);
      let addr = dsBase + dx;
      for (let i = 0; i < 65536; i++) {
        const ch = cpu.mem.readU8(addr);
        if (ch === 0x24) break; // '$'
        teletypeOutput(cpu, emu, ch);
        addr++;
      }
      break;
    }

    case 0x0A: { // Buffered input (DS:DX → buffer)
      // Block for input — simplified: we'll treat this as blocking
      emu._dosWaitingForKey = 'read';
      emu.waitingForMessage = true;
      break;
    }

    case 0x0B: // Check stdin status → AL=0xFF if char available, 0x00 if not
      cpu.setReg8(EAX, emu.dosKeyBuffer.length > 0 ? 0xFF : 0x00);
      break;

    case 0x0E: { // Select default drive (DL=drive number 0=A,1=B,2=C...)
      const dl = cpu.reg[EDX] & 0xFF;
      const driveLetter = String.fromCharCode(0x41 + Math.min(dl, 25));
      emu.currentDrive = driveLetter;
      cpu.setReg8(EAX, 26); // AL = number of logical drives
      break;
    }

    case 0x19: { // Get current drive → AL=drive number
      const driveCode = emu.currentDrive.charCodeAt(0) - 0x41;
      cpu.setReg8(EAX, driveCode);
      break;
    }

    case 0x1A: { // Set DTA address (DS:DX)
      const dsBase = cpu.segBase(cpu.ds);
      emu._dosDTA = dsBase + cpu.getReg16(EDX);
      break;
    }

    case 0x1C: { // Get drive info (DL=drive, 0=default)
      // Return: AL=sectors/cluster, CX=bytes/sector, DX=total clusters, DS:BX→media ID byte
      cpu.setReg8(EAX, 8);       // 8 sectors per cluster
      cpu.setReg16(ECX, 512);    // 512 bytes per sector
      cpu.setReg16(EDX, 65535);  // total clusters
      break;
    }

    case 0x25: { // Set interrupt vector (AL=int, DS:DX=handler)
      const intNo = al;
      const handler = (cpu.getReg16(EDX)) | (cpu.ds << 16);
      emu._dosIntVectors.set(intNo, handler);
      // Also update the real IVT in memory so programs that read it directly
      // (e.g. CALL FAR through IVT) get the correct vector
      emu.memory.writeU16(intNo * 4, cpu.getReg16(EDX));     // offset
      emu.memory.writeU16(intNo * 4 + 2, cpu.ds);            // segment
      break;
    }

    case 0x2A: { // Get date → CX=year, DH=month, DL=day, AL=day of week
      const now = new Date();
      cpu.setReg16(ECX, now.getFullYear());
      cpu.setReg16(EDX, ((now.getMonth() + 1) << 8) | now.getDate());
      cpu.setReg8(EAX, now.getDay());
      break;
    }

    case 0x2C: { // Get time → CH=hour, CL=min, DH=sec, DL=1/100sec
      const now = new Date();
      cpu.setReg16(ECX, (now.getHours() << 8) | now.getMinutes());
      cpu.setReg16(EDX, (now.getSeconds() << 8) | Math.floor(now.getMilliseconds() / 10));
      break;
    }

    case 0x2F: { // Get DTA → ES:BX
      const dta = emu._dosDTA || 0;
      // For 16-bit: return segment:offset
      // Put linear address for now (works with our segment base setup)
      cpu.setReg16(EBX, dta & 0xFFFF);
      cpu.es = (dta >>> 4) & 0xFFFF;
      break;
    }

    case 0x30: { // Get DOS version → AL=major, AH=minor
      // AL on entry: 0=standard, 1=get true version
      const DOS_MAJOR = 5;
      const DOS_MINOR = 0;
      cpu.setReg16(EAX, (DOS_MINOR << 8) | DOS_MAJOR); // AL=major, AH=minor
      cpu.setReg16(EBX, 0x0000); // BH=version flag, BL=OEM serial
      cpu.setReg16(ECX, 0x0000);
      break;
    }

    case 0x33: // Get/set Ctrl-C check state
      if (al === 0x00) cpu.setReg8(2 /* DL */, 0); // DL=0 OFF
      break;

    case 0x35: { // Get interrupt vector (AL=int) → ES:BX
      const vec = emu._dosIntVectors.get(al) || 0;
      cpu.setReg16(EBX, vec & 0xFFFF);
      cpu.es = (vec >>> 16) & 0xFFFF;
      break;
    }

    case 0x36: { // Get free disk space (DL=drive, 0=default)
      // AX=sectors/cluster, BX=available clusters, CX=bytes/sector, DX=total clusters
      cpu.setReg16(EAX, 8);       // 8 sectors per cluster
      cpu.setReg16(EBX, 32768);   // ~128MB free
      cpu.setReg16(ECX, 512);     // 512 bytes per sector
      cpu.setReg16(EDX, 65535);   // total clusters
      cpu.setFlag(CF, false);
      break;
    }

    case 0x3B: { // Change current directory (DS:DX=path)
      const dsBase = cpu.segBase(cpu.ds);
      const dx = cpu.getReg16(EDX);
      let path = '';
      for (let i = 0; i < 128; i++) {
        const ch = cpu.mem.readU8(dsBase + dx + i);
        if (ch === 0) break;
        path += String.fromCharCode(ch);
      }
      const resolved = dosResolvePath(emu, path);
      const drive = resolved[0];
      emu.currentDirs.set(drive, resolved);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x3C: { // Create file (CX=attributes, DS:DX=filename)
      const dsBase = cpu.segBase(cpu.ds);
      const nameAddr = dsBase + cpu.getReg16(EDX);
      let name = '';
      for (let i = 0; i < 128; i++) {
        const ch = cpu.mem.readU8(nameAddr + i);
        if (ch === 0) break;
        name += String.fromCharCode(ch);
      }
      const resolved = dosResolvePath(emu, name);
      const handle = emu._dosNextHandle++;
      const emptyData = new Uint8Array(0);
      emu.fs.openFile(handle, { path: resolved, access: 0x40000000, pos: 0, data: emptyData, size: 0, modified: true });
      emu._dosFiles.set(handle, { data: emptyData, pos: 0, name });
      cpu.setReg16(EAX, handle);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x3D: { // Open file (AL=mode, DS:DX=filename)
      const dsBase = cpu.segBase(cpu.ds);
      const nameAddr = dsBase + cpu.getReg16(EDX);
      let name = '';
      for (let i = 0; i < 128; i++) {
        const ch = cpu.mem.readU8(nameAddr + i);
        if (ch === 0) break;
        name += String.fromCharCode(ch);
      }
      const resolved = dosResolvePath(emu, name);
      const fileInfo = emu.fs.findFile(resolved, emu.additionalFiles);
      if (fileInfo) {
        // File found in virtual FS — need to fetch data (may be async)
        const handle = emu._dosNextHandle++;
        const dataPromise = emu.fs.fetchFileData(fileInfo, emu.additionalFiles, resolved);
        dataPromise.then((buf) => {
          const data = buf ? new Uint8Array(buf) : new Uint8Array(0);
          emu._dosFiles.set(handle, { data, pos: 0, name });
          emu.fs.openFile(handle, { path: resolved, access: 0x80000000, pos: 0, data, size: data.length, modified: false });
          cpu.setReg16(EAX, handle);
          cpu.setFlag(CF, false);
          if (emu._dosFileOpenPending) {
            emu._dosFileOpenPending = false;
            emu.waitingForMessage = false;
            if (emu.running && !emu.halted) {
              requestAnimationFrame(emu.tick);
            }
          }
        });
        // If it's an already-resolved promise (additionalFiles/externalFiles), it will
        // complete synchronously in microtask. Otherwise, suspend.
        // We detect this by checking if the handle was populated after the .then() setup.
        // Use a microtask check: set pending, clear in .then if sync.
        emu._dosFileOpenPending = true;
        // Give microtask a chance to resolve synchronously
        Promise.resolve().then(() => {
          if (emu._dosFileOpenPending && !emu._dosFiles.has(handle)) {
            // Truly async — suspend emulation
            emu.waitingForMessage = true;
          } else {
            emu._dosFileOpenPending = false;
          }
        });
        break;
      }
      // Fallback: try the loaded EXE data (EDIT.COM reads itself for resources)
      if (emu._dosExeData) {
        const handle = emu._dosNextHandle++;
        emu._dosFiles.set(handle, { data: emu._dosExeData, pos: 0, name });
        cpu.setReg16(EAX, handle);
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 2); // file not found
      }
      break;
    }

    case 0x3E: { // Close file
      const h = cpu.getReg16(EBX);
      emu._dosFiles.delete(h);
      if (emu.fs.hasOpenFile(h)) {
        emu.fs.closeFile(h);
      }
      cpu.setFlag(CF, false);
      break;
    }

    case 0x3F: { // Read file (BX=handle, CX=count, DS:DX=buffer)
      const h = cpu.getReg16(EBX);
      const count = cpu.getReg16(ECX);
      const dsBase = cpu.segBase(cpu.ds);
      const bufAddr = dsBase + cpu.getReg16(EDX);
      if (h <= 2) {
        // stdin — return 0 bytes for now
        cpu.setReg16(EAX, 0);
        cpu.setFlag(CF, false);
      } else {
        const f = emu._dosFiles.get(h);
        if (f) {
          const avail = Math.min(count, f.data.length - f.pos);
          for (let i = 0; i < avail; i++) {
            cpu.mem.writeU8(bufAddr + i, f.data[f.pos + i]);
          }
          f.pos += avail;
          cpu.setReg16(EAX, avail);
          cpu.setFlag(CF, false);
        } else {
          cpu.setFlag(CF, true);
          cpu.setReg16(EAX, 6); // invalid handle
        }
      }
      break;
    }

    case 0x42: { // Seek file (BX=handle, AL=origin, CX:DX=offset)
      const h = cpu.getReg16(EBX);
      const origin = al;
      const offset = (cpu.getReg16(ECX) << 16) | cpu.getReg16(EDX);
      const f = emu._dosFiles.get(h);
      if (f) {
        if (origin === 0) f.pos = offset;           // SEEK_SET
        else if (origin === 1) f.pos += offset;      // SEEK_CUR
        else if (origin === 2) f.pos = f.data.length + offset; // SEEK_END
        f.pos = Math.max(0, Math.min(f.pos, f.data.length));
        const of = emu.fs.getOpenFile(h);
        if (of) of.pos = f.pos;
        cpu.setReg16(EDX, (f.pos >>> 16) & 0xFFFF);
        cpu.setReg16(EAX, f.pos & 0xFFFF);
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 6);
      }
      break;
    }

    case 0x43: { // Get/Set file attributes
      if (al === 0x00) {
        // Get file attributes — return normal file
        cpu.setReg16(ECX, 0x0020); // archive bit
        cpu.setFlag(CF, false);
      } else {
        // Set file attributes — succeed
        cpu.setFlag(CF, false);
      }
      break;
    }

    case 0x47: { // Get current directory (DL=drive, DS:SI → 64-byte buffer)
      const dsBase = cpu.segBase(cpu.ds);
      const si = cpu.getReg16(ESI);
      const dl = cpu.reg[EDX] & 0xFF;
      const driveLetter = dl === 0 ? emu.currentDrive : String.fromCharCode(0x40 + dl);
      const curDir = emu.currentDirs.get(driveLetter) || (driveLetter + ':\\');
      // DOS convention: return path without drive letter and without leading backslash
      // e.g. "C:\WINDOWS\SYSTEM32" → "WINDOWS\SYSTEM32", "C:\" → ""
      let dirStr = curDir.length > 3 ? curDir.substring(3) : '';
      for (let i = 0; i < dirStr.length && i < 63; i++) {
        cpu.mem.writeU8(dsBase + si + i, dirStr.charCodeAt(i));
      }
      cpu.mem.writeU8(dsBase + si + Math.min(dirStr.length, 63), 0);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x52: { // Get List of Lists → ES:BX
      // Build LoL structure if not already done
      if (!emu._dosLoLAddr) {
        buildDosLoL(cpu, emu);
      }
      const lolAddr = emu._dosLoLAddr!;
      cpu.es = (lolAddr >>> 4) & 0xFFFF;
      cpu.setReg16(EBX, lolAddr & 0x0F);
      break;
    }

    case 0x4E: { // FindFirst (CX=attributes, DS:DX=filespec)
      const dsBase = cpu.segBase(cpu.ds);
      const specAddr = dsBase + cpu.getReg16(EDX);
      let spec = '';
      for (let i = 0; i < 128; i++) {
        const ch = cpu.mem.readU8(specAddr + i);
        if (ch === 0) break;
        spec += String.fromCharCode(ch);
      }
      const resolvedSpec = dosResolvePath(emu, spec);
      const entries = emu.fs.getVirtualDirListing(resolvedSpec, emu.additionalFiles);
      if (entries.length > 0) {
        emu._dosFindState = { entries, index: 0, pattern: spec };
        writeDtaEntry(cpu, emu, entries[0]);
        cpu.setFlag(CF, false);
      } else {
        emu._dosFindState = null;
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 18); // no more files
      }
      break;
    }

    case 0x4F: { // FindNext
      if (emu._dosFindState) {
        emu._dosFindState.index++;
        if (emu._dosFindState.index < emu._dosFindState.entries.length) {
          writeDtaEntry(cpu, emu, emu._dosFindState.entries[emu._dosFindState.index]);
          cpu.setFlag(CF, false);
        } else {
          emu._dosFindState = null;
          cpu.setFlag(CF, true);
          cpu.setReg16(EAX, 18); // no more files
        }
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 18);
      }
      break;
    }

    case 0x40: { // Write to file handle (BX=handle, CX=count, DS:DX=buffer)
      const handle = cpu.getReg16(EBX);
      const count = cpu.getReg16(ECX);
      const dsBase = cpu.segBase(cpu.ds);
      const bufAddr = dsBase + cpu.getReg16(EDX);
      if (handle === 1 || handle === 2) {
        // stdout/stderr → console
        for (let i = 0; i < count; i++) {
          teletypeOutput(cpu, emu, cpu.mem.readU8(bufAddr + i));
        }
        cpu.setReg16(EAX, count);
        cpu.setFlag(CF, false);
      } else {
        const f = emu._dosFiles.get(handle);
        if (f) {
          // Grow buffer if needed
          const needed = f.pos + count;
          if (needed > f.data.length) {
            const newData = new Uint8Array(needed);
            newData.set(f.data);
            f.data = newData;
          }
          for (let i = 0; i < count; i++) {
            f.data[f.pos + i] = cpu.mem.readU8(bufAddr + i);
          }
          f.pos += count;
          // Sync to emu.fs OpenFile
          const of = emu.fs.getOpenFile(handle);
          if (of) {
            of.data = f.data;
            of.pos = f.pos;
            of.size = f.data.length;
            of.modified = true;
          }
          cpu.setReg16(EAX, count);
          cpu.setFlag(CF, false);
        } else {
          cpu.setFlag(CF, true);
          cpu.setReg16(EAX, 6); // invalid handle
        }
      }
      break;
    }

    case 0x44: { // IOCTL
      const subFunc = al;
      if (subFunc === 0x00) {
        // Get device info for handle BX
        const handle = cpu.getReg16(EBX);
        if (handle <= 4) {
          cpu.setReg16(EDX, 0x80D3); // character device, stdin/stdout/stderr/stdaux/stdprn
          cpu.setFlag(CF, false);
        } else if (emu._dosFiles.has(handle) || emu.fs.hasOpenFile(handle)) {
          cpu.setReg16(EDX, 0x0000); // disk file (bit 7=0)
          cpu.setFlag(CF, false);
        } else {
          cpu.setFlag(CF, true);
          cpu.setReg16(EAX, 6);
        }
      } else if (subFunc === 0x01) {
        // Set device info for handle BX — just accept it
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 1); // invalid function
      }
      break;
    }

    case 0x48: { // Allocate memory (BX=paragraphs)
      const paras = cpu.getReg16(EBX);
      // Walk MCB chain to find a free block large enough
      const firstMcb = emu._dosMcbFirstSeg || 0x0060;
      let mcbSeg = firstMcb;
      let allocated = false;
      let largestFree = 0;
      for (let iter = 0; iter < 1000; iter++) {
        const mcbLin = mcbSeg * 16;
        const type = cpu.mem.readU8(mcbLin);
        const owner = cpu.mem.readU16(mcbLin + 1);
        const size = cpu.mem.readU16(mcbLin + 3);
        if (owner === 0 && size >= paras) {
          // Found a free block — split it
          const blockSeg = mcbSeg + 1;
          const pspSeg = emu._dosPSP || emu._dosLoadSegment || 0x100;
          cpu.mem.writeU16(mcbLin + 1, pspSeg); // owner = current PSP
          if (size > paras + 1) {
            // Split: shrink this MCB and create a new free MCB after
            cpu.mem.writeU16(mcbLin + 3, paras);
            cpu.mem.writeU8(mcbLin, 0x4D); // 'M'
            const newMcbSeg = blockSeg + paras;
            const newMcbLin = newMcbSeg * 16;
            cpu.mem.writeU8(newMcbLin, type); // inherit 'M' or 'Z'
            cpu.mem.writeU16(newMcbLin + 1, 0x0000); // free
            cpu.mem.writeU16(newMcbLin + 3, size - paras - 1);
          }
          cpu.setReg16(EAX, blockSeg);
          cpu.setFlag(CF, false);
          allocated = true;
          break;
        }
        if (owner === 0 && size > largestFree) largestFree = size;
        if (type === 0x5A) break; // last block
        mcbSeg += size + 1;
      }
      if (!allocated) {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 8); // insufficient memory
        cpu.setReg16(EBX, largestFree);
      }
      break;
    }

    case 0x49: { // Free memory (ES=segment of block)
      const blockSeg = cpu.es;
      const mcbLin = (blockSeg - 1) * 16;
      const type = cpu.mem.readU8(mcbLin);
      if (type === 0x4D || type === 0x5A) {
        cpu.mem.writeU16(mcbLin + 1, 0x0000); // mark as free
      }
      cpu.setFlag(CF, false);
      break;
    }

    case 0x4A: { // Resize memory block (ES=segment, BX=new size in paragraphs)
      const blockSeg = cpu.es;
      const newParas = cpu.getReg16(EBX);
      const topOfMem = 0xA000;

      // Update MCB at blockSeg - 1
      const mcbLinear = (blockSeg - 1) * 16;
      const mcbType = cpu.mem.readU8(mcbLinear);
      if (mcbType === 0x4D || mcbType === 0x5A) {
        const oldParas = cpu.mem.readU16(mcbLinear + 3);
        if (blockSeg + newParas > topOfMem) {
          // Not enough memory
          cpu.setFlag(CF, true);
          cpu.setReg16(EAX, 8); // insufficient memory
          cpu.setReg16(EBX, topOfMem - blockSeg); // max available
          break;
        }
        // Update this MCB's size
        cpu.mem.writeU16(mcbLinear + 3, newParas);

        // Update or create the free MCB after the resized block
        const freeSeg = blockSeg + newParas;
        const freeLinear = freeSeg * 16;
        const freeParas = topOfMem - freeSeg - 1;
        if (freeParas > 0) {
          cpu.mem.writeU8(mcbLinear, 0x4D); // more blocks follow
          cpu.mem.writeU8(freeLinear, 0x5A); // last block
          cpu.mem.writeU16(freeLinear + 1, 0x0000); // free
          cpu.mem.writeU16(freeLinear + 3, freeParas);
        } else {
          cpu.mem.writeU8(mcbLinear, 0x5A); // this is now last block
        }
      }

      // Update heap pointers
      const blockEnd = (blockSeg + newParas) * 16;
      if (blockEnd > emu.heapBase) {
        emu.heapBase = ((blockEnd + 0xF) & ~0xF);
        emu.heapPtr = emu.heapBase;
      }
      cpu.setFlag(CF, false);
      break;
    }

    case 0x4C: // Terminate with return code
      emu.exitedNormally = true;
      emu.halted = true;
      cpu.halted = true;
      break;

    case 0x50: { // Set PSP segment
      emu._dosPSP = cpu.getReg16(EBX);
      break;
    }

    case 0x51: case 0x62: { // Get PSP segment → BX
      cpu.setReg16(EBX, emu._dosPSP || emu._dosLoadSegment || 0);
      break;
    }

    case 0x66: { // Get/Set global code page
      if (al === 0x01) {
        // Get: BX = active code page, DX = system code page
        cpu.setReg16(EBX, 437); // US English
        cpu.setReg16(EDX, 437);
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, false); // Set — just succeed
      }
      break;
    }

    case 0x65: { // Get Extended Country Information
      if (al === 0x02 || al === 0x06) {
        // AL=02: Get uppercase table, AL=06: Get collating table
        // Write a minimal info block at ES:DI
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(EDI);
        const addr = esBase + di;
        cpu.mem.writeU8(addr, al); // info ID
        // Write a pointer to a 256-byte identity map
        // Allocate a small area for the table
        const tblAddr = emu.heapPtr;
        emu.heapPtr += 258;
        cpu.mem.writeU16(tblAddr, 256); // table size
        for (let j = 0; j < 256; j++) cpu.mem.writeU8(tblAddr + 2 + j, j);
        // Write far pointer to table (offset:segment)
        const tblSeg = (tblAddr >>> 4) & 0xFFFF;
        const tblOff = tblAddr & 0xF;
        cpu.mem.writeU16(addr + 1, tblOff);
        cpu.mem.writeU16(addr + 3, tblSeg);
        cpu.setReg16(ECX, 5);
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 1);
      }
      break;
    }

    case 0x71:
      // Windows 95 Long Filename (LFN) API — not supported
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 0x7100); // function not supported
      break;

    case 0x63: { // Get Lead Byte Table (DBCS)
      // DS:SI → empty DBCS lead byte table (just a terminating 0x0000)
      // Use a fixed address in low memory (0x600 — free DOS area)
      const tblLinear = 0x600;
      cpu.mem.writeU16(tblLinear, 0); // empty table = 0x0000 terminator
      cpu.ds = (tblLinear >> 4) & 0xFFFF;
      cpu.setReg16(ESI, tblLinear & 0xF);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x29: { // Parse Filename into FCB
      const flags = cpu.getReg8(EAX); // AL = parsing flags
      let si = (cpu.ds << 4) + cpu.getReg16(ESI);
      const di = (cpu.es << 4) + cpu.getReg16(EDI);
      const mem = cpu.mem;

      // Skip leading separators if bit 0 set
      if (flags & 1) {
        while (si < mem.length) {
          const ch = mem.readU8(si);
          if (ch === 0x20 || ch === 0x09) { si++; } // space/tab
          else break;
        }
      }

      // Initialize FCB: drive=0, filename=spaces, extension=spaces
      mem.writeU8(di, 0); // drive
      for (let i = 1; i <= 8; i++) mem.writeU8(di + i, 0x20); // filename
      for (let i = 9; i <= 11; i++) mem.writeU8(di + i, 0x20); // extension

      let hasWild = false;
      let pos = si;

      // Check for drive letter
      if (pos + 1 < mem.length && mem.readU8(pos + 1) === 0x3A) { // ':'
        const drv = mem.readU8(pos);
        const drvNum = (drv >= 0x61 ? drv - 0x60 : drv >= 0x41 ? drv - 0x40 : 0);
        mem.writeU8(di, drvNum);
        pos += 2;
      }

      // Parse filename (up to 8 chars)
      let fnIdx = 0;
      while (pos < mem.length && fnIdx < 8) {
        const ch = mem.readU8(pos);
        if (ch === 0 || ch === 0x0D || ch === 0x20 || ch === 0x09 || ch === 0x2E || ch === 0x2F || ch === 0x5C) break;
        if (ch === 0x2A) { // '*' — fill rest with '?'
          hasWild = true;
          for (; fnIdx < 8; fnIdx++) mem.writeU8(di + 1 + fnIdx, 0x3F);
          pos++;
          break;
        }
        if (ch === 0x3F) hasWild = true;
        mem.writeU8(di + 1 + fnIdx, ch >= 0x61 && ch <= 0x7A ? ch - 0x20 : ch);
        fnIdx++;
        pos++;
      }

      // Parse extension if '.' present
      if (pos < mem.length && mem.readU8(pos) === 0x2E) {
        pos++; // skip '.'
        let extIdx = 0;
        while (pos < mem.length && extIdx < 3) {
          const ch = mem.readU8(pos);
          if (ch === 0 || ch === 0x0D || ch === 0x20 || ch === 0x09 || ch === 0x2F || ch === 0x5C) break;
          if (ch === 0x2A) {
            hasWild = true;
            for (; extIdx < 3; extIdx++) mem.writeU8(di + 9 + extIdx, 0x3F);
            pos++;
            break;
          }
          if (ch === 0x3F) hasWild = true;
          mem.writeU8(di + 9 + extIdx, ch >= 0x61 && ch <= 0x7A ? ch - 0x20 : ch);
          extIdx++;
          pos++;
        }
      }

      // Update DS:SI to point past parsed name
      cpu.setReg16(ESI, pos & 0xFFFF);
      // AL = 0 (no wildcards), 1 (wildcards found)
      cpu.setReg8(EAX, hasWild ? 1 : 0);
      break;
    }

    case 0x4B: { // EXEC — Load and Execute Program
      // AL=00 Load+Execute, AL=01 Load overlay, AL=03 Load only
      // DS:DX → ASCIZ program name, ES:BX → parameter block
      const dsBase = cpu.segBase(cpu.ds);
      const progName = cpu.mem.readCString(dsBase + cpu.getReg16(EDX));
      // Parameter block at ES:BX: word envSeg, dword cmdTail, ...
      const esBase = cpu.segBase(cpu.es);
      const paramBlock = esBase + cpu.getReg16(EBX);
      const cmdTailOfs = cpu.mem.readU16(paramBlock + 2);
      const cmdTailSeg = cpu.mem.readU16(paramBlock + 4);
      const cmdTailAddr = (cmdTailSeg << 4) + cmdTailOfs;
      // Command tail: first byte = length, then the string
      const cmdLen = cpu.mem.readU8(cmdTailAddr);
      let cmdTail = '';
      for (let i = 0; i < cmdLen; i++) {
        const ch = cpu.mem.readU8(cmdTailAddr + 1 + i);
        if (ch === 0x0D || ch === 0) break;
        cmdTail += String.fromCharCode(ch);
      }
      console.warn(`[INT 21h] EXEC not supported: "${progName}" params="${cmdTail}" (AL=${al})`);
      // Return "file not found"
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 2); // ERROR_FILE_NOT_FOUND
      break;
    }

    default:
      console.warn(`[INT 21h] Unhandled AH=0x${ah.toString(16)} at EIP=0x${(cpu.eip >>> 0).toString(16)}`);
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 1); // invalid function
      break;
  }
  return true;
}

// --- INT 2Fh: Multiplex ---
function handleInt2F(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  const ah = (ax >> 8) & 0xFF;
  const al = ax & 0xFF;

  if (ah === 0x12 && al === 0x2E) {
    // SYSMSG interface — DL selects subfunction
    // DL=0: parse error msgs, DL=2: extended error msgs,
    // DL=4: utility msgs, DL=6: critical error msgs,
    // DL=8: get counts/extended info (CX=number of parse errors on entry)
    const dl = cpu.reg[EDX] & 0xFF;
    if (!emu._sysmsgTablesAddr) {
      // Allocate space for 5 stub tables (each 32 bytes apart)
      const base = ((emu.heapPtr + 0xF) & ~0xF); // paragraph-align
      emu.heapPtr = base + 256;
      emu._sysmsgTablesAddr = base;
      // Zero the area
      for (let i = 0; i < 256; i++) cpu.mem.writeU8(base + i, 0);
      // DL=0,2,4,6: Each table starts with a header byte (message count=0)
      // The SYSLOADMSG code checks that the pointer is non-null and reads the header
      // DL=8: returns CL=number of parse error msgs, CH=extended count
    }
    if (dl === 0x08) {
      // DL=8: "get extended error msg count"
      // CX on entry = number of parse error messages
      // Return: keep CX as-is (caller's count is accepted)
      return true;
    }
    // Return ES:DI pointing to a stub table area (different offset per DL value)
    const idx = (dl >>> 1) & 0x03; // DL=0→0, DL=2→1, DL=4→2, DL=6→3
    const tableAddr = emu._sysmsgTablesAddr + idx * 32;
    cpu.es = (tableAddr >>> 4) & 0xFFFF;
    cpu.setReg16(EDI, tableAddr & 0x0F);
    return true;
  }

  if (ax === 0x4300) {
    // XMS installation check — AL=0x80 means XMS driver installed, anything else means not
    cpu.setReg8(EAX, 0x00); // XMS not installed
    return true;
  }

  if (ax === 0x0500) {
    // DPMI detect — return AL=not available
    cpu.setReg8(EAX, 0xFF); // DPMI not present (AL != 0)
    return true;
  }

  console.warn(`[INT 2Fh] Unhandled AX=0x${ax.toString(16)} at EIP=0x${(cpu.eip >>> 0).toString(16)}`);
  return true;
}

// --- INT 15h: System Services ---
function handleInt15(cpu: CPU, _emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  switch (ah) {
    case 0xC0: { // Get system configuration table
      // Return ES:BX pointing to a minimal config table
      // For now, just fail gracefully
      cpu.setFlag(CF, true);
      cpu.setReg8(EAX + 4, 0x86); // AH = unsupported function
      break;
    }
    case 0xC2: { // PS/2 Pointing device
      // Not installed
      cpu.setFlag(CF, true);
      cpu.setReg8(EAX + 4, 0x04); // AH = error: interface error
      break;
    }
    default:
      cpu.setFlag(CF, true);
      break;
  }
  return true;
}

// --- INT 33h: Mouse ---
function handleInt33(cpu: CPU, _emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  if (ax === 0x0000) {
    // Check mouse installed: AX=0 (not installed)
    cpu.setReg16(EAX, 0);
    cpu.setReg16(EBX, 0);
  }
  return true;
}

// --- Helper functions ---

function clearVideoMem(cpu: CPU, emu: Emulator, attr: number): void {
  for (let i = 0; i < SCREEN_COLS * SCREEN_ROWS; i++) {
    cpu.mem.writeU8(VIDEO_MEM_BASE + i * 2, 0x20);
    cpu.mem.writeU8(VIDEO_MEM_BASE + i * 2 + 1, attr);
  }
  syncVideoMemory(emu);
}

function scrollUp(_cpu: CPU, emu: Emulator, lines: number, attr: number, top: number, left: number, bottom: number, right: number): void {
  const mem = emu.memory;
  if (lines >= (bottom - top + 1)) {
    // Clear the window
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * SCREEN_COLS + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  } else {
    for (let row = top; row <= bottom - lines; row++) {
      for (let col = left; col <= right; col++) {
        const dst = (row * SCREEN_COLS + col) * 2;
        const src = ((row + lines) * SCREEN_COLS + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + dst, mem.readU8(VIDEO_MEM_BASE + src));
        mem.writeU8(VIDEO_MEM_BASE + dst + 1, mem.readU8(VIDEO_MEM_BASE + src + 1));
      }
    }
    for (let row = bottom - lines + 1; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * SCREEN_COLS + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  }
  syncVideoMemory(emu);
}

function scrollDown(_cpu: CPU, emu: Emulator, lines: number, attr: number, top: number, left: number, bottom: number, right: number): void {
  const mem = emu.memory;
  if (lines >= (bottom - top + 1)) {
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * SCREEN_COLS + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  } else {
    for (let row = bottom; row >= top + lines; row--) {
      for (let col = left; col <= right; col++) {
        const dst = (row * SCREEN_COLS + col) * 2;
        const src = ((row - lines) * SCREEN_COLS + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + dst, mem.readU8(VIDEO_MEM_BASE + src));
        mem.writeU8(VIDEO_MEM_BASE + dst + 1, mem.readU8(VIDEO_MEM_BASE + src + 1));
      }
    }
    for (let row = top; row < top + lines; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * SCREEN_COLS + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  }
  syncVideoMemory(emu);
}

function teletypeOutput(cpu: CPU, emu: Emulator, ch: number): void {
  if (ch === 0x0D) {
    emu.consoleCursorX = 0;
    return;
  }
  if (ch === 0x0A) {
    emu.consoleCursorY++;
    if (emu.consoleCursorY >= SCREEN_ROWS) {
      scrollUp(cpu, emu, 1, 0x07, 0, 0, SCREEN_ROWS - 1, SCREEN_COLS - 1);
      emu.consoleCursorY = SCREEN_ROWS - 1;
    }
    return;
  }
  if (ch === 0x08) { // backspace
    if (emu.consoleCursorX > 0) emu.consoleCursorX--;
    return;
  }
  if (ch === 0x07) return; // bell

  const off = (emu.consoleCursorY * SCREEN_COLS + emu.consoleCursorX) * 2;
  cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
  cpu.mem.writeU8(VIDEO_MEM_BASE + off + 1, emu.consoleAttr);

  emu.consoleCursorX++;
  if (emu.consoleCursorX >= SCREEN_COLS) {
    emu.consoleCursorX = 0;
    emu.consoleCursorY++;
    if (emu.consoleCursorY >= SCREEN_ROWS) {
      scrollUp(cpu, emu, 1, 0x07, 0, 0, SCREEN_ROWS - 1, SCREEN_COLS - 1);
      emu.consoleCursorY = SCREEN_ROWS - 1;
    }
  }

  // Also update console buffer
  syncVideoMemory(emu);
}

/** Write a DOS DTA entry for FindFirst/FindNext results.
 *  DTA layout (43 bytes): offset 0x00-0x14=reserved, 0x15=attr, 0x16-0x17=time,
 *  0x18-0x19=date, 0x1A-0x1D=size, 0x1E-0x2A=filename (13 bytes, null-terminated) */
function writeDtaEntry(_cpu: CPU, emu: Emulator, entry: DirEntry): void {
  const dta = emu._dosDTA;
  if (!dta) return;
  const mem = emu.memory;
  // Clear DTA
  for (let i = 0; i < 43; i++) mem.writeU8(dta + i, 0);
  // Attribute byte at offset 0x15
  const FILE_ATTR_DIRECTORY = 0x10;
  const FILE_ATTR_ARCHIVE = 0x20;
  mem.writeU8(dta + 0x15, entry.isDir ? FILE_ATTR_DIRECTORY : FILE_ATTR_ARCHIVE);
  // Time at 0x16 (00:00:00)
  mem.writeU16(dta + 0x16, 0);
  // Date at 0x18 (2000-01-01 in DOS format)
  const DOS_DATE_2000 = ((2000 - 1980) << 9) | (1 << 5) | 1;
  mem.writeU16(dta + 0x18, DOS_DATE_2000);
  // File size at 0x1A (32-bit)
  mem.writeU32(dta + 0x1A, entry.size);
  // Filename at 0x1E (up to 12 chars + null, 8.3 format)
  const name = entry.name.toUpperCase().substring(0, 12);
  for (let i = 0; i < name.length; i++) {
    mem.writeU8(dta + 0x1E + i, name.charCodeAt(i));
  }
  mem.writeU8(dta + 0x1E + name.length, 0);
}

/**
 * Build DOS List of Lists (LoL) and MCB chain for INT 21h AH=52h.
 * MEM.EXE walks the MCB chain starting from LoL offset -2.
 */
function buildDosLoL(cpu: CPU, emu: Emulator): void {
  const mem = cpu.mem;

  // MCB chain was already set up by mz-loader.ts
  const MCB_FIRST_SEG = emu._dosMcbFirstSeg || 0x0060;

  // List of Lists structure
  // Allocate at a paragraph-aligned address above MCB chain
  // LoL has first MCB segment at offset -2 from the returned ES:BX
  // So we need: [word firstMCBseg] [LoL data...]
  const lolBase = ((emu.heapPtr + 0xF) & ~0xF);
  emu.heapPtr = lolBase + 128;
  // Zero it
  for (let i = 0; i < 128; i++) mem.writeU8(lolBase + i, 0);

  // Write first MCB segment at lolBase (this becomes offset -2 of LoL)
  mem.writeU16(lolBase, MCB_FIRST_SEG);

  // The returned pointer (ES:BX) points to lolBase+2
  // Key fields in LoL (offsets from ES:BX):
  // -2: first MCB segment (already written)
  // +0: pointer to first DPB (0 = none)
  // +4: pointer to first SFT (0 = none)
  // +22h: number of block devices
  // +24h: NUL device header
  const lolPtr = lolBase + 2;

  // DPB pointer = 0 (no drives)
  mem.writeU32(lolPtr + 0x00, 0xFFFFFFFF); // no DPB chain

  // SFT pointer
  mem.writeU32(lolPtr + 0x04, 0xFFFFFFFF);

  // Number of block devices at +0x20
  mem.writeU8(lolPtr + 0x20, 3); // C: D: E:

  // NUL device header at +0x22 (18 bytes)
  // Next pointer = FFFF:FFFF
  mem.writeU32(lolPtr + 0x22, 0xFFFFFFFF);
  // Attribute = 0x8004 (character device, NUL)
  mem.writeU16(lolPtr + 0x26, 0x8004);

  emu._dosLoLAddr = lolPtr;
}

/** INT 1Ah — BIOS time services */
function handleInt1A(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;
  switch (ah) {
    case 0x00: {
      // Get system timer tick count (18.2 ticks/sec since midnight)
      const ticks = emu.memory.readU32(0x46C);
      cpu.setReg16(ECX, (ticks >>> 16) & 0xFFFF); // CX = high word
      cpu.setReg16(EDX, ticks & 0xFFFF);           // DX = low word
      cpu.setReg8(EAX, 0); // AL = midnight flag (0 = no midnight rollover)
      return true;
    }
    case 0x02: {
      // Get real-time clock time → CH=hours(BCD), CL=minutes(BCD), DH=seconds(BCD)
      const now = new Date();
      const toBCD = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
      cpu.setReg8(5, toBCD(now.getHours()));   // CH (idx 5)
      cpu.setReg8(1, toBCD(now.getMinutes())); // CL (idx 1)
      cpu.setReg8(6, toBCD(now.getSeconds())); // DH (idx 6)
      cpu.reg[0] = cpu.reg[0] & ~CF;
      return true;
    }
    case 0x04: {
      // Get real-time clock date → CH=century(BCD), CL=year(BCD), DH=month(BCD), DL=day(BCD)
      const now = new Date();
      const toBCD = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
      const year = now.getFullYear();
      cpu.setReg8(5, toBCD(Math.floor(year / 100))); // CH
      cpu.setReg8(1, toBCD(year % 100));               // CL
      cpu.setReg8(6, toBCD(now.getMonth() + 1));       // DH
      cpu.setReg8(2, toBCD(now.getDate()));             // DL
      cpu.reg[0] = cpu.reg[0] & ~CF;
      return true;
    }
    default:
      return true; // ignore unknown subfunctions
  }
}

/** Sync video memory (B800:0000) to emu.consoleBuffer */
export function syncVideoMemory(emu: Emulator): void {
  const mem = emu.memory;
  for (let i = 0; i < SCREEN_COLS * SCREEN_ROWS; i++) {
    const ch = mem.readU8(VIDEO_MEM_BASE + i * 2);
    const attr = mem.readU8(VIDEO_MEM_BASE + i * 2 + 1);
    emu.consoleBuffer[i] = { char: ch, attr };
  }
  emu.onConsoleOutput?.();
}
