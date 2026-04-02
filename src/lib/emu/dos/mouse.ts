import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;

// INT 33h mouse event condition mask bits
const MOUSE_EVENT_MOVE     = 0x01;
const MOUSE_EVENT_LDOWN    = 0x02;
const MOUSE_EVENT_LUP      = 0x04;
const MOUSE_EVENT_RDOWN    = 0x08;
const MOUSE_EVENT_RUP      = 0x10;
const MOUSE_EVENT_MDOWN    = 0x20;
const MOUSE_EVENT_MUP      = 0x40;

/** DOS mouse driver state, stored on Emulator as `dosMouse` */
export interface DosMouseState {
  installed: boolean;
  x: number;           // virtual screen X (0..maxX)
  y: number;           // virtual screen Y (0..maxY)
  buttons: number;     // bit 0=left, bit 1=right, bit 2=middle
  maxX: number;        // horizontal range max (default 639)
  maxY: number;        // vertical range max (default 199 for mode 13h, etc.)
  minX: number;
  minY: number;
  cursorVisible: number; // hide counter: starts at -1 (hidden), show increments, hide decrements
  // Motion counters (mickeys) — reset on read
  mickeysX: number;
  mickeysY: number;
  // User callback
  callbackMask: number;  // event condition mask
  callbackSeg: number;
  callbackOff: number;
  // Pending callback events
  pendingCallbackMask: number;
  // Button press/release counters
  pressCount: [number, number, number];   // left, right, middle
  releaseCount: [number, number, number];
  pressX: [number, number, number];
  pressY: [number, number, number];
  releaseX: [number, number, number];
  releaseY: [number, number, number];
  // Sensitivity
  sensX: number;  // mickeys per 8 pixels (default 8)
  sensY: number;
  doubleThreshold: number;
  // Last browser mapped position for delta computation (-1 = uninitialized)
  lastBrowserX: number;
  lastBrowserY: number;
}

export function createDosMouseState(): DosMouseState {
  return {
    installed: false,
    x: 0, y: 0,
    buttons: 0,
    maxX: 639, maxY: 199,
    minX: 0, minY: 0,
    cursorVisible: -1,
    mickeysX: 0, mickeysY: 0,
    callbackMask: 0, callbackSeg: 0, callbackOff: 0,
    pendingCallbackMask: 0,
    pressCount: [0, 0, 0],
    releaseCount: [0, 0, 0],
    pressX: [0, 0, 0],
    pressY: [0, 0, 0],
    releaseX: [0, 0, 0],
    releaseY: [0, 0, 0],
    sensX: 8, sensY: 16,
    doubleThreshold: 64,
    lastBrowserX: -1, lastBrowserY: -1,
  };
}

/**
 * Inject a browser mouse event into the DOS mouse state.
 * Called from ConsoleView when the user interacts with the DOS window.
 * @param emu - Emulator instance
 * @param px - pixel X in display space (0..displayW-1)
 * @param py - pixel Y in display space (0..displayH-1)
 * @param displayW - display width in pixels (e.g. 640)
 * @param displayH - display height in pixels (e.g. 480)
 * @param buttons - browser buttons bitmask (bit0=left, bit1=right, bit2=middle)
 * @param type - 'move' | 'down' | 'up'
 */
