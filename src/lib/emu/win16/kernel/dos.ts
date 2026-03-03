import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';
import { handleInt21 } from '../../dos/int21';

export function registerKernelDos(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  const fs = emu.fs;

  // --- Ordinal 3: GetVersion() — 0 bytes ---
  kernel.register('ord_3', 0, () => 0x0A03);

  // --- Ordinal 39: GetTickCount() — 0 bytes ---
  kernel.register('ord_39', 0, () => Date.now() & 0xFFFFFFFF);

  // --- Ordinal 41: EnableDos() — 0 bytes ---
  kernel.register('ord_41', 0, () => 0);

  // --- Ordinal 42: DisableDos() — 0 bytes ---
  kernel.register('ord_42', 0, () => 0);

  // --- Ordinal 92: GetTempDrive(word) — 2 bytes ---
  kernel.register('ord_92', 2, () => 0x43); // 'C'

  // --- Ordinal 102: DOS3Call() — 0 bytes, register-based ---
  // Delegates to the shared INT 21h handler in dos-int.ts
  kernel.register('ord_102', 0, () => {
    handleInt21(emu.cpu, emu);
    return 0;
  });

  // --- Ordinal 105: GetExeVersion() — 0 bytes ---
  kernel.register('ord_105', 0, () => 0x030A);

  // --- Ordinal 131: GetDOSEnvironment() — 0 bytes ---
  kernel.register('ord_131', 0, () => {
    const envAddr = emu.allocHeap(4);
    emu.memory.writeU8(envAddr, 0);
    emu.memory.writeU8(envAddr + 1, 0);
    const seg = emu.cpu.ds;
    emu.cpu.setReg16(2, seg);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (envAddr & 0xFFFF);
    return (seg << 16) | (envAddr & 0xFFFF);
  });

  // --- Ordinal 132: GetWinFlags() — 0 bytes ---
  kernel.register('ord_132', 0, () => 0x0413);

  // --- Ordinal 134: GetWindowsDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('ord_134', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS';
    const buf = emu.resolveFarPtr(lpBuffer);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(buf + i, dir.charCodeAt(i));
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 135: GetSystemDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('ord_135', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS\\SYSTEM';
    const buf = emu.resolveFarPtr(lpBuffer);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(buf + i, dir.charCodeAt(i));
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 136: GetDriveType(nDrive) — 2 bytes (word) ---
  kernel.register('ord_136', 2, () => 3); // DRIVE_FIXED

  // --- Ordinal 167: GetExpWinVer(word) — 2 bytes ---
  kernel.register('ord_167', 2, () => 0x030A);
}
