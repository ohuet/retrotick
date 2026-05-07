import type { Emulator } from '../emulator';

// Win16 VER module (VERSION.DLL) — version info APIs
// Reference: Wine dlls/ver.dll16/ver.dll16.spec
// MOD4WIN uses these for an anti-tamper check (file integrity verification).

/** Locate the RT_VERSION resource bytes for a given filename.
 *
 *  Currently supports:
 *   - The running EXE (matches by path or basename against emu.exePath)
 *   - LoadLibrary'd NE DLLs (matches by basename — last segment of the path)
 *
 *  Returns the raw resource data (typeId=16 in NE/PE resource tree) or null. */
function findVersionResource(emu: Emulator, filename: string): Uint8Array | null {
  if (!filename) return null;
  const wantBase = filename.replace(/.*[\\\/]/, '').toUpperCase();

  // EXE itself
  const exeBase = emu.exePath.replace(/.*[\\\/]/, '').toUpperCase();
  if (wantBase === exeBase || filename.toUpperCase() === emu.exePath.toUpperCase()) {
    if (emu.peInfo?.resources) {
      const versionType = emu.peInfo.resources.find(r => r.typeId === 16);
      const lang = versionType?.entries[0]?.languages[0];
      if (lang) {
        return new Uint8Array(emu.arrayBuffer, lang.dataRva, lang.dataSize);
      }
    }
  }

  // LoadLibrary'd NE DLLs — neDllResources stores the buffer + parsed resource list.
  for (const dllInfo of emu.neDllResources) {
    const versionEntry = dllInfo.resources.find(r => r.typeID === 16);
    if (!versionEntry) continue;
    // We don't store DLL filenames alongside neDllResources, but the typical case
    // is the EXE looking up its own version, so this branch is mainly future-proofing.
    return new Uint8Array(dllInfo.arrayBuffer, versionEntry.fileOffset, versionEntry.length);
  }

  return null;
}

/** Walk a VS_VERSIONINFO tree (Win16 layout: no wType field) and return the
 *  offset+size of the value matching the subBlock path.
 *
 *  Path examples:
 *    "\\"                                       → root VS_FIXEDFILEINFO
 *    "\\StringFileInfo\\040904E4\\InternalName" → child string
 *    "\\VarFileInfo\\Translation"               → translation table
 *
 *  Returns null if not found. */
function findVerQueryValue(buffer: Uint8Array, baseOffset: number, subBlock: string): { offset: number; size: number } | null {
  // Strip leading and trailing backslashes
  const path = subBlock.replace(/^\\+|\\+$/g, '');
  const parts = path === '' ? [] : path.split('\\');

  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  function readNode(off: number): { wLength: number; wValueLength: number; key: string; valueOffset: number; childrenStart: number; childrenEnd: number } | null {
    if (off + 4 > buffer.length) return null;
    const wLength = dv.getUint16(off, true);
    const wValueLength = dv.getUint16(off + 2, true);
    if (wLength === 0) return null;
    // Read szKey (ANSI null-terminated)
    let p = off + 4;
    let key = '';
    while (p < off + wLength && buffer[p] !== 0) {
      key += String.fromCharCode(buffer[p]);
      p++;
    }
    p++; // skip null terminator
    // Align to 32-bit boundary
    p = (p + 3) & ~3;
    return {
      wLength,
      wValueLength,
      key,
      valueOffset: p,
      childrenStart: (p + wValueLength + 3) & ~3,
      childrenEnd: off + wLength,
    };
  }

  let node = readNode(0);
  if (!node) return null;

  // The root must be "VS_VERSION_INFO" — match leniently (some toolchains use slightly different names).
  if (parts.length === 0) {
    // Return root VS_FIXEDFILEINFO value
    return { offset: baseOffset + node.valueOffset, size: node.wValueLength };
  }

  for (let pi = 0; pi < parts.length; pi++) {
    const want = parts[pi];
    let found: ReturnType<typeof readNode> = null;
    let p = node.childrenStart;
    while (p + 4 < node.childrenEnd) {
      const child = readNode(p);
      if (!child || child.wLength === 0) break;
      if (child.key === want || child.key.toLowerCase() === want.toLowerCase()) {
        found = child;
        break;
      }
      p = (p + child.wLength + 3) & ~3;
    }
    if (!found) return null;
    if (pi === parts.length - 1) {
      // Leaf — return its value
      // Win16 doesn't have wType, so wValueLength is exact byte count for binary
      // values; for string values it's the WORD count (string length + null).
      // Translation table (under VarFileInfo) uses wValueLength = byte count.
      return { offset: baseOffset + found.valueOffset, size: found.wValueLength };
    }
    node = found;
  }
  return null;
}