export function injectDosMouseEvent(
  emu: Emulator,
  px: number, py: number,
  displayW: number, displayH: number,
  buttons: number, type: 'move' | 'down' | 'up',
): void {
  const m = emu.dosMouse;
  if (!m.installed) return;

  // Map browser pixel coordinates to virtual coordinate scale
  const mappedX = px * m.maxX / (displayW - 1);
  const mappedY = py * m.maxY / (displayH - 1);

  let eventMask = 0;

  // First event: initialize baseline, place cursor at browser position
  if (m.lastBrowserX < 0) {
    m.lastBrowserX = mappedX;
    m.lastBrowserY = mappedY;
    m.x = Math.max(m.minX, Math.min(m.maxX, Math.round(mappedX)));
    m.y = Math.max(m.minY, Math.min(m.maxY, Math.round(mappedY)));
  }

  // Compute delta from last browser position, apply to m.x/m.y
  // This way AX=4 (set position) is respected — we add movement on top of it
  const dx = mappedX - m.lastBrowserX;
  const dy = mappedY - m.lastBrowserY;
  m.lastBrowserX = mappedX;
  m.lastBrowserY = mappedY;

  if (dx !== 0 || dy !== 0) {
    const newX = Math.max(m.minX, Math.min(m.maxX, Math.round(m.x + dx)));
    const newY = Math.max(m.minY, Math.min(m.maxY, Math.round(m.y + dy)));
    m.mickeysX += (newX - m.x);
    m.mickeysY += (newY - m.y);
    m.x = newX;
    m.y = newY;
    eventMask |= MOUSE_EVENT_MOVE;
  }

  applyButtonsAndCallback(emu, m, eventMask, buttons);
}


/** Shared: process button changes and queue callback */
function applyButtonsAndCallback(emu: Emulator, m: DosMouseState, eventMask: number, buttons: number): void {
  // Convert browser buttons (bit0=L, bit1=R, bit2=M) to DOS (bit0=L, bit1=R, bit2=M)
  const dosButtons = ((buttons & 1) ? 1 : 0) | ((buttons & 2) ? 2 : 0) | ((buttons & 4) ? 4 : 0);
  const changed = dosButtons ^ m.buttons;

  if (changed & 1) { // left
    if (dosButtons & 1) { eventMask |= MOUSE_EVENT_LDOWN; m.pressCount[0]++; m.pressX[0] = m.x; m.pressY[0] = m.y; }
    else { eventMask |= MOUSE_EVENT_LUP; m.releaseCount[0]++; m.releaseX[0] = m.x; m.releaseY[0] = m.y; }
  }
  if (changed & 2) { // right
    if (dosButtons & 2) { eventMask |= MOUSE_EVENT_RDOWN; m.pressCount[1]++; m.pressX[1] = m.x; m.pressY[1] = m.y; }
    else { eventMask |= MOUSE_EVENT_RUP; m.releaseCount[1]++; m.releaseX[1] = m.x; m.releaseY[1] = m.y; }
  }
  if (changed & 4) { // middle
    if (dosButtons & 4) { eventMask |= MOUSE_EVENT_MDOWN; m.pressCount[2]++; m.pressX[2] = m.x; m.pressY[2] = m.y; }
    else { eventMask |= MOUSE_EVENT_MUP; m.releaseCount[2]++; m.releaseX[2] = m.x; m.releaseY[2] = m.y; }
  }
  m.buttons = dosButtons;

  // Queue callback if mask matches
  if (eventMask && m.callbackMask && (eventMask & m.callbackMask)) {
    m.pendingCallbackMask |= (eventMask & m.callbackMask);
    // Wake CPU if halted/waiting
    if ((emu.waitingForMessage || emu._dosHalted) && emu.running && !emu.halted) {
      requestAnimationFrame(emu.tick);
    }
  }
}

