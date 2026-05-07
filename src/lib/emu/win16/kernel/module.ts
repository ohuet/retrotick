import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';
import { registerLoadedNeDll, NE_BUILTIN_MODULES } from '../../ne-dll-register';
import { getSyncFileData } from '../../dos/file';
import type { LoadedNE } from '../../ne-loader';

/** Invoke a runtime-loaded NE DLL's LibEntry / LibMain. The standard LIBENTRY
 *  stub expects DI=hInstance, CX=heapSize, DS=autoDataSeg, ES:SI=cmdLine. */
function callDllEntry(emu: Emulator, dll: LoadedNE): void {
  if (!dll.entryPoint || !emu.ne) return;
  const savedDS = emu.cpu.ds;
  const savedES = emu.cpu.es;
  const savedECX = emu.cpu.reg[1];
  const savedEDI = emu.cpu.reg[7];
  const savedESI = emu.cpu.reg[6];
  const origDataSel = emu.ne.dataSegSelector;

  emu.cpu.ds = dll.dataSegSelector;
  emu.cpu.es = emu.ne.dataSegSelector;
  emu.cpu.reg[1] = (emu.cpu.reg[1] & 0xFFFF0000) | (dll.heapSize & 0xFFFF);
  emu.cpu.reg[7] = (emu.cpu.reg[7] & 0xFFFF0000) | (dll.dataSegSelector & 0xFFFF);
  emu.cpu.reg[6] = (emu.cpu.reg[6] & 0xFFFF0000) | 0;

  emu.ne.dataSegSelector = dll.dataSegSelector;
  emu.callWndProc16(dll.entryPoint, 0, 0, 0, 0);
  emu.ne.dataSegSelector = origDataSel;

  if (emu.cpu.halted) {
    console.warn(`[NE DLL] Runtime LibMain halted CPU — clearing halt`);
    emu.cpu.halted = false;
    emu.cpu.haltReason = '';
  }

  emu.cpu.ds = savedDS;
  emu.cpu.es = savedES;
  emu.cpu.reg[1] = savedECX;
  emu.cpu.reg[7] = savedEDI;
  emu.cpu.reg[6] = savedESI;
}

