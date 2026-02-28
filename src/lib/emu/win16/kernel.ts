import type { Emulator } from '../emulator';

// Win16 KERNEL module — API stubs by ordinal
// Ordinal mappings from Wine's krnl386.exe16.spec
// PASCAL calling convention: args pushed left-to-right, callee pops

export function registerWin16Kernel(emu: Emulator): void {
  const kernel = emu.registerModule16('KERNEL');

  // Global memory state: each GlobalAlloc gets its own selector with a segment base.
  // Selectors start at 0x100 to avoid collision with NE code/data segments.
  let nextGlobalSelector = 0x100;
  const globalHandleToAddr = new Map<number, number>();
  const globalHandleToSize = new Map<number, number>();

  // --- Ordinal 1: FatalExit(code) — stub, 2 bytes ---
  kernel.register('ord_1', 2, () => { emu.halted = true; return 0; });

  // --- Ordinal 2: ExitKernel() — 0 bytes ---
  kernel.register('ord_2', 0, () => { emu.halted = true; return 0; });

  // --- Ordinal 3: GetVersion() — 0 bytes ---
  // Returns 0x0A03 (Windows 3.10: major=3 in low byte, minor=10 in high byte)
  kernel.register('ord_3', 0, () => 0x0A03);

  // --- Ordinal 4: LocalInit(segment, start, end) — 6 bytes (word+word+word) ---
  kernel.register('ord_4', 6, () => {
    const [segment, start, end] = emu.readPascalArgs16([2, 2, 2]);
    const base = emu.cpu.segBases.get(segment) ?? (segment * 16);
    console.log(`[KERNEL16] LocalInit(seg=0x${segment.toString(16)}, start=0x${start.toString(16)}, end=0x${end.toString(16)}) base=0x${base.toString(16)}`);
    // Register per-segment local heap
    emu.segLocalHeaps.set(segment, { ptr: base + start, end: base + end });
    return 1;
  });

  // --- Ordinal 5: LocalAlloc(flags, bytes) — 4 bytes (word+word) ---
  kernel.register('ord_5', 4, () => {
    const [flags, size] = emu.readPascalArgs16([2, 2]);
    const result = emu.allocLocal(size || 1);
    console.log(`[KERNEL16] LocalAlloc(flags=0x${flags.toString(16)}, size=${size}) DS=0x${emu.cpu.ds.toString(16)} → 0x${result.toString(16)}`);
    return result;
  });

  // --- Ordinal 6: LocalReAlloc(handle, bytes, flags) — 6 bytes (word+word+word) ---
  kernel.register('ord_6', 6, () => {
    const [handle, bytes, flags] = emu.readPascalArgs16([2, 2, 2]);
    return handle; // stub: return original handle
  });

  // --- Ordinal 7: LocalFree(handle) — 2 bytes (word) ---
  kernel.register('ord_7', 2, () => 0); // success

  // --- Ordinal 8: LocalLock(handle) — 2 bytes (word) ---
  kernel.register('ord_8', 2, () => {
    return emu.readArg16(0); // return handle as near pointer
  });

  // --- Ordinal 9: LocalUnlock(handle) — 2 bytes (word) ---
  kernel.register('ord_9', 2, () => 0);

  // --- Ordinal 10: LocalSize(handle) — 2 bytes (word) ---
  kernel.register('ord_10', 2, () => 0);

  // --- Ordinal 11: LocalHandle(mem) — 2 bytes (word) ---
  kernel.register('ord_11', 2, () => {
    return emu.readArg16(0); // return the pointer as handle
  });

  // --- Ordinal 12: LocalFlags(handle) — 2 bytes (word) ---
  kernel.register('ord_12', 2, () => 0);

  // --- Ordinal 13: LocalCompact(minFree) — 2 bytes (word) ---
  kernel.register('ord_13', 2, () => 0x2000); // report some free space

  // --- Ordinal 14: LocalNotify(lpNotifyProc) — 4 bytes (long) ---
  kernel.register('ord_14', 4, () => 0);

  // --- Ordinal 15: GlobalAlloc(flags, size_long) — 6 bytes (word+dword) ---
  kernel.register('ord_15', 6, () => {
    const [flags, size] = emu.readPascalArgs16([2, 4]);
    const allocSize = size || 1;
    // Use 64KB-aligned allocation so local heap can expand within the segment
    const addr = emu.allocHeap64K(allocSize);
    const selector = nextGlobalSelector++;
    emu.cpu.segBases.set(selector, addr);
    globalHandleToAddr.set(selector, addr);
    globalHandleToSize.set(selector, allocSize);
    console.log(`[KERNEL16] GlobalAlloc(flags=0x${flags.toString(16)}, size=${allocSize}) → selector=0x${selector.toString(16)} addr=0x${addr.toString(16)}`);
    return selector;
  });

  // --- Ordinal 16: GlobalReAlloc(handle, size_long, flags) — 8 bytes (word+dword+word) ---
  kernel.register('ord_16', 8, () => {
    const [handle, size, flags] = emu.readPascalArgs16([2, 4, 2]);
    let oldAddr = globalHandleToAddr.get(handle);
    let oldSize = globalHandleToSize.get(handle) || 0;
    // If handle is a segment selector not yet tracked, use its current segment base
    if (oldAddr === undefined) {
      oldAddr = emu.cpu.segBases.get(handle);
      // For NE segments, the old size is up to 64KB — copy everything up to the new size
      if (oldAddr !== undefined) oldSize = 0x10000;
    }
    const allocSize = Math.max(size, oldSize);
    const newAddr = emu.allocHeap(allocSize || 1);
    if (oldAddr !== undefined && oldSize > 0) {
      const copyLen = Math.min(oldSize, allocSize);
      for (let i = 0; i < copyLen; i++) {
        emu.memory.writeU8(newAddr + i, emu.memory.readU8(oldAddr + i));
      }
    }
    emu.cpu.segBases.set(handle, newAddr);
    globalHandleToAddr.set(handle, newAddr);
    globalHandleToSize.set(handle, size);
    // If this is the DGROUP (DS/SS) segment, update local heap pointers
    if (oldAddr !== undefined && emu.ne && handle === emu.ne.dataSegSelector) {
      const delta = newAddr - oldAddr;
      emu.localHeapBase += delta;
      emu.localHeapPtr += delta;
      emu.localHeapEnd = newAddr + size;
    }
    return handle;
  });

  // --- Ordinal 17: GlobalFree(handle) — 2 bytes (word) ---
  kernel.register('ord_17', 2, () => 0);

  // --- Ordinal 18: GlobalLock(handle) — 2 bytes (word) ---
  // Returns far pointer selector:0000
  kernel.register('ord_18', 2, () => {
    const handle = emu.readArg16(0);
    const addr = globalHandleToAddr.get(handle);
    if (addr === undefined) {
      emu.cpu.setReg16(2, 0); // DX = 0
      emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000); // AX = 0
      return 0;
    }
    // Return as DX:AX far pointer = selector:0000
    emu.cpu.setReg16(2, handle); // DX = selector
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000); // AX = 0 (offset)
    return (handle << 16) >>> 0;
  });

  // --- Ordinal 19: GlobalUnlock(handle) — 2 bytes (word) ---
  kernel.register('ord_19', 2, () => 0);

  // --- Ordinal 20: GlobalSize(handle) — 2 bytes (word) ---
  kernel.register('ord_20', 2, () => {
    const handle = emu.readArg16(0);
    const size = globalHandleToSize.get(handle) || 0x1000;
    console.log(`[KERNEL16] GlobalSize(0x${handle.toString(16)}) → 0x${size.toString(16)} (${size})`);
    return size;
  });

  // --- Ordinal 21: GlobalHandle(word) — 2 bytes (word) ---
  kernel.register('ord_21', 2, () => {
    const sel = emu.readArg16(0);
    console.log(`[KERNEL16] GlobalHandle(0x${sel.toString(16)}) → DX:AX=0x${sel.toString(16)}:0x${sel.toString(16)}`);
    // Return handle in DX:AX — DX=handle, AX=handle
    emu.cpu.setReg16(2, sel);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | sel;
    return (sel << 16) | sel;
  });

  // --- Ordinal 22: GlobalFlags(handle) — 2 bytes (word) ---
  kernel.register('ord_22', 2, () => 0);

  // --- Ordinal 23: LockSegment(segment) — 2 bytes (word) ---
  kernel.register('ord_23', 2, () => 0);

  // --- Ordinal 24: UnlockSegment(segment) — 2 bytes (word) ---
  kernel.register('ord_24', 2, () => 0);

  // --- Ordinal 25: GlobalCompact(minFree_long) — 4 bytes (dword) ---
  kernel.register('ord_25', 4, () => 0x100000); // report 1MB available

  // --- Ordinal 26: GlobalFreeAll(word) — 2 bytes (word) ---
  kernel.register('ord_26', 2, () => 0);

  // --- Ordinal 27: GetModuleName(word ptr word) — 8 bytes (word+ptr+word) ---
  kernel.register('ord_27', 8, () => 0);

  // --- Ordinal 28: GlobalMasterHandle() — 0 bytes ---
  kernel.register('ord_28', 0, () => 0);

  // --- Ordinal 29: Yield() — 0 bytes ---
  kernel.register('ord_29', 0, () => 0);

  // --- Ordinal 30: WaitEvent(hTask) — 2 bytes (word) ---
  kernel.register('ord_30', 2, () => 0);

  // --- Ordinal 31: PostEvent(word) — 2 bytes (word) ---
  kernel.register('ord_31', 2, () => 0);

  // --- Ordinal 32: SetPriority(word s_word) — 4 bytes ---
  kernel.register('ord_32', 4, () => 0);

  // --- Ordinal 33: LockCurrentTask(word) — 2 bytes ---
  kernel.register('ord_33', 2, () => 0);

  // --- Ordinal 34: SetTaskQueue(hTask, hQueue) — 4 bytes (word+word) ---
  kernel.register('ord_34', 4, () => {
    const [hTask, hQueue] = emu.readPascalArgs16([2, 2]);
    return hQueue;
  });

  // --- Ordinal 35: GetTaskQueue(word) — 2 bytes ---
  kernel.register('ord_35', 2, () => 0);

  // --- Ordinal 36: GetCurrentTask() — 0 bytes ---
  kernel.register('ord_36', 0, () => 1); // fake task handle

  // --- Ordinal 37: GetCurrentPDB() — 0 bytes ---
  kernel.register('ord_37', 0, () => 0);

  // --- Ordinal 38: SetTaskSignalProc(word segptr) — 6 bytes (word+long) ---
  kernel.register('ord_38', 6, () => 0);

  // --- Ordinal 41: EnableDos() — 0 bytes ---
  kernel.register('ord_41', 0, () => 0);

  // --- Ordinal 42: DisableDos() — 0 bytes ---
  kernel.register('ord_42', 0, () => 0);

  // --- Ordinal 45: LoadModule(str ptr) — 8 bytes (long+long) ---
  kernel.register('ord_45', 8, () => 2); // return module handle > 32

  // --- Ordinal 46: FreeModule(word) — 2 bytes ---
  kernel.register('ord_46', 2, () => 1);

  // --- Ordinal 47: GetModuleHandle(lpModuleName_ptr) — 4 bytes (segstr) ---
  kernel.register('ord_47', 4, () => 1); // fake module handle

  // --- Ordinal 48: GetModuleUsage(hModule) — 2 bytes (word) ---
  kernel.register('ord_48', 2, () => 1);

  // --- Ordinal 49: GetModuleFileName(hModule, lpFilename, nSize) — 8 bytes (word+ptr+s_word) ---
  kernel.register('ord_49', 8, () => {
    const [hModule, lpFilename, nSize] = emu.readPascalArgs16([2, 4, 2]);
    const name = emu.exePath;
    if (lpFilename && nSize > 0) {
      const maxCopy = Math.min(name.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(lpFilename + i, name.charCodeAt(i));
      }
      emu.memory.writeU8(lpFilename + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 50: GetProcAddress(hModule, lpProcName_str) — 6 bytes (word+str) ---
  kernel.register('ord_50', 6, () => 0); // stub: return NULL

  // --- Ordinal 51: MakeProcInstance(lpProc_segptr, hInstance) — 6 bytes (segptr+word) ---
  kernel.register('ord_51', 6, () => {
    const [lpProc, hInstance] = emu.readPascalArgs16([4, 2]);
    return lpProc; // return proc address unchanged
  });

  // --- Ordinal 52: FreeProcInstance(lpProc_segptr) — 4 bytes (segptr) ---
  kernel.register('ord_52', 4, () => 0);

  // --- Ordinal 54: GetInstanceData(hInstance, pData, nCount) — 6 bytes (word+word+word) ---
  kernel.register('ord_54', 6, () => 0); // stub: return 0 bytes copied

  // --- Ordinal 55: Catch(ptr) — 4 bytes (ptr), register-based ---
  // Saves execution state; we stub it as no-op returning 0
  kernel.register('ord_55', 4, () => 0);

  // --- Ordinal 56: Throw(ptr, word) — 6 bytes (ptr+word), register-based ---
  // Restores execution state; stub as no-op
  kernel.register('ord_56', 6, () => 0);

  // --- Ordinal 57: GetProfileInt(str str s_word) — 10 bytes (str+str+word) ---
  kernel.register('ord_57', 10, () => {
    const [lpAppName, lpKeyName, nDefault] = emu.readPascalArgs16([4, 4, 2]);
    return nDefault;
  });

  // --- Ordinal 58: GetProfileString(str str str ptr word) — 18 bytes ---
  kernel.register('ord_58', 18, () => {
    const [lpAppName, lpKeyName, lpDefault, lpRetBuf, nSize] = emu.readPascalArgs16([4, 4, 4, 4, 2]);
    if (lpRetBuf && nSize > 0) emu.memory.writeU8(lpRetBuf, 0);
    return 0;
  });

  // --- Ordinal 59: WriteProfileString(str str str) — 12 bytes ---
  kernel.register('ord_59', 12, () => 1);

  // --- Ordinal 60: FindResource(hInst, lpName, lpType) — 10 bytes (word+str+str) ---
  kernel.register('ord_60', 10, () => {
    const [hInst, lpName, lpType] = emu.readPascalArgs16([2, 4, 4]);
    const nameSeg = (lpName >>> 16) & 0xFFFF;
    const nameOff = lpName & 0xFFFF;
    const resId = (nameSeg === 0) ? nameOff : 0;
    const typeSeg = (lpType >>> 16) & 0xFFFF;
    const typeOff = lpType & 0xFFFF;
    const typeId = (typeSeg === 0) ? typeOff : 0;
    console.log(`[KERNEL16] FindResource hInst=${hInst} name=${resId} type=${typeId}`);
    // Return a fake handle encoding typeId and resId
    return ((typeId & 0xFF) << 8) | (resId & 0xFF) || 1;
  });

  // --- Ordinal 61: LoadResource(hInst, hResInfo) — 4 bytes (word+word) ---
  kernel.register('ord_61', 4, () => {
    const [hInst, hResInfo] = emu.readPascalArgs16([2, 2]);
    return hResInfo || 1;
  });

  // --- Ordinal 62: LockResource(hResData) — 2 bytes (word) ---
  kernel.register('ord_62', 2, () => {
    const hResData = emu.readArg16(0);
    return hResData; // return far pointer (in our model, same as handle)
  });

  // --- Ordinal 63: FreeResource(hResData) — 2 bytes (word) ---
  kernel.register('ord_63', 2, () => 0);

  // --- Ordinal 64: AccessResource(word word) — 4 bytes ---
  kernel.register('ord_64', 4, () => -1); // HFILE_ERROR

  // --- Ordinal 65: SizeofResource(word word) — 4 bytes ---
  kernel.register('ord_65', 4, () => 0);

  // --- Ordinal 66: AllocResource(word word long) — 8 bytes (word+word+long) ---
  kernel.register('ord_66', 8, () => 0);

  // --- Ordinal 67: SetResourceHandler(word str segptr) — 10 bytes (word+str+segptr) ---
  kernel.register('ord_67', 10, () => 0);

  // --- Ordinal 68: InitAtomTable(size) — 2 bytes (word) ---
  kernel.register('ord_68', 2, () => 1);

  // --- Ordinal 69: FindAtom(str) — 4 bytes (str) ---
  kernel.register('ord_69', 4, () => 0); // atom not found

  // --- Ordinal 70: AddAtom(str) — 4 bytes (str) ---
  kernel.register('ord_70', 4, () => 0xC000); // fake atom

  // --- Ordinal 71: DeleteAtom(word) — 2 bytes ---
  kernel.register('ord_71', 2, () => 0);

  // --- Ordinal 72: GetAtomName(word ptr word) — 8 bytes (word+ptr+word) ---
  kernel.register('ord_72', 8, () => {
    const [atom, lpBuffer, nSize] = emu.readPascalArgs16([2, 4, 2]);
    if (lpBuffer && nSize > 0) emu.memory.writeU8(lpBuffer, 0);
    return 0;
  });

  // --- Ordinal 74: OpenFile(lpFileName, lpReOpenBuf, uStyle) — 10 bytes (str+ptr+word) ---
  kernel.register('ord_74', 10, () => -1); // HFILE_ERROR

  // --- Ordinal 81: _lclose(hFile) — 2 bytes (word) ---
  kernel.register('ord_81', 2, () => 0);

  // --- Ordinal 82: _lread(hFile, lpBuffer_segptr, wBytes) — 8 bytes (word+segptr+word) ---
  kernel.register('ord_82', 8, () => 0); // stub: 0 bytes read

  // --- Ordinal 83: _lcreat(str word) — 6 bytes ---
  kernel.register('ord_83', 6, () => -1); // HFILE_ERROR

  // --- Ordinal 84: _llseek(word long word) — 8 bytes (word+long+word) ---
  kernel.register('ord_84', 8, () => -1); // error

  // --- Ordinal 85: _lopen(str word) — 6 bytes (str+word) ---
  kernel.register('ord_85', 6, () => -1); // HFILE_ERROR

  // --- Ordinal 86: _lwrite(hFile, lpBuffer_ptr, wBytes) — 8 bytes (word+ptr+word) ---
  kernel.register('ord_86', 8, () => 0); // stub: 0 bytes written

  // --- Ordinal 87: Reserved5 / lstrcmp(str str) — 8 bytes ---
  kernel.register('ord_87', 8, () => {
    const [lpStr1, lpStr2] = emu.readPascalArgs16([4, 4]);
    if (!lpStr1 || !lpStr2) return 0;
    let i = 0;
    while (true) {
      const c1 = emu.memory.readU8(lpStr1 + i);
      const c2 = emu.memory.readU8(lpStr2 + i);
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (c1 === 0) return 0;
      i++;
      if (i > 0xFFFF) break;
    }
    return 0;
  });

  // --- Ordinal 88: lstrcpy(lpDst, lpSrc) — 8 bytes (segptr+str) ---
  kernel.register('ord_88', 8, () => {
    const [lpDstRaw, lpSrcRaw] = emu.readPascalArgs16([4, 4]);
    const lpDst = emu.resolveFarPtr(lpDstRaw);
    const lpSrc = emu.resolveFarPtr(lpSrcRaw);
    if (lpDst && lpSrc) {
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(lpSrc + i);
        emu.memory.writeU8(lpDst + i, ch);
        if (ch === 0) break;
        i++;
        if (i > 0xFFFF) break;
      }
    }
    // Return original far pointer to lpDst — in DX:AX
    emu.cpu.setReg16(2, (lpDstRaw >>> 16) & 0xFFFF); // DX = segment
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (lpDstRaw & 0xFFFF); // AX = offset
    return lpDstRaw;
  });

  // --- Ordinal 89: lstrcat(lpDst, lpSrc) — 8 bytes (segstr+str) ---
  kernel.register('ord_89', 8, () => {
    const [lpDstRaw, lpSrcRaw] = emu.readPascalArgs16([4, 4]);
    const lpDst = emu.resolveFarPtr(lpDstRaw);
    const lpSrc = emu.resolveFarPtr(lpSrcRaw);
    if (lpDst && lpSrc) {
      let dstLen = 0;
      while (emu.memory.readU8(lpDst + dstLen) !== 0 && dstLen < 0xFFFF) dstLen++;
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(lpSrc + i);
        emu.memory.writeU8(lpDst + dstLen + i, ch);
        if (ch === 0) break;
        i++;
        if (i > 0xFFFF) break;
      }
    }
    emu.cpu.setReg16(2, (lpDstRaw >>> 16) & 0xFFFF);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (lpDstRaw & 0xFFFF);
    return lpDstRaw;
  });

  // --- Ordinal 90: lstrlen(lpString) — 4 bytes (str) ---
  kernel.register('ord_90', 4, () => {
    const lpString = emu.readArg16FarPtr(0);
    if (!lpString) return 0;
    let len = 0;
    while (emu.memory.readU8(lpString + len) !== 0 && len < 0xFFFF) len++;
    return len;
  });

  // --- Ordinal 91: InitTask() — 0 bytes, register-based ---
  // (special: CRT pushes BP, so we clean 2 bytes in completeThunk)
  kernel.register('ord_91', 2, () => {
    const hInstance = 1;
    emu.cpu.reg[0] = hInstance;       // AX = hInstance
    emu.cpu.setReg16(3, 1);           // BX = cmdShow (SW_SHOWNORMAL)
    emu.cpu.setReg16(1, 0x1000);      // CX = stack size
    emu.cpu.setReg16(2, 1);           // DX = nCmdShow
    emu.cpu.setReg16(7, hInstance);    // DI = hInstance
    emu.cpu.setReg16(6, 0);           // SI = hPrevInstance (0)
    // ES:BX should point to command line — allocate a small buffer
    const cmdLineAddr = emu.allocHeap(16);
    emu.memory.writeU8(cmdLineAddr, 0); // empty command line
    // Set ES = DS (auto-data segment) and BX to standard PSP command tail offset
    emu.cpu.es = emu.cpu.ds;
    emu.cpu.setReg16(3, 0x81);         // BX = offset 0x81
    return hInstance;
  });

  // --- Ordinal 92: GetTempDrive(word) — 2 bytes ---
  kernel.register('ord_92', 2, () => 0x43); // 'C'

  // --- Ordinal 93: GetCodeHandle(lpProc) — 4 bytes (segptr) ---
  kernel.register('ord_93', 4, () => {
    const lpProc = emu.readArg16DWord(0);
    return (lpProc >>> 16) & 0xFFFF; // return segment
  });

  // --- Ordinal 94: DefineHandleTable(wOffset) — 2 bytes (word) ---
  kernel.register('ord_94', 2, () => 1);

  // --- Ordinal 95: LoadLibrary(lpLibFileName) — 4 bytes (str) ---
  kernel.register('ord_95', 4, () => {
    const lpLibFileName = emu.readArg16DWord(0);
    const name = lpLibFileName ? emu.memory.readCString(lpLibFileName) : '';
    console.log(`[KERNEL16] LoadLibrary("${name}") → stub`);
    return 32; // >= 32 means success
  });

  // --- Ordinal 96: FreeLibrary(hLibModule) — 2 bytes (word) ---
  kernel.register('ord_96', 2, () => 0);

  // --- Ordinal 97: GetTempFileName(word str word ptr) — 12 bytes (word+str+word+ptr) ---
  kernel.register('ord_97', 12, () => {
    const [drive, prefix, unique, lpTempFileName] = emu.readPascalArgs16([2, 4, 2, 4]);
    if (lpTempFileName) {
      const name = 'C:\\TEMP\\~TMP0001.TMP';
      for (let i = 0; i < name.length; i++) {
        emu.memory.writeU8(lpTempFileName + i, name.charCodeAt(i));
      }
      emu.memory.writeU8(lpTempFileName + name.length, 0);
    }
    return unique || 1;
  });

  // --- Ordinal 100: ValidateCodeSegments() — 0 bytes ---
  kernel.register('ord_100', 0, () => 0);

  // --- Ordinal 102: DOS3Call() — 0 bytes, register-based ---
  // Dispatch DOS INT 21h via AH function number
  kernel.register('ord_102', 0, () => {
    const ah = (emu.cpu.reg[0] >>> 8) & 0xFF;
    if (ah === 0x25 || ah === 0x35) {
      // Set/Get Interrupt Vector — no-op
      if (ah === 0x35) {
        emu.cpu.es = 0;
        emu.cpu.setReg16(3, 0); // BX = 0
      }
      return 0;
    }
    if (ah === 0x4C) {
      // Terminate process
      console.log(`[DOS3Call] Terminate (AH=4Ch, AL=0x${(emu.cpu.reg[0] & 0xFF).toString(16)})`);
      emu.halted = true;
    } else if (ah === 0x2A) {
      // Get Date: CX=year, DH=month, DL=day, AL=day of week
      const now = new Date();
      emu.cpu.reg[1] = (emu.cpu.reg[1] & 0xFFFF0000) | now.getFullYear();
      emu.cpu.reg[2] = (emu.cpu.reg[2] & 0xFFFF0000) | ((now.getMonth() + 1) << 8) | now.getDate();
      emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFFFF00) | now.getDay();
    } else if (ah === 0x2C) {
      // Get Time: CH=hour, CL=minute, DH=second, DL=hundredths
      const now = new Date();
      emu.cpu.reg[1] = (emu.cpu.reg[1] & 0xFFFF0000) | (now.getHours() << 8) | now.getMinutes();
      emu.cpu.reg[2] = (emu.cpu.reg[2] & 0xFFFF0000) | (now.getSeconds() << 8) | Math.floor(now.getMilliseconds() / 10);
    } else if (ah === 0x30) {
      // Get DOS version — return 3.10
      emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | 0x0A03;
    } else if (ah === 0x3D || ah === 0x3F || ah === 0x40 || ah === 0x42 || ah === 0x4E || ah === 0x4F) {
      // File operations — return error (carry flag set)
      emu.cpu.setFlags(emu.cpu.getFlags() | 0x0001); // set CF
      emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFF) | 2; // AL = file not found
    } else if (ah === 0x3E) {
      // Close file — success
      emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0001); // clear CF
    } else {
      console.warn(`[DOS3Call] Unhandled AH=0x${ah.toString(16)}`);
    }
    return 0;
  });

  // --- Ordinal 104: GetCodeInfo(segptr ptr) — 8 bytes ---
  kernel.register('ord_104', 8, () => 0);

  // --- Ordinal 105: GetExeVersion() — 0 bytes ---
  kernel.register('ord_105', 0, () => 0x030A); // 3.10

  // --- Ordinal 106: SetSwapAreaSize(word) — 2 bytes ---
  kernel.register('ord_106', 2, () => {
    return emu.readArg16(0);
  });

  // --- Ordinal 107: SetErrorMode(uMode) — 2 bytes (word) ---
  kernel.register('ord_107', 2, () => 0);

  // --- Ordinal 111: GlobalWire(word) — 2 bytes ---
  kernel.register('ord_111', 2, () => {
    const handle = emu.readArg16(0);
    const addr = globalHandleToAddr.get(handle);
    if (addr === undefined) return 0;
    emu.cpu.setReg16(2, handle);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000);
    return (handle << 16) >>> 0;
  });

  // --- Ordinal 112: GlobalUnWire(word) — 2 bytes ---
  kernel.register('ord_112', 2, () => 1);

  // --- Ordinal 113: equate __AHSHIFT 3 ---
  kernel.register('ord_113', 0, () => 3);

  // --- Ordinal 114: equate __AHINCR 8 ---
  kernel.register('ord_114', 0, () => 8);

  // --- Ordinal 115: OutputDebugString(lpString) — 4 bytes (str) ---
  kernel.register('ord_115', 4, () => 0);

  // --- Ordinal 117: OldYield() — 0 bytes ---
  kernel.register('ord_117', 0, () => 0);

  // --- Ordinal 118: GetTaskQueueDS() — 0 bytes ---
  kernel.register('ord_118', 0, () => emu.cpu.ds);

  // --- Ordinal 119: GetTaskQueueES() — 0 bytes ---
  kernel.register('ord_119', 0, () => emu.cpu.es);

  // --- Ordinal 121: LocalShrink(word word) — 4 bytes ---
  kernel.register('ord_121', 4, () => 0x2000);

  // --- Ordinal 122: IsTaskLocked() — 0 bytes ---
  kernel.register('ord_122', 0, () => 0);

  // --- Ordinal 123: KbdRst() — 0 bytes ---
  kernel.register('ord_123', 0, () => 0);

  // --- Ordinal 124: EnableKernel() — 0 bytes ---
  kernel.register('ord_124', 0, () => 0);

  // --- Ordinal 125: DisableKernel() — 0 bytes ---
  kernel.register('ord_125', 0, () => 0);

  // --- Ordinal 127: GetPrivateProfileInt(str str s_word str) — 14 bytes ---
  kernel.register('ord_127', 14, () => {
    const [lpAppName, lpKeyName, nDefault, lpFileName] = emu.readPascalArgs16([4, 4, 2, 4]);
    return nDefault;
  });

  // --- Ordinal 128: GetPrivateProfileString(str str str ptr word str) — 22 bytes ---
  kernel.register('ord_128', 22, () => {
    const [lpAppName, lpKeyName, lpDefault, lpRetBuf, nSize, lpFileName] = emu.readPascalArgs16([4, 4, 4, 4, 2, 4]);
    if (lpRetBuf) emu.memory.writeU8(lpRetBuf, 0);
    return 0;
  });

  // --- Ordinal 129: WritePrivateProfileString(str str str str) — 16 bytes ---
  kernel.register('ord_129', 16, () => 1);

  // --- Ordinal 131: GetDOSEnvironment() — 0 bytes ---
  kernel.register('ord_131', 0, () => {
    // Return a far pointer to a double-null-terminated environment block
    const envAddr = emu.allocHeap(4);
    emu.memory.writeU8(envAddr, 0); // empty environment (double null)
    emu.memory.writeU8(envAddr + 1, 0);
    // Return as DX:AX
    const seg = emu.cpu.ds;
    emu.cpu.setReg16(2, seg);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (envAddr & 0xFFFF);
    return (seg << 16) | (envAddr & 0xFFFF);
  });

  // --- Ordinal 132: GetWinFlags() — 0 bytes ---
  kernel.register('ord_132', 0, () => 0x0413);

  // --- Ordinal 133: GetExePtr(word) — 2 bytes ---
  kernel.register('ord_133', 2, () => {
    return emu.readArg16(0); // return same handle
  });

  // --- Ordinal 134: GetWindowsDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('ord_134', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS';
    if (lpBuffer && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(lpBuffer + i, dir.charCodeAt(i));
      }
      emu.memory.writeU8(lpBuffer + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 135: GetSystemDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('ord_135', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS\\SYSTEM';
    if (lpBuffer && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(lpBuffer + i, dir.charCodeAt(i));
      }
      emu.memory.writeU8(lpBuffer + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 136: GetDriveType(nDrive) — 2 bytes (word) ---
  kernel.register('ord_136', 2, () => 3); // DRIVE_FIXED

  // --- Ordinal 137: FatalAppExit(action, lpMsg) — 6 bytes (word+str) ---
  kernel.register('ord_137', 6, () => {
    // FatalAppExit(uAction, lpMessageText)
    const msg = emu.memory.readCString(emu.readArg16DWord(2));
    console.error(`[KERNEL] FatalAppExit: "${msg}"`);
    emu.haltReason = `FatalAppExit: ${msg}`;
    emu.halted = true;
    return 0;
  });

  // --- Ordinal 138: GetHeapSpaces(word) — 2 bytes ---
  kernel.register('ord_138', 2, () => {
    // Returns DWORD: HIWORD=free, LOWORD=max
    return (0x2000 << 16) | 0x4000;
  });

  // --- Ordinal 140: SetSigHandler(segptr ptr ptr word word) — 14 bytes ---
  kernel.register('ord_140', 14, () => 0);

  // --- Ordinal 147: SetLastError(long) — 4 bytes ---
  kernel.register('ord_147', 4, () => 0);

  // --- Ordinal 148: GetLastError() — 0 bytes ---
  kernel.register('ord_148', 0, () => 0);

  // --- Ordinal 149: GetVersionEx(ptr) — 4 bytes ---
  kernel.register('ord_149', 4, () => 1);

  // --- Ordinal 150: DirectedYield(word) — 2 bytes ---
  kernel.register('ord_150', 2, () => 0);

  // --- Ordinal 152: GetNumTasks() — 0 bytes ---
  kernel.register('ord_152', 0, () => 1);

  // --- Ordinal 154: GlobalNotify(segptr) — 4 bytes ---
  kernel.register('ord_154', 4, () => 0);

  // --- Ordinal 155: GetTaskDS() — 0 bytes ---
  kernel.register('ord_155', 0, () => emu.cpu.ds);

  // --- Ordinal 156: LimitEMSPages(long) — 4 bytes ---
  kernel.register('ord_156', 4, () => 0);

  // --- Ordinal 157: GetCurPID(long) — 4 bytes ---
  kernel.register('ord_157', 4, () => 0);

  // --- Ordinal 158: IsWinOldApTask(word) — 2 bytes ---
  kernel.register('ord_158', 2, () => 0);

  // --- Ordinal 159: GlobalHandleNoRIP(word) — 2 bytes ---
  kernel.register('ord_159', 2, () => {
    const sel = emu.readArg16(0);
    return (sel << 16) | sel;
  });

  // --- Ordinal 161: LocalCountFree() — 0 bytes ---
  kernel.register('ord_161', 0, () => 0x100);

  // --- Ordinal 162: LocalHeapSize() — 0 bytes ---
  kernel.register('ord_162', 0, () => 0x2000);

  // --- Ordinal 163: GlobalLRUOldest(word) — 2 bytes ---
  kernel.register('ord_163', 2, () => {
    return emu.readArg16(0);
  });

  // --- Ordinal 164: GlobalLRUNewest(word) — 2 bytes ---
  kernel.register('ord_164', 2, () => {
    return emu.readArg16(0);
  });

  // --- Ordinal 165: A20Proc(word) — 2 bytes ---
  kernel.register('ord_165', 2, () => 0);

  // --- Ordinal 166: WinExec(lpCmdLine, uCmdShow) — 6 bytes (str+word) ---
  kernel.register('ord_166', 6, () => 33); // > 32 = success

  // --- Ordinal 167: GetExpWinVer(word) — 2 bytes ---
  kernel.register('ord_167', 2, () => 0x030A); // 3.10

  // --- Ordinal 168: DirectResAlloc(word word word) — 6 bytes ---
  kernel.register('ord_168', 6, () => 0);

  // --- Ordinal 169: GetFreeSpace(flags) — 2 bytes (word) ---
  kernel.register('ord_169', 2, () => 0x00100000); // 1MB free

  // --- Ordinal 170: AllocCStoDSAlias(selector) — 2 bytes (word) ---
  kernel.register('ord_170', 2, () => {
    return emu.cpu.ds;
  });

  // --- Ordinal 171: AllocDStoCSAlias(word) — 2 bytes ---
  kernel.register('ord_171', 2, () => {
    return emu.cpu.cs;
  });

  // --- Ordinal 172: AllocAlias(word) — 2 bytes ---
  kernel.register('ord_172', 2, () => {
    return emu.cpu.ds;
  });

  // --- Ordinal 173: equate __ROMBIOS 0 ---
  kernel.register('ord_173', 0, () => 0);

  // --- Ordinal 174: equate __A000H 0 ---
  kernel.register('ord_174', 0, () => 0);

  // --- Ordinal 175: AllocSelector(word) — 2 bytes ---
  kernel.register('ord_175', 2, () => {
    const sel = nextGlobalSelector++;
    emu.cpu.segBases.set(sel, 0);
    return sel;
  });

  // --- Ordinal 176: FreeSelector(selector) — 2 bytes (word) ---
  kernel.register('ord_176', 2, () => 0);

  // --- Ordinal 177: PrestoChangoSelector(word word) — 4 bytes ---
  kernel.register('ord_177', 4, () => {
    const [srcSel, dstSel] = emu.readPascalArgs16([2, 2]);
    return dstSel;
  });

  // --- Ordinal 178: equate __WINFLAGS 0x413 ---
  kernel.register('ord_178', 0, () => 0x0413);

  // --- Ordinal 179: equate __D000H 0 ---
  kernel.register('ord_179', 0, () => 0);

  // --- Ordinal 180: LongPtrAdd(long long) — 8 bytes ---
  kernel.register('ord_180', 8, () => {
    const [ptr, offset] = emu.readPascalArgs16([4, 4]);
    return (ptr + offset) >>> 0;
  });

  // --- Ordinal 181: equate __B000H 0 ---
  kernel.register('ord_181', 0, () => 0);

  // --- Ordinal 182: equate __B800H 0 ---
  kernel.register('ord_182', 0, () => 0);

  // --- Ordinal 183: equate __0000H 0 ---
  kernel.register('ord_183', 0, () => 0);

  // --- Ordinal 184: GlobalDOSAlloc(long) — 4 bytes ---
  kernel.register('ord_184', 4, () => 0);

  // --- Ordinal 185: GlobalDOSFree(word) — 2 bytes ---
  kernel.register('ord_185', 2, () => 0);

  // --- Ordinal 186: GetSelectorBase(word) — 2 bytes ---
  kernel.register('ord_186', 2, () => {
    const sel = emu.readArg16(0);
    return emu.cpu.segBases.get(sel) || 0;
  });

  // --- Ordinal 187: SetSelectorBase(word long) — 6 bytes ---
  kernel.register('ord_187', 6, () => {
    const [sel, base] = emu.readPascalArgs16([2, 4]);
    emu.cpu.segBases.set(sel, base);
    return 1;
  });

  // --- Ordinal 188: GetSelectorLimit(word) — 2 bytes ---
  kernel.register('ord_188', 2, () => 0xFFFF);

  // --- Ordinal 189: SetSelectorLimit(word long) — 6 bytes ---
  kernel.register('ord_189', 6, () => 1);

  // --- Ordinal 190: equate __E000H 0 ---
  kernel.register('ord_190', 0, () => 0);

  // --- Ordinal 191: GlobalPageLock(word) — 2 bytes ---
  kernel.register('ord_191', 2, () => 1);

  // --- Ordinal 192: GlobalPageUnlock(word) — 2 bytes ---
  kernel.register('ord_192', 2, () => 1);

  // --- Ordinal 193: equate __0040H 0 ---
  kernel.register('ord_193', 0, () => 0);

  // --- Ordinal 194: equate __F000H 0 ---
  kernel.register('ord_194', 0, () => 0);

  // --- Ordinal 195: equate __C000H 0 ---
  kernel.register('ord_195', 0, () => 0);

  // --- Ordinal 196: SelectorAccessRights(word word word) — 6 bytes ---
  kernel.register('ord_196', 6, () => 0);

  // --- Ordinal 197: GlobalFix(word) — 2 bytes ---
  kernel.register('ord_197', 2, () => 0);

  // --- Ordinal 198: GlobalUnfix(word) — 2 bytes ---
  kernel.register('ord_198', 2, () => 0);

  // --- Ordinal 199: SetHandleCount(word) — 2 bytes ---
  kernel.register('ord_199', 2, () => {
    return emu.readArg16(0); // return the requested count
  });

  // --- Ordinal 200: ValidateFreeSpaces() — 0 bytes ---
  kernel.register('ord_200', 0, () => 0);

  // --- Ordinal 206: AllocSelectorArray(word) — 2 bytes ---
  kernel.register('ord_206', 2, () => {
    const count = emu.readArg16(0);
    const firstSel = nextGlobalSelector;
    for (let i = 0; i < count; i++) {
      emu.cpu.segBases.set(nextGlobalSelector++, 0);
    }
    return firstSel;
  });

  // --- Ordinal 207: IsDBCSLeadByte(word) — 2 bytes ---
  kernel.register('ord_207', 2, () => 0); // not a DBCS lead byte


  // =====================================================================
  // 208-237: Win95 extensions (registry etc.)
  // =====================================================================

  // --- Ordinal 216: RegEnumKey(long long ptr long) — 16 bytes ---
  kernel.register('ord_216', 16, () => 259); // ERROR_NO_MORE_ITEMS

  // --- Ordinal 217: RegOpenKey(long str ptr) — 12 bytes ---
  kernel.register('ord_217', 12, () => {
    const [hKey, lpSubKey, phkResult] = emu.readPascalArgs16([4, 4, 4]);
    if (phkResult) emu.memory.writeU32(phkResult, 0xBEEF0001);
    return 0; // ERROR_SUCCESS
  });

  // --- Ordinal 218: RegCreateKey(long str ptr) — 12 bytes ---
  kernel.register('ord_218', 12, () => {
    const [hKey, lpSubKey, phkResult] = emu.readPascalArgs16([4, 4, 4]);
    if (phkResult) emu.memory.writeU32(phkResult, 0xBEEF0002);
    return 0; // ERROR_SUCCESS
  });

  // --- Ordinal 219: RegDeleteKey(long str) — 8 bytes ---
  kernel.register('ord_219', 8, () => 0); // ERROR_SUCCESS

  // --- Ordinal 220: RegCloseKey(long) — 4 bytes ---
  kernel.register('ord_220', 4, () => 0); // ERROR_SUCCESS

  // --- Ordinal 221: RegSetValue(long str long ptr long) — 20 bytes ---
  kernel.register('ord_221', 20, () => 0); // ERROR_SUCCESS

  // --- Ordinal 222: RegDeleteValue(long str) — 8 bytes ---
  kernel.register('ord_222', 8, () => 0); // ERROR_SUCCESS

  // --- Ordinal 223: RegEnumValue(long long ptr ptr ptr ptr ptr ptr) — 32 bytes ---
  kernel.register('ord_223', 32, () => 259); // ERROR_NO_MORE_ITEMS

  // --- Ordinal 224: RegQueryValue(long str ptr ptr) — 16 bytes ---
  kernel.register('ord_224', 16, () => 2); // ERROR_FILE_NOT_FOUND

  // --- Ordinal 225: RegQueryValueEx(long str ptr ptr ptr ptr) — 24 bytes ---
  kernel.register('ord_225', 24, () => 2); // ERROR_FILE_NOT_FOUND

  // --- Ordinal 226: RegSetValueEx(long str long long ptr long) — 24 bytes ---
  kernel.register('ord_226', 24, () => 0); // ERROR_SUCCESS

  // --- Ordinal 227: RegFlushKey(long) — 4 bytes ---
  kernel.register('ord_227', 4, () => 0); // ERROR_SUCCESS


  // =====================================================================
  // 262-274: WinNT extensions
  // =====================================================================

  // --- Ordinal 262: WOWWaitForMsgAndEvent(word) — 2 bytes ---
  kernel.register('ord_262', 2, () => 0);

  // --- Ordinal 263: WOWMsgBox — stub ---
  kernel.register('ord_263', 0, () => 0);

  // --- Ordinal 273: K273 — stub ---
  kernel.register('ord_273', 0, () => 0);

  // --- Ordinal 274: GetShortPathName(str ptr word) — 10 bytes ---
  kernel.register('ord_274', 10, () => {
    const [lpszLongPath, lpszShortPath, cchBuffer] = emu.readPascalArgs16([4, 4, 2]);
    if (lpszLongPath && lpszShortPath && cchBuffer > 0) {
      // Copy long path as-is (short path = long path in our stub)
      let i = 0;
      while (i < cchBuffer - 1) {
        const ch = emu.memory.readU8(lpszLongPath + i);
        emu.memory.writeU8(lpszShortPath + i, ch);
        if (ch === 0) return i;
        i++;
      }
      emu.memory.writeU8(lpszShortPath + i, 0);
      return i;
    }
    return 0;
  });


  // =====================================================================
  // 310-356: Shared between all versions
  // =====================================================================

  // --- Ordinal 310: LocalHandleDelta(word) — 2 bytes ---
  kernel.register('ord_310', 2, () => {
    return emu.readArg16(0);
  });

  // --- Ordinal 320: IsTask(word) — 2 bytes ---
  kernel.register('ord_320', 2, () => 1);

  // --- Ordinal 334: IsBadReadPtr(segptr word) — 6 bytes ---
  kernel.register('ord_334', 6, () => 0); // pointer is valid

  // --- Ordinal 335: IsBadWritePtr(segptr word) — 6 bytes ---
  kernel.register('ord_335', 6, () => 0);

  // --- Ordinal 336: IsBadCodePtr(segptr) — 4 bytes ---
  kernel.register('ord_336', 4, () => 0);

  // --- Ordinal 337: IsBadStringPtr(segptr word) — 6 bytes ---
  kernel.register('ord_337', 6, () => 0);

  // --- Ordinal 346: IsBadHugeReadPtr(segptr long) — 8 bytes ---
  kernel.register('ord_346', 8, () => 0);

  // --- Ordinal 347: IsBadHugeWritePtr(segptr long) — 8 bytes ---
  kernel.register('ord_347', 8, () => 0);

  // --- Ordinal 348: hmemcpy(ptr ptr long) — 12 bytes ---
  kernel.register('ord_348', 12, () => {
    const [lpDest, lpSrc, cbCopy] = emu.readPascalArgs16([4, 4, 4]);
    if (lpDest && lpSrc && cbCopy > 0) {
      for (let i = 0; i < cbCopy; i++) {
        emu.memory.writeU8(lpDest + i, emu.memory.readU8(lpSrc + i));
      }
    }
    return 0;
  });

  // --- Ordinal 353: lstrcpyn(lpDst, lpSrc, iMaxLength) — 10 bytes (segptr+str+word) ---
  kernel.register('ord_353', 10, () => {
    const [lpDst, lpSrc, iMaxLength] = emu.readPascalArgs16([4, 4, 2]);
    if (lpDst && lpSrc && iMaxLength > 0) {
      let i = 0;
      while (i < iMaxLength - 1) {
        const ch = emu.memory.readU8(lpSrc + i);
        emu.memory.writeU8(lpDst + i, ch);
        if (ch === 0) break;
        i++;
      }
      emu.memory.writeU8(lpDst + i, 0);
    }
    emu.cpu.setReg16(2, (lpDst >>> 16) & 0xFFFF);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (lpDst & 0xFFFF);
    return lpDst;
  });

  // --- Ordinal 354: GetAppCompatFlags(word) — 2 bytes ---
  kernel.register('ord_354', 2, () => 0);


  // =====================================================================
  // 403-404: Common to all versions
  // =====================================================================

  // --- Ordinal 403: FarSetOwner(word word) — 4 bytes ---
  kernel.register('ord_403', 4, () => 0);

  // --- Ordinal 404: FarGetOwner(word) — 2 bytes ---
  kernel.register('ord_404', 2, () => 0);


  // =====================================================================
  // 500-518: WinNT extensions (some also in Win95)
  // =====================================================================

  // --- Ordinal 513: LoadLibraryEx32W(ptr long long) — 12 bytes ---
  kernel.register('ord_513', 12, () => 0); // stub

  // --- Ordinal 514: FreeLibrary32W(long) — 4 bytes ---
  kernel.register('ord_514', 4, () => 1);

  // --- Ordinal 515: GetProcAddress32W(long str) — 8 bytes ---
  kernel.register('ord_515', 8, () => 0);

  // --- Ordinal 516: GetVDMPointer32W(segptr word) — 6 bytes ---
  kernel.register('ord_516', 6, () => 0);
}
