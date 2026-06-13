import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';
import type { NEResourceEntry } from '../../ne-loader';

interface LoadedRes {
  entry: NEResourceEntry;
  ptr: number;  // linear address of resource data in emulated memory
}

export function registerKernelResource(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // Map from FindResource handle → resource entry + source buffer
  const resHandleMap = new Map<number, { entry: NEResourceEntry; buffer: ArrayBuffer }>();
  // Map from LoadResource handle → loaded resource info
  const loadedResMap = new Map<number, LoadedRes>();
  let nextResHandle = 0x100;

  function matches(r: NEResourceEntry, typeId: number, typeName: string | null, resId: number, resName: string | null): boolean {
    if (typeName) {
      if (!r.typeName || r.typeName.toUpperCase() !== typeName.toUpperCase()) return false;
    } else {
      if (r.typeID !== typeId) return false;
    }
    if (resName) return r.name?.toUpperCase() === resName.toUpperCase();
    return r.id === resId;
  }

  function findResEntry(typeId: number, typeName: string | null, resId: number, resName: string | null): { entry: NEResourceEntry; buffer: ArrayBuffer } | undefined {
    if (emu.ne && emu._arrayBuffer) {
      const main = emu.ne.resources.find(r => matches(r, typeId, typeName, resId, resName));
      if (main) return { entry: main, buffer: emu._arrayBuffer };
    }
    // Fall back to runtime-loaded DLL resource tables.
    for (const dllInfo of emu.neDllResources) {
      const hit = dllInfo.resources.find(r => matches(r, typeId, typeName, resId, resName));
      if (hit) return { entry: hit, buffer: dllInfo.arrayBuffer };
    }
    return undefined;
  }

  // --- Ordinal 60: FindResource(hInst, lpName, lpType) — 10 bytes (word+str+str) ---
  kernel.register('FindResource', 10, () => {
    const [hInst, lpName, lpType] = emu.readPascalArgs16([2, 4, 4]);

    // Decode type: high word = 0 → integer type ID (numeric); otherwise far pointer to string.
    const typeSeg = (lpType >>> 16) & 0xFFFF;
    const typeOff = lpType & 0xFFFF;
    let typeId = 0;
    let typeName: string | null = null;
    if (typeSeg === 0) {
      typeId = typeOff;
    } else {
      const base = emu.cpu.segBases.get(typeSeg) ?? (typeSeg << 4);
      typeName = emu.memory.readCString(base + typeOff);
    }

    // Decode name: same convention.
    const nameSeg = (lpName >>> 16) & 0xFFFF;
    const nameOff = lpName & 0xFFFF;
    let resId = 0;
    let resName: string | null = null;
    if (nameSeg === 0) {
      resId = nameOff;
    } else {
      const base = emu.cpu.segBases.get(nameSeg) ?? (nameSeg << 4);
      resName = emu.memory.readCString(base + nameOff);
    }

    const found = findResEntry(typeId, typeName, resId, resName);
    if (!found) {
      console.warn(`[RES16] FindResource: type=${typeName ? `"${typeName}"` : typeId} id=${resId} name=${resName} — not found`);
      return 0;
    }

    const handle = nextResHandle++;
    resHandleMap.set(handle, found);
    console.log(`[RES16] FindResource: type=${typeName ? `"${typeName}"` : typeId} id=${resId} name=${resName} → handle=0x${handle.toString(16)} offset=0x${found.entry.fileOffset.toString(16)} len=${found.entry.length}`);
    return handle;
  }, 60);

  // --- Ordinal 61: LoadResource(hInst, hResInfo) — 4 bytes (word+word) ---
  kernel.register('LoadResource', 4, () => {
    const [hInst, hResInfo] = emu.readPascalArgs16([2, 2]);
    const found = resHandleMap.get(hResInfo);
    if (!found) {
      console.warn(`[RES16] LoadResource: invalid handle 0x${hResInfo.toString(16)}`);
      return 0;
    }

    // Check if already loaded
    const existing = loadedResMap.get(hResInfo);
    if (existing) return hResInfo;

    // Copy resource data from the source DLL/EXE buffer into emulated memory
    const { entry, buffer } = found;
    const ptr = emu.allocHeap(entry.length);
    const src = new Uint8Array(buffer, entry.fileOffset, entry.length);
    for (let i = 0; i < entry.length; i++) {
      emu.memory.writeU8(ptr + i, src[i]);
    }

    loadedResMap.set(hResInfo, { entry, ptr });
    console.log(`[RES16] LoadResource: handle=0x${hResInfo.toString(16)} → ptr=0x${ptr.toString(16)} len=${entry.length}`);
    return hResInfo;
  }, 61);

  // --- Ordinal 62: LockResource(hResData) — 2 bytes (word) ---
  kernel.register('LockResource', 2, () => {
    const hRes = emu.readArg16(0);
    const loaded = loadedResMap.get(hRes);
    if (!loaded) {
      console.warn(`[RES16] LockResource: unknown handle 0x${hRes.toString(16)}`);
      return 0;
    }
    console.log(`[RES16] LockResource: handle=0x${hRes.toString(16)} → ptr=0x${loaded.ptr.toString(16)}`);
    return loaded.ptr;
  }, 62);

  // --- Ordinal 63: FreeResource(hResData) — 2 bytes (word) ---
  kernel.register('FreeResource', 2, () => 0, 63);

  // --- Ordinal 64: AccessResource(word word) — 4 bytes ---
  kernel.register('AccessResource', 4, () => -1, 64);

  // --- Ordinal 65: SizeofResource(word word) — 4 bytes ---
  kernel.register('SizeofResource', 4, () => {
    const [hInst, hResInfo] = emu.readPascalArgs16([2, 2]);
    const found = resHandleMap.get(hResInfo);
    return found ? found.entry.length : 0;
  }, 65);

  // --- Ordinal 66: AllocResource(word word long) — 8 bytes (word+word+long) ---
  kernel.register('AllocResource', 8, () => 0, 66);

  // --- Ordinal 67: SetResourceHandler(word str segptr) — 10 bytes (word+str+segptr) ---
  kernel.register('SetResourceHandler', 10, () => 0, 67);
}