/** Handle INT 33h — DOS Mouse Services */
export function handleInt33(cpu: CPU, emu: Emulator): boolean {
  const m = emu.dosMouse;
  const ax = cpu.getReg16(EAX);

  switch (ax) {
    case 0x0000: { // Reset/detect
      // Reset state
      m.x = 0; m.y = 0; m.buttons = 0;
      m.cursorVisible = -1;
      m.minX = 0; m.minY = 0;
      m.maxX = 639;
      // Default maxY based on video mode
      m.maxY = emu.isGraphicsMode ? (emu.videoMode === 0x13 ? 199 : 479) : 199;
      m.mickeysX = 0; m.mickeysY = 0;
      m.callbackMask = 0; m.callbackSeg = 0; m.callbackOff = 0;
      m.pendingCallbackMask = 0;
      m.pressCount = [0, 0, 0]; m.releaseCount = [0, 0, 0];
      m.pressX = [0, 0, 0]; m.pressY = [0, 0, 0];
      m.releaseX = [0, 0, 0]; m.releaseY = [0, 0, 0];
      m.sensX = 8; m.sensY = 16; m.doubleThreshold = 64;
      m.lastBrowserX = -1; m.lastBrowserY = -1;
      m.installed = true;
      cpu.setReg16(EAX, 0xFFFF); // mouse installed
      cpu.setReg16(EBX, 3);       // 3 buttons
      return true;
    }

    case 0x0001: // Show cursor
      m.cursorVisible++;
      return true;

    case 0x0002: // Hide cursor
      m.cursorVisible--;
      return true;

    case 0x0003: // Get position and button status
      cpu.setReg16(EBX, m.buttons);
      cpu.setReg16(ECX, m.x);
      cpu.setReg16(EDX, m.y);
      return true;

    case 0x0004: // Set position
      m.x = Math.max(m.minX, Math.min(m.maxX, cpu.getReg16(ECX)));
      m.y = Math.max(m.minY, Math.min(m.maxY, cpu.getReg16(EDX)));
      return true;

    case 0x0005: { // Get button press info
      const btn = cpu.getReg16(EBX) & 3;
      cpu.setReg16(EAX, m.buttons);
      cpu.setReg16(EBX, m.pressCount[btn]);
      cpu.setReg16(ECX, m.pressX[btn]);
      cpu.setReg16(EDX, m.pressY[btn]);
      m.pressCount[btn] = 0;
      return true;
    }

    case 0x0006: { // Get button release info
      const btn = cpu.getReg16(EBX) & 3;
      cpu.setReg16(EAX, m.buttons);
      cpu.setReg16(EBX, m.releaseCount[btn]);
      cpu.setReg16(ECX, m.releaseX[btn]);
      cpu.setReg16(EDX, m.releaseY[btn]);
      m.releaseCount[btn] = 0;
      return true;
    }

    case 0x0007: // Set horizontal range
      m.minX = cpu.getReg16(ECX);
      m.maxX = cpu.getReg16(EDX);
      m.x = Math.max(m.minX, Math.min(m.maxX, m.x));
      return true;

    case 0x0008: // Set vertical range
      m.minY = cpu.getReg16(ECX);
      m.maxY = cpu.getReg16(EDX);
      m.y = Math.max(m.minY, Math.min(m.maxY, m.y));
      return true;

    case 0x0009: // Set graphics cursor shape (stub — no hardware cursor)
      return true;

    case 0x000A: // Set text cursor type (stub)
      return true;

    case 0x000B: // Read motion counters (mickeys)
      cpu.setReg16(ECX, m.mickeysX & 0xFFFF);
      cpu.setReg16(EDX, m.mickeysY & 0xFFFF);
      m.mickeysX = 0;
      m.mickeysY = 0;
      return true;

    case 0x000C: { // Set user callback
      m.callbackMask = cpu.getReg16(ECX);
      m.callbackSeg = cpu.es;
      m.callbackOff = cpu.getReg16(EDX);
      return true;
    }

    case 0x000F: // Set mickey/pixel ratio
      m.sensX = cpu.getReg16(ECX) || 8;
      m.sensY = cpu.getReg16(EDX) || 16;
      return true;

    case 0x0010: // Set exclusive area (stub — ignore)
      return true;

    case 0x0013: // Set double-speed threshold
      m.doubleThreshold = cpu.getReg16(EDX);
      return true;

    case 0x0014: { // Swap user callback (exchange)
      const oldMask = m.callbackMask;
      const oldSeg = m.callbackSeg;
      const oldOff = m.callbackOff;
      m.callbackMask = cpu.getReg16(ECX);
      m.callbackSeg = cpu.es;
      m.callbackOff = cpu.getReg16(EDX);
      cpu.setReg16(ECX, oldMask);
      cpu.es = oldSeg;
      cpu.setReg16(EDX, oldOff);
      return true;
    }

    case 0x0015: // Get driver storage requirements
      cpu.setReg16(EBX, 0); // 0 bytes needed (we keep state in JS)
      return true;

    case 0x001A: // Set sensitivity
      m.sensX = cpu.getReg16(EBX) || 8;
      m.sensY = cpu.getReg16(ECX) || 16;
      m.doubleThreshold = cpu.getReg16(EDX);
      return true;

    case 0x001B: // Get sensitivity
      cpu.setReg16(EBX, m.sensX);
      cpu.setReg16(ECX, m.sensY);
      cpu.setReg16(EDX, m.doubleThreshold);
      return true;

    case 0x001F: // Disable mouse driver
      cpu.setReg16(EAX, 0x001F);
      cpu.es = 0;
      cpu.setReg16(EBX, 0);
      return true;

    case 0x0020: // Enable mouse driver
      return true;

    case 0x0021: // Software reset
      cpu.setReg16(EAX, 0xFFFF);
      cpu.setReg16(EBX, 3);
      return true;

    case 0x0024: // Get driver info
      cpu.setReg16(EBX, 0x0800); // version 8.0
      cpu.setReg8(ECX, 2);       // IRQ type: PS/2
      cpu.setReg8(EDX, 0);       // no IRQ
      return true;

    default:
      // Unknown subfunctions — silently ignore
      return true;
  }
}

