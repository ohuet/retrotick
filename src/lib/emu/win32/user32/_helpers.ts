import type { Emulator } from '../../emulator';

import type { WinMsg } from '../../emulator';
import type { WindowInfo } from './types';
import { WS_CAPTION, WS_DLGFRAME, WS_BORDER, WS_THICKFRAME, WM_GETMINMAXINFO } from '../types';

/**
 * Called after a window's size changes. Windows invalidates the affected area;
 * for the CS_HREDRAW|CS_VREDRAW classes that MFC frames/views use, the WHOLE
 * client repaints. We invalidate the window's full new client so a stale,
 * smaller invalidRect captured at the previous size can't leave part of the
 * client unpainted (the "cut rectangle" symptom).
 */
export function invalidateForResize(emu: Emulator, wnd: WindowInfo): void {
  const cs = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
  wnd.needsPaint = true;
  wnd.needsErase = true;
  wnd.invalidRect = { l: 0, t: 0, r: cs.cw, b: cs.ch };
}

// Helper: write a WinMsg into a MSG struct at pMsg, filling pt from lParam for mouse messages
export function writeMsgStruct(emu: Emulator, pMsg: number, msg: WinMsg): void {
  emu.memory.writeU32(pMsg, msg.hwnd);
  emu.memory.writeU32(pMsg + 4, msg.message);
  emu.memory.writeU32(pMsg + 8, msg.wParam);
  emu.memory.writeU32(pMsg + 12, msg.lParam);
  emu.memory.writeU32(pMsg + 16, (Date.now() & 0xFFFFFFFF) >>> 0); // time
  // pt: for mouse messages (0x200..0x20d), convert client coords from lParam to screen coords
  if (msg.message >= 0x200 && msg.message <= 0x20d) {
    const clientX = (msg.lParam & 0xFFFF) << 16 >> 16;   // sign-extend
    const clientY = (msg.lParam >>> 16) << 16 >> 16;
    const origin = clientToScreen(emu, msg.hwnd);
    emu.memory.writeU32(pMsg + 20, ((origin.x + clientX) | 0) >>> 0);  // pt.x (screen)
    emu.memory.writeU32(pMsg + 24, ((origin.y + clientY) | 0) >>> 0);  // pt.y (screen)
  } else {
    emu.memory.writeU32(pMsg + 20, 0);
    emu.memory.writeU32(pMsg + 24, 0);
  }
}

// Compute the screen-coordinate origin of a window's client area
function clientToScreen(emu: Emulator, hwnd: number): { x: number; y: number } {
  const wnd = hwnd ? emu.handles.get<WindowInfo>(hwnd) : null;
  if (!wnd) return { x: 0, y: 0 };
  const WS_CHILD = 0x40000000;
  if (wnd.style & WS_CHILD) {
    const parentOrigin = clientToScreen(emu, wnd.parent || 0);
    return { x: parentOrigin.x + wnd.x, y: parentOrigin.y + wnd.y };
  }
  // Top-level: account for border and caption
  const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height);
  const bw = (wnd.width - cw) / 2;
  const topH = wnd.height - ch - bw;
  return { x: wnd.x + bw, y: wnd.y + topH };
}

// Compute client area from total window dimensions
export function getNonClientMetrics(style: number, hasMenu: boolean, win16 = false) {
  let bw = 0, captionH = 0, menuH = 0;
  if (win16) {
    // Windows 3.1: thinner chrome — 1px border, 20px caption, 20px menu
    if (style & (WS_THICKFRAME | WS_DLGFRAME | WS_BORDER)) bw = 1;
    if ((style & WS_CAPTION) === WS_CAPTION) captionH = 20;
    if (hasMenu) menuH = 20;
  } else {
    // Win32: standard metrics
    if (style & WS_THICKFRAME) bw = 4;        // SM_CXSIZEFRAME
    else if (style & WS_DLGFRAME) bw = 3;     // SM_CXFIXEDFRAME
    else if (style & WS_BORDER) bw = 1;       // SM_CXBORDER
    if ((style & WS_CAPTION) === WS_CAPTION) captionH = 18; // SM_CYCAPTION
    if (hasMenu) menuH = 19; // SM_CYMENU
  }
  return { bw, captionH, menuH };
}

/**
 * Send WM_GETMINMAXINFO to query min track size, then clamp w/h.
 * Updates wnd.minTrackWidth/minTrackHeight as a side effect.
 * Returns clamped { w, h }.
 */
export function clampToMinTrackSize(emu: Emulator, hwnd: number, wnd: WindowInfo, w: number, h: number): { w: number; h: number } {
  if (wnd.wndProc) {
    // MINMAXINFO is 40 bytes: 5 POINTs (ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize)
    const pInfo = emu.allocHeap(40);
    // Zero-init
    for (let i = 0; i < 40; i += 4) emu.memory.writeU32(pInfo + i, 0);
    emu.callWndProc(wnd.wndProc, hwnd, WM_GETMINMAXINFO, 0, pInfo);
    const minW = emu.memory.readU32(pInfo + 24); // ptMinTrackSize.x
    const minH = emu.memory.readU32(pInfo + 28); // ptMinTrackSize.y
    if (minW > 0) wnd.minTrackWidth = minW;
    if (minH > 0) wnd.minTrackHeight = minH;
    // no freeHeap — 40 bytes is negligible
  }
  const aw = (wnd.minTrackWidth && w < wnd.minTrackWidth) ? wnd.minTrackWidth : w;
  const ah = (wnd.minTrackHeight && h < wnd.minTrackHeight) ? wnd.minTrackHeight : h;
  if (aw !== w || ah !== h) {
    console.log(`[MinTrackSize] hwnd=0x${hwnd.toString(16)} clamped: ${w}x${h} -> ${aw}x${ah} (min=${wnd.minTrackWidth}x${wnd.minTrackHeight})`);
  }
  return { w: aw, h: ah };
}

export function getClientSize(style: number, hasMenu: boolean, totalW: number, totalH: number, win16 = false) {
  const { bw, captionH, menuH } = getNonClientMetrics(style, hasMenu, win16);
  return {
    cw: Math.max(1, totalW - 2 * bw),
    ch: Math.max(1, totalH - 2 * bw - captionH - menuH),
  };
}