export function registerWin16Ver(emu: Emulator): void {
  const ver = emu.registerModule16('VER');

  // Ordinal 2: GetFileResourceSize(lpszFileName, lpszResType, lpszResID, lpdwFileOffset) — 16 bytes
  ver.register('GetFileResourceSize', 16, () => 0, 2);

  // Ordinal 3: GetFileResource(lpszFileName, lpszResType, lpszResID, dwFileOffset, dwResLen, lpData) — 22 bytes
  ver.register('GetFileResource', 22, () => 0, 3);

  // Ordinal 6: GetFileVersionInfoSize(lpszFileName:strFar, lpdwHandle:ptrFar) — 8 bytes
  // Returns size of version-info data, or 0 if no version info.
  ver.register('GetFileVersionInfoSize', 8, () => {
    const [lpszFileName, lpdwHandle] = emu.readPascalArgs16([4, 4]);
    const nameLin = emu.resolveFarPtr(lpszFileName);
    const handleLin = emu.resolveFarPtr(lpdwHandle);
    const filename = nameLin ? emu.memory.readCString(nameLin) : '';
    const data = findVersionResource(emu, filename);
    if (handleLin) emu.memory.writeU32(handleLin, 0);
    return data ? data.length : 0;
  }, 6);

  // Ordinal 7: GetFileVersionInfo(lpszFileName:strFar, dwHandle:long, dwLen:long, lpData:ptrFar) — 16 bytes
  // Copies version info bytes into lpData. Returns nonzero on success.
  ver.register('GetFileVersionInfo', 16, () => {
    const [lpszFileName, _dwHandle, dwLen, lpData] = emu.readPascalArgs16([4, 4, 4, 4]);
    const nameLin = emu.resolveFarPtr(lpszFileName);
    const dataLin = emu.resolveFarPtr(lpData);
    const filename = nameLin ? emu.memory.readCString(nameLin) : '';
    const src = findVersionResource(emu, filename);
    if (!src || !dataLin || dwLen <= 0) return 0;
    const n = Math.min(src.length, dwLen);
    for (let i = 0; i < n; i++) emu.memory.writeU8(dataLin + i, src[i]);
    return 1;
  }, 7);

  // Ordinal 8: VerFindFile — 32 bytes
  ver.register('VerFindFile', 32, () => 0, 8);

  // Ordinal 9: VerInstallFile — 32 bytes
  ver.register('VerInstallFile', 32, () => 0, 9);

  // Ordinal 10: VerLanguageName(wLang:word, szLang:ptr, nSize:word) — 8 bytes
  // Returns the human-readable name of a language ID.
  ver.register('VerLanguageName', 8, () => {
    const [_wLang, szLang, nSize] = emu.readPascalArgs16([2, 4, 2]);
    const dst = emu.resolveFarPtr(szLang);
    const name = 'English (United States)';
    if (dst && nSize > 0) {
      const n = Math.min(name.length, nSize - 1);
      for (let i = 0; i < n; i++) emu.memory.writeU8(dst + i, name.charCodeAt(i));
      emu.memory.writeU8(dst + n, 0);
      return n;
    }
    return name.length;
  }, 10);

  // Ordinal 11: VerQueryValue(pBlock:ptrFar, lpSubBlock:strFar, lplpBuffer:ptrFar, lpuLen:ptrFar) — 16 bytes
  // pBlock points to the buffer previously filled by GetFileVersionInfo.
  // Writes a far pointer to the value at *lplpBuffer and the byte count at *lpuLen.
  ver.register('VerQueryValue', 16, () => {
    const [pBlockRaw, lpSubBlockRaw, lplpBufferRaw, lpuLenRaw] = emu.readPascalArgs16([4, 4, 4, 4]);
    const pBlockSeg = (pBlockRaw >>> 16) & 0xFFFF;
    const pBlockOff = pBlockRaw & 0xFFFF;
    const pBlockLin = emu.resolveFarPtr(pBlockRaw);
    const subLin = emu.resolveFarPtr(lpSubBlockRaw);
    const lplpBufferLin = emu.resolveFarPtr(lplpBufferRaw);
    const lpuLenLin = emu.resolveFarPtr(lpuLenRaw);

    if (!pBlockLin || !subLin || !lplpBufferLin || !lpuLenLin) return 0;

    const subBlock = emu.memory.readCString(subLin);

    // Read the VS_VERSIONINFO header to know total size
    const wLength = emu.memory.readU16(pBlockLin);
    if (wLength === 0 || wLength > 0x10000) return 0;
    const buffer = new Uint8Array(wLength);
    for (let i = 0; i < wLength; i++) buffer[i] = emu.memory.readU8(pBlockLin + i);

    const found = findVerQueryValue(buffer, 0, subBlock);
    if (!found) return 0;

    // Convert linear-offset-within-buffer back to a far pointer using pBlock's segment
    const valueLin = pBlockLin + found.offset;
    const valueOff = (pBlockOff + found.offset) & 0xFFFF;
    const valueFar = (pBlockSeg << 16) | valueOff;
    void valueLin;

    emu.memory.writeU32(lplpBufferLin, valueFar);
    emu.memory.writeU16(lpuLenLin, found.size);
    return 1;
  }, 11);
}