/**
 * Dispatch pending mouse callback (called from tick loop in emu-exec.ts).
 * Returns true if a callback was dispatched (caller should continue tick loop).
 *
 * The real DOS mouse driver saves all registers before calling the user callback
 * and restores them after RETF. We emulate this by pushing all regs + DS/ES
 * onto the stack, then a small trampoline that pops them after RETF.
 * Since we can't inject code, we save registers in JS and restore on RETF detect.
 */
export function dispatchMouseCallback(emu: Emulator): boolean {
  const m = emu.dosMouse;
  if (!m.pendingCallbackMask || !m.callbackMask || !m.callbackSeg) return false;
  // Don't dispatch if a hardware interrupt handler or another callback is active
  if (emu._hwIntSavedSP >= 0) return false;
  if (emu._mouseCallbackSavedSP >= 0) return false;

  const mask = m.pendingCallbackMask;
  m.pendingCallbackMask = 0;

  // Real mouse drivers (CuteMouse etc.) save ALL registers + flags before
  // calling the user callback and restore after RETF. We do the same in JS.
  emu._mouseCallbackSavedRegs = {
    regs: Int32Array.from(emu.cpu.reg), // all 8 GPRs (EAX-EDI)
    ds: emu.cpu.ds, es: emu.cpu.es,
    flags: emu.cpu.getFlags(), // materializes lazy flags
  };

  const seg = m.callbackSeg;
  const off = m.callbackOff;

  // Push far return address for RETF
  const returnIP = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) & 0xFFFF;
  emu._mouseCallbackSavedSP = emu.cpu.reg[4] & 0xFFFF;
  emu.cpu.push16(emu.cpu.cs);
  emu.cpu.push16(returnIP);

  // Set callback parameters per INT 33h convention:
  //   AX = event condition mask, BX = button state,
  //   CX = cursor X, DX = cursor Y, SI = mickeysX, DI = mickeysY
  emu.cpu.setReg16(EAX, mask);
  emu.cpu.setReg16(EBX, m.buttons);
  emu.cpu.setReg16(ECX, m.x);
  emu.cpu.setReg16(EDX, m.y);
  emu.cpu.setReg16(ESI, m.mickeysX & 0xFFFF);
  emu.cpu.setReg16(EDI, m.mickeysY & 0xFFFF);

  // Jump to callback
  emu.cpu.cs = seg;
  emu.cpu.eip = emu.cpu.segBase(seg) + off;

  return true;
}
