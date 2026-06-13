import type { Emulator } from '../emulator';

// Win16 TOOLHELP module (TOOLHELP.DLL) — debugging/inspection APIs
// Reference: Wine dlls/toolhelp.dll16/toolhelp.dll16.spec
// Most functions are diagnostic stubs that return 0/FALSE to indicate "no info".

export function registerWin16Toolhelp(emu: Emulator): void {
  const th = emu.registerModule16('TOOLHELP');

  // Ordinal 50: GlobalHandleToSel(word) — 2 bytes — returns selector for handle
  th.register('GlobalHandleToSel', 2, () => emu.readArg16(0), 50);

  // Ordinal 51: GlobalFirst(ptr lpge, word wFlags) — 6 bytes
  th.register('GlobalFirst', 6, () => 0, 51);

  // Ordinal 52: GlobalNext(ptr lpge, word wFlags) — 6 bytes
  th.register('GlobalNext', 6, () => 0, 52);

  // Ordinal 53: GlobalInfo(ptr lpgi) — 4 bytes
  th.register('GlobalInfo', 4, () => 0, 53);

  // Ordinal 54: GlobalEntryHandle(ptr lpge, word hItem) — 6 bytes
  th.register('GlobalEntryHandle', 6, () => 0, 54);

  // Ordinal 55: GlobalEntryModule(ptr lpge, word hModule, word wSeg) — 8 bytes
  th.register('GlobalEntryModule', 8, () => 0, 55);

  // Ordinal 56: LocalInfo(ptr lpli, word hHeap) — 6 bytes
  th.register('LocalInfo', 6, () => 0, 56);

  // Ordinal 57: LocalFirst(ptr lple, word hHeap) — 6 bytes
  th.register('LocalFirst', 6, () => 0, 57);

  // Ordinal 58: LocalNext(ptr lple) — 4 bytes
  th.register('LocalNext', 4, () => 0, 58);

  // Ordinal 59: ModuleFirst(ptr lpme) — 4 bytes
  th.register('ModuleFirst', 4, () => 0, 59);

  // Ordinal 60: ModuleNext(ptr lpme) — 4 bytes
  th.register('ModuleNext', 4, () => 0, 60);

  // Ordinal 61: ModuleFindName(ptr lpme, ptr lpszName) — 8 bytes
  th.register('ModuleFindName', 8, () => 0, 61);

  // Ordinal 62: ModuleFindHandle(ptr lpme, word hModule) — 6 bytes
  th.register('ModuleFindHandle', 6, () => 0, 62);

  // Ordinal 63: TaskFirst(ptr lpte) — 4 bytes
  th.register('TaskFirst', 4, () => 0, 63);

  // Ordinal 64: TaskNext(ptr lpte) — 4 bytes
  th.register('TaskNext', 4, () => 0, 64);

  // Ordinal 65: TaskFindHandle(ptr lpte, word hTask) — 6 bytes
  th.register('TaskFindHandle', 6, () => 0, 65);

  // Ordinal 66: StackTraceFirst(ptr lpste, word hTask) — 6 bytes
  th.register('StackTraceFirst', 6, () => 0, 66);

  // Ordinal 67: StackTraceCSIPFirst(ptr lpste, word ss, word cs, word ip, word bp) — 12 bytes
  th.register('StackTraceCSIPFirst', 12, () => 0, 67);

  // Ordinal 68: StackTraceNext(ptr lpste) — 4 bytes
  th.register('StackTraceNext', 4, () => 0, 68);

  // Ordinal 69: ClassFirst(ptr lpce) — 4 bytes (stub in Wine too)
  th.register('ClassFirst', 4, () => 0, 69);

  // Ordinal 70: ClassNext(ptr lpce) — 4 bytes (stub in Wine too)
  th.register('ClassNext', 4, () => 0, 70);

  // Ordinal 71: SystemHeapInfo(ptr lpshi) — 4 bytes
  th.register('SystemHeapInfo', 4, () => 0, 71);

  // Ordinal 72: MemManInfo(ptr lpmmi) — 4 bytes
  // Apps query free memory; populate a minimal MEMMANINFO so the caller doesn't divide by zero.
  th.register('MemManInfo', 4, () => {
    const lpmmi = emu.resolveFarPtr(emu.readArg16DWord(0));
    if (lpmmi) {
      // MEMMANINFO is 32 bytes:
      //   DWORD dwSize, dwLargestFreeBlock, dwMaxPagesAvailable, dwMaxPagesLockable,
      //         dwTotalLinearSpace, dwTotalUnlockedPages, dwFreePages, dwTotalPages,
      //         dwFreeLinearSpace, dwSwapFilePages
      //   WORD  wPageSize
      emu.memory.writeU32(lpmmi + 0, 32);
      emu.memory.writeU32(lpmmi + 4, 0x100000);  // 1 MB largest free
      emu.memory.writeU32(lpmmi + 8, 0x400);
      emu.memory.writeU32(lpmmi + 12, 0x400);
      emu.memory.writeU32(lpmmi + 16, 0x1000000);
      emu.memory.writeU32(lpmmi + 20, 0x400);
      emu.memory.writeU32(lpmmi + 24, 0x400);
      emu.memory.writeU32(lpmmi + 28, 0x400);
      // Field 9..10 spill past 32 bytes — skip
      return 1;
    }
    return 0;
  }, 72);

  // Ordinal 73: NotifyRegister(word hTask, segptr lpfnCallback, word wFlags) — 8 bytes
  th.register('NotifyRegister', 8, () => 0, 73);

  // Ordinal 74: NotifyUnregister(word hTask) — 2 bytes
  th.register('NotifyUnregister', 2, () => 1, 74);

  // Ordinal 75: InterruptRegister(word hTask, segptr lpfnCallback) — 6 bytes
  th.register('InterruptRegister', 6, () => 0, 75);

  // Ordinal 76: InterruptUnRegister(word hTask) — 2 bytes
  th.register('InterruptUnRegister', 2, () => 1, 76);

  // Ordinal 77: TerminateApp(word hTask, word wFlags) — 4 bytes
  th.register('TerminateApp', 4, () => 0, 77);

  // Ordinal 78: MemoryRead(word wSel, long dwOffset, ptr lpBuffer, long dwBytes) — 14 bytes
  th.register('MemoryRead', 14, () => 0, 78);

  // Ordinal 79: MemoryWrite(word wSel, long dwOffset, ptr lpBuffer, long dwBytes) — 14 bytes
  th.register('MemoryWrite', 14, () => 0, 79);

  // Ordinal 80: TimerCount(ptr lpti) — 4 bytes
  th.register('TimerCount', 4, () => {
    const lpti = emu.resolveFarPtr(emu.readArg16DWord(0));
    if (lpti) {
      // TIMERINFO: DWORD dwSize, DWORD dwmsSinceStart, DWORD dwmsThisVM
      const ms = (typeof performance !== 'undefined' && performance.now)
        ? Math.floor(performance.now())
        : Date.now();
      emu.memory.writeU32(lpti + 0, 12);
      emu.memory.writeU32(lpti + 4, ms >>> 0);
      emu.memory.writeU32(lpti + 8, ms >>> 0);
      return 1;
    }
    return 0;
  }, 80);

  // Ordinal 84: Local32Info(ptr lpl32i, word hHeap) — 6 bytes
  th.register('Local32Info', 6, () => 0, 84);

  // Ordinal 85: Local32First(ptr lpl32e, word hHeap) — 6 bytes
  th.register('Local32First', 6, () => 0, 85);

  // Ordinal 86: Local32Next(ptr lpl32e) — 4 bytes
  th.register('Local32Next', 4, () => 0, 86);
}
