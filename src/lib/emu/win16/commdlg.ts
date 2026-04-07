import type { Emulator } from '../emulator';
import type { WindowInfo } from '../win32/user32/types';
import { emuCompleteThunk16 } from '../emu-exec';

// Win16 COMMDLG module — common dialog stubs

export function registerWin16Commdlg(emu: Emulator): void {
  const commdlg = emu.registerModule16('COMMDLG');

  // ─────────────────────────────────────────────────────────────────────────
  // Ordinal 1: GetOpenFileName(lpOfn) — 4 bytes (segptr)
  // Win16 OPENFILENAME struct offsets:
  //   +24: lpstrFile (4 bytes, far ptr to buffer)
  //   +28: nMaxFile  (4 bytes, DWORD)
  // ─────────────────────────────────────────────────────────────────────────
  commdlg.register('GetOpenFileName', 4, () => {
    const lpOfnRaw = emu.readPascalArgs16([4])[0];
    const lpOfn = emu.resolveFarPtr(lpOfnRaw);
    if (!lpOfn) return 0;

    // Read lpstrFile far ptr and nMaxFile from OPENFILENAME16
    const lpstrFileRaw = emu.memory.readU32(lpOfn + 24);
    const lpstrFile = emu.resolveFarPtr(lpstrFileRaw);
    const nMaxFile = emu.memory.readU32(lpOfn + 28);

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'file-open',
      onResult: (result) => {
        emu.waitingForMessage = false;
        if (result) {
          // If imported file with data, store in externalFiles
          if (result.data && result.path.toUpperCase().startsWith('Z:\\')) {
            const data = new Uint8Array(result.data);
            emu.fs.externalFiles.set(result.path.toUpperCase(), {
              data, name: result.path.substring(3),
            });
          }
          // Write path into lpstrFile buffer
          if (lpstrFile && nMaxFile > 0) {
            const toWrite = result.path.substring(0, nMaxFile - 1);
            for (let i = 0; i < toWrite.length; i++) {
              emu.memory.writeU8(lpstrFile + i, toWrite.charCodeAt(i) & 0xFF);
            }
            emu.memory.writeU8(lpstrFile + toWrite.length, 0);
          }
          emuCompleteThunk16(emu, 1, stackBytes);
        } else {
          emuCompleteThunk16(emu, 0, stackBytes);
        }
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 1);

  // ─────────────────────────────────────────────────────────────────────────
  // Ordinal 2: GetSaveFileName(lpOfn) — 4 bytes (segptr)
  // ─────────────────────────────────────────────────────────────────────────
  commdlg.register('GetSaveFileName', 4, () => {
    const lpOfnRaw = emu.readPascalArgs16([4])[0];
    const lpOfn = emu.resolveFarPtr(lpOfnRaw);
    if (!lpOfn) return 0;

    // Read lpstrFile far ptr (current filename)
    const lpstrFileRaw = emu.memory.readU32(lpOfn + 24);
    const lpstrFile = emu.resolveFarPtr(lpstrFileRaw);
    const nMaxFile = emu.memory.readU32(lpOfn + 28);
    const currentName = lpstrFile ? emu.memory.readCString(lpstrFile) : '';

    // Get the default filename (strip path)
    let defaultName = currentName;
    const lastSlash = Math.max(currentName.lastIndexOf('\\'), currentName.lastIndexOf('/'));
    if (lastSlash >= 0) defaultName = currentName.substring(lastSlash + 1);
    if (!defaultName) defaultName = 'untitled.txt';

    // Get text content from the focused EDIT control
    let content = '';
    const focusHwnd = emu.focusedWindow;
    if (focusHwnd) {
      const fw = emu.handles.get<WindowInfo>(focusHwnd);
      if (fw?.classInfo?.className?.toUpperCase() === 'EDIT') {
        content = fw.title || '';
      }
    }
    // Fallback: try to find any EDIT control
    if (!content) {
      for (const [, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
        if (wnd?.classInfo?.className?.toUpperCase() === 'EDIT' && wnd.title) {
          content = wnd.title;
          break;
        }
      }
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'file-save',
      defaultName: defaultName || undefined,
      onResult: (result) => {
        emu.waitingForMessage = false;
        if (result) {
          // Write chosen path into lpstrFile buffer
          if (lpstrFile && nMaxFile > 0) {
            const toWrite = result.path.substring(0, nMaxFile - 1);
            for (let i = 0; i < toWrite.length; i++) {
              emu.memory.writeU8(lpstrFile + i, toWrite.charCodeAt(i) & 0xFF);
            }
            emu.memory.writeU8(lpstrFile + toWrite.length, 0);
          }
          emuCompleteThunk16(emu, 1, stackBytes);
        } else {
          emuCompleteThunk16(emu, 0, stackBytes);
        }
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 2);

  // Ordinal 5: ChooseColor(lpCc) — 4 bytes (segptr)
  commdlg.register('ChooseColor', 4, () => 0, 5);

  // Ordinal 6: FileOpenDlgProc — internal dialog proc, stub
  commdlg.register('FileOpenDlgProc', 0, () => 0, 6);

  // Ordinal 7: FileSaveDlgProc — internal dialog proc, stub
  commdlg.register('FileSaveDlgProc', 0, () => 0, 7);

  // ─────────────────────────────────────────────────────────────────────────
  // Ordinal 11: FindText(lpFr) — 4 bytes (segptr)
  // Win16 FINDREPLACE struct:
  //   +0:  lStructSize (4)
  //   +4:  hwndOwner (2)
  //   +6:  hInstance (2)
  //   +8:  Flags (4)
  //   +12: lpstrFindWhat (4, far ptr)
  //   +16: lpstrReplaceWith (4, far ptr)
  //   +20: wFindWhatLen (2)
  //   +22: wReplaceWithLen (2)
  // ─────────────────────────────────────────────────────────────────────────
  commdlg.register('FindText', 4, () => {
    const lpFrRaw = emu.readPascalArgs16([4])[0];
    const lpFr = emu.resolveFarPtr(lpFrRaw);
    if (!lpFr) return 0;

    // Find the EDIT control to search in
    let editHwnd = emu.focusedWindow;
    if (editHwnd) {
      const fw = emu.handles.get<WindowInfo>(editHwnd);
      if (!fw || fw.classInfo?.className?.toUpperCase() !== 'EDIT') editHwnd = 0;
    }
    if (!editHwnd) {
      for (const [handle, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
        if (wnd?.classInfo?.className?.toUpperCase() === 'EDIT') {
          editHwnd = handle;
          break;
        }
      }
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'find',
      editHwnd,
      onClose: () => {
        emu.waitingForMessage = false;
        emuCompleteThunk16(emu, 0, stackBytes);
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 11);

  // Ordinal 12: ReplaceText(lpFr) — 4 bytes (segptr)
  commdlg.register('ReplaceText', 4, () => 0, 12);

  // Ordinal 13: FindTextDlgProc — internal dialog proc, stub
  commdlg.register('FindTextDlgProc', 0, () => 0, 13);

  // Ordinal 15: ChooseFont(lpCf) — 4 bytes (segptr)
  commdlg.register('ChooseFont', 4, () => 0, 15);

  // Ordinal 20: PrintDlg(lpPd) — 4 bytes (segptr)
  // Allocate a default DEVMODE16 so callers can read paper size
  commdlg.register('PrintDlg', 4, () => {
    const [lpPdRaw] = emu.readPascalArgs16([4]);
    const lpPd = emu.resolveFarPtr(lpPdRaw);
    if (!lpPd) return 0;

    // Allocate DEVMODE16 on a 64KB-aligned block (acts as its own segment/selector)
    const DEVMODE_SIZE = 68;
    const addr = emu.allocHeap64K(DEVMODE_SIZE);
    const selector = addr >>> 16;
    // Register in segBases so GlobalLock can resolve it, and in segLimits for LSL
    emu.cpu.segBases.set(selector, addr);
    emu.cpu.segLimits.set(selector, DEVMODE_SIZE - 1);

    // dmDeviceName (32 bytes at offset 0)
    const name = 'Default Printer';
    for (let i = 0; i < name.length; i++) emu.memory.writeU8(addr + i, name.charCodeAt(i));

    const DM_ORIENTATION = 0x0001;
    const DM_PAPERSIZE = 0x0002;
    const DM_PAPERLENGTH = 0x0004;
    const DM_PAPERWIDTH = 0x0008;
    emu.memory.writeU16(addr + 32, 0x030A); // dmSpecVersion
    emu.memory.writeU16(addr + 36, DEVMODE_SIZE); // dmSize
    emu.memory.writeU16(addr + 40, DM_ORIENTATION | DM_PAPERSIZE | DM_PAPERLENGTH | DM_PAPERWIDTH); // dmFields
    emu.memory.writeU16(addr + 42, 1);    // dmOrientation = PORTRAIT
    emu.memory.writeU16(addr + 44, 1);    // dmPaperSize = DMPAPER_LETTER
    emu.memory.writeU16(addr + 46, 2794); // dmPaperLength = 279.4mm (11")
    emu.memory.writeU16(addr + 48, 2159); // dmPaperWidth = 215.9mm (8.5")
    emu.memory.writeU16(addr + 56, 300);  // dmPrintQuality = 300 DPI

    // Write hDevMode into PRINTDLG16 at offset +6
    emu.memory.writeU16(lpPd + 6, selector);

    // Write a dummy hDC at offset +10
    const hDC = emu.getWindowDC(emu.mainWindow || 0);
    emu.memory.writeU16(lpPd + 10, hDC);

    return 1; // success
  }, 20);

  // Ordinal 26: CommDlgExtendedError() — 0 bytes
  commdlg.register('CommDlgExtendedError', 0, () => 0, 26);

  // Ordinal 27: GetFileTitle(lpszFile, lpszTitle, cbBuf) — 10 bytes (4+4+2)
  commdlg.register('GetFileTitle', 10, () => 0, 27);

  // Ordinal 28: WEP(word) — DLL exit procedure
  commdlg.register('WEP', 2, () => 1, 28);
}