export function registerKernelModule(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // --- Ordinal 27: GetModuleName(word ptr word) — 8 bytes (word+ptr+word) ---
  kernel.register('GetModuleName', 8, () => 0, 27);

  // --- Ordinal 45: LoadModule(str ptr) — 8 bytes (long+long) ---
  kernel.register('LoadModule', 8, () => 2, 45);

  // --- Ordinal 46: FreeModule(word) — 2 bytes ---
  kernel.register('FreeModule', 2, () => 1, 46);

  // --- Ordinal 47: GetModuleHandle(lpModuleName_ptr) — 4 bytes (segstr) ---
  kernel.register('GetModuleHandle', 4, () => {
    const lpName = emu.readArg16DWord(0);
    if (!lpName) return 0;
    const addr = emu.resolveFarPtr(lpName);
    const name = addr ? emu.memory.readCString(addr).toUpperCase() : '';
    // Check known modules
    const handle = state.moduleHandles.get(name);
    if (handle !== undefined) return handle;
    // Strip extension and try again
    const baseName = name.replace(/\.\w+$/, '');
    const h2 = state.moduleHandles.get(baseName);
    if (h2 !== undefined) return h2;
    // Return fake handle for KERNEL, USER, GDI etc.
    if (baseName === 'KERNEL' || baseName === 'USER' || baseName === 'GDI') return 1;
    return 0;
  }, 47);

  // --- Ordinal 48: GetModuleUsage(hModule) — 2 bytes (word) ---
  kernel.register('GetModuleUsage', 2, () => 1, 48);

  // --- Ordinal 49: GetModuleFileName(hModule, lpFilename, nSize) — 8 bytes (word+ptr+s_word) ---
  kernel.register('GetModuleFileName', 8, () => {
    const [hModule, lpFilename, nSize] = emu.readPascalArgs16([2, 4, 2]);
    const name = emu.exePath;
    const buf = emu.resolveFarPtr(lpFilename);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(name.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(buf + i, name.charCodeAt(i));
      }
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  }, 49);

  // --- Ordinal 50: GetProcAddress(hModule, lpProcName_str) — 6 bytes (word+dword) ---
  // Returns: far pointer (selector:offset packed as DWORD) to the export, or 0.
  kernel.register('GetProcAddress', 6, () => {
    const [hModule, lpProcName] = emu.readPascalArgs16([2, 4]);
    const seg = (lpProcName >>> 16) & 0xFFFF;
    const off = lpProcName & 0xFFFF;
    let name = '';
    let ordinal = 0;
    if (seg === 0) {
      ordinal = off; // MAKEINTRESOURCE-style numeric ordinal
    } else {
      name = emu.memory.readCString(emu.resolveFarPtr(lpProcName));
    }

    const dll = state.loadedDlls.get(hModule);
    if (!dll) return 0;

    if (ordinal === 0 && name) {
      const r = dll.nameToOrdinal.get(name.toUpperCase());
      if (r === undefined) return 0;
      ordinal = r;
    }
    const entry = dll.entryPoints.get(ordinal);
    if (!entry) return 0;
    const segInfo = dll.segments[entry.seg - 1];
    if (!segInfo) return 0;
    // Far pointer: high word = selector, low word = offset
    return ((segInfo.selector & 0xFFFF) << 16) | (entry.offset & 0xFFFF);
  }, 50);

  // --- Ordinal 51: MakeProcInstance(lpProc_segptr, hInstance) — 6 bytes (segptr+word) ---
  kernel.register('MakeProcInstance', 6, () => {
    const [lpProc] = emu.readPascalArgs16([4, 2]);
    return lpProc;
  }, 51);

  // --- Ordinal 52: FreeProcInstance(lpProc_segptr) — 4 bytes (segptr) ---
  kernel.register('FreeProcInstance', 4, () => 0, 52);

  // --- Ordinal 53: CallProcInstance — 4 bytes, return arg ---
  kernel.register('CallProcInstance', 4, () => emu.readArg16DWord(0), 53);

  // --- Ordinal 54: GetInstanceData(hInstance, pData, nCount) — 6 bytes (word+word+word) ---
  kernel.register('GetInstanceData', 6, () => 0, 54);

  // --- Ordinal 93: GetCodeHandle(lpProc) — 4 bytes (segptr) ---
  kernel.register('GetCodeHandle', 4, () => {
    const lpProc = emu.readArg16DWord(0);
    return (lpProc >>> 16) & 0xFFFF;
  }, 93);

  // --- Ordinal 94: DefineHandleTable(wOffset) — 2 bytes (word) ---
  kernel.register('DefineHandleTable', 2, () => 1, 94);

  // --- Ordinal 95: LoadLibrary(lpLibFileName) — 4 bytes (str) ---
  // Returns: hInstance (>= 32 on success, < 32 = error code).
  kernel.register('LoadLibrary', 4, () => {
    const lpLibFileName = emu.readArg16DWord(0);
    const name = lpLibFileName ? emu.memory.readCString(emu.resolveFarPtr(lpLibFileName)) : '';
    if (!name) return 2; // ERROR_FILE_NOT_FOUND

    // Module name = base filename stripped of extension, uppercase
    const baseName = name.replace(/.*[\\\/]/, '').replace(/\.\w+$/, '').toUpperCase();

    // Already loaded? Return existing handle.
    const existingHandle = state.moduleHandles.get(baseName);
    if (existingHandle !== undefined && existingHandle !== 0) return existingHandle;

    // Built-in module → return synthetic handle without loading.
    if (NE_BUILTIN_MODULES.has(baseName)) {
      const handle = state.nextModuleHandle++;
      state.moduleHandles.set(baseName, handle);
      return handle;
    }

    // Locate the file. Win16 LoadLibrary searches: as-given, exe dir, system dir, etc.
    // additionalFiles is always synchronous; check it first so we never need to take
    // the async (IDB-fetch) path when the buffer is already in memory.
    const bareTarget = name.replace(/.*[\\\/]/, '').toLowerCase();
    let bareBuf: ArrayBuffer | undefined;
    for (const [key, data] of emu.additionalFiles) {
      const basename = key.replace(/.*[\\\/]/, '').toLowerCase();
      if (basename === bareTarget) { bareBuf = data; break; }
    }
    if (bareBuf) {
      const dll = registerLoadedNeDll(emu, bareBuf, baseName);
      if (!dll) return 0;
      const handle = state.nextModuleHandle++;
      state.moduleHandles.set(baseName, handle);
      state.loadedDlls.set(handle, dll);
      callDllEntry(emu, dll);
      console.log(`[KERNEL16] LoadLibrary("${name}") → 0x${handle.toString(16)} (${dll.segments.length} segs, ${dll.resources.length} res)`);
      return handle;
    }

    const resolved = emu.resolvePath(name);
    const fileInfo = emu.fs.findFile(resolved, emu.additionalFiles);

    if (!fileInfo) {
      console.warn(`[KERNEL16] LoadLibrary("${name}") → file not found`);
      return 2;
    }

    // Try to read the file synchronously (data already in cache).
    const syncData = getSyncFileData(emu.fs, fileInfo, emu, resolved);
    if (syncData) {
      const buf = syncData.buffer.slice(syncData.byteOffset, syncData.byteOffset + syncData.byteLength) as ArrayBuffer;
      const dll = registerLoadedNeDll(emu, buf, baseName);
      if (!dll) return 0;
      const handle = state.nextModuleHandle++;
      state.moduleHandles.set(baseName, handle);
      state.loadedDlls.set(handle, dll);
      callDllEntry(emu, dll);
      console.log(`[KERNEL16] LoadLibrary("${name}") → 0x${handle.toString(16)} (${dll.segments.length} segs, ${dll.resources.length} res)`);
      return handle;
    }

    // Async path: file is in IndexedDB and not yet cached. Pull it into
    // additionalFiles for any future LoadLibrary call, but this call has to
    // fail because we can't suspend the FAR CALL synchronously. Callers that
    // depend on this DLL must drop it on the desktop before launching the EXE.
    emu.fs.fetchFileData(fileInfo, emu.additionalFiles, resolved).then((data) => {
      if (data) {
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        emu.additionalFiles.set(bareTarget, ab);
      }
    });
    console.warn(`[KERNEL16] LoadLibrary("${name}") → file not yet in cache; pre-load it via additionalFiles`);
    return 2;
  }, 95);

  // --- Ordinal 96: FreeLibrary(hLibModule) — 2 bytes (word) ---
  kernel.register('FreeLibrary', 2, () => 0, 96);

  // --- Ordinal 133: GetExePtr(word) — 2 bytes ---
  kernel.register('GetExePtr', 2, () => emu.readArg16(0), 133);

  // --- Ordinal 166: WinExec(lpCmdLine, uCmdShow) — 6 bytes (str+word) ---
  kernel.register('WinExec', 6, () => 33, 166);
}
