import type { Emulator, Win16Module } from '../../emulator';
import type { Win16UserHelpers } from './index';

// Win16 USER module — Resource loading

export function registerWin16UserResource(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 173: LoadCursor(hInstance, lpCursorName_ptr) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_173', 6, () => 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 174: LoadIcon(hInstance, lpIconName_ptr) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_174', 6, () => {
    const [hInstance, lpIconName] = emu.readPascalArgs16([2, 4]);
    const iconId = lpIconName < 0x10000 ? lpIconName : 0;
    if (iconId) {
      const hIcon = emu.loadIconResource(iconId);
      if (hIcon) return hIcon;
    }
    return 1; // fallback handle
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 175: LoadBitmap(hInstance, lpBitmapName_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_175', 6, () => {
    const [hInstance, lpBitmapName] = emu.readPascalArgs16([2, 4]);
    const seg = (lpBitmapName >>> 16) & 0xFFFF;
    const off = lpBitmapName & 0xFFFF;
    if (seg === 0) {
      // Integer resource ID
      console.log(`[WIN16] LoadBitmap hInst=0x${hInstance.toString(16)} id=${off}`);
      return emu.loadBitmapResource(off) || off || 1;
    } else {
      // Far pointer to string name
      const linear = emu.resolveFarPtr(lpBitmapName);
      const name = emu.memory.readCString(linear);
      console.log(`[WIN16] LoadBitmap hInst=0x${hInstance.toString(16)} name="${name}"`);
      return emu.loadBitmapResourceByName(name) || 1;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 176: LoadString(hInstance, uID, lpBuffer_ptr, nBufferMax) — 10 bytes (2+2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_176', 10, () => {
    const [hInstance, uID, lpBuffer, nBufferMax] = emu.readPascalArgs16([2, 2, 4, 2]);
    const str = emu.loadNEString(uID);
    console.log(`[WIN16] LoadString id=${uID} → "${str}" (maxLen=${nBufferMax})`);
    if (lpBuffer && nBufferMax > 0) {
      const maxCopy = Math.min(str.length, nBufferMax - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(lpBuffer + i, str.charCodeAt(i));
      }
      emu.memory.writeU8(lpBuffer + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 177: LoadAccelerators(hInstance, lpTableName) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_177', 6, () => 1);
}
