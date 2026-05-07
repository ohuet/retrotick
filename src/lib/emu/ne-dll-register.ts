import type { Emulator } from './emulator';
import { loadNE } from './ne-loader';
import type { LoadedNE } from './ne-loader';
import { buildNEThunkTable } from './emu-thunks-ne';

/** NE modules implemented as JS stubs — never loaded as separate DLL files. */
export const NE_BUILTIN_MODULES = new Set<string>([
  'KERNEL', 'USER', 'GDI', 'KEYBOARD', 'WIN87EM',
  'SHELL', 'COMMDLG', 'DDEML', 'MMSYSTEM', 'LZEXPAND',
  'SOUND', 'VER', 'TOOLHELP',
]);

/**
 * Load an NE DLL buffer into emulator memory and register its segments,
 * thunks, resources, and exe→DLL imports.
 *
 * Shared by:
 *  - emu-load.ts loadNEDlls() — pre-loading DLLs at program startup
 *  - win16/kernel/module.ts LoadLibrary — runtime DLL loading
 *
 * Returns the LoadedNE for the caller (entry point, data seg, etc.).
 */
export function registerLoadedNeDll(
  emu: Emulator,
  dllBuf: ArrayBuffer,
  modName: string,
): LoadedNE | null {
  const ne = emu.ne;
  if (!ne) return null;

  const dll = loadNE(dllBuf, emu.memory, {
    selectorBase: ne.nextSelector,
    thunkStartAddr: ne.thunkAddrEnd,
    selectorToBase: ne.selectorToBase,
  });

  ne.nextSelector = dll.nextSelector;
  ne.thunkAddrEnd = dll.thunkAddrEnd;

  if (dll.resources.length > 0) {
    emu.neDllResources.push({ resources: dll.resources, arrayBuffer: dllBuf });
  }

  if (dll.dataSegSelector && dll.autoDataStaticSize > 0) {
    emu.segStaticEnd.set(dll.dataSegSelector, dll.autoDataStaticSize);
  }

  if (dll.dataSegSelector) {
    emu.neDllDataSegs.add(dll.dataSegSelector);
  }

  for (const [addr, info] of dll.apiMap) {
    ne.apiMap.set(addr, info);
  }

  for (const seg of dll.segments) {
    ne.segments.push(seg);
    emu.cpu.segLimits.set(seg.selector, seg.minAlloc - 1);
  }

  // Register newly added thunks (the DLL's own imports of KERNEL/USER/etc.)
  // so the thunk dispatcher can find their handlers.
  buildNEThunkTable(emu);
  // Refresh the thunk page set so the new thunk addresses are dispatched.
  emu.thunkPages.clear();
  for (const addr of emu.thunkToApi.keys()) emu.thunkPages.add(addr >>> 12);

  console.log(`[NE DLL] ${modName}: ${dll.segments.length} segments, ${dll.entryPoints.size} exports, ${dll.apiMap.size} imports`);

  return dll;
}

/**
 * Resolve exe→DLL imports referenced by name/ordinal in the main NE's apiMap.
 * Each resolved import becomes a thunk handler that does a FAR JMP into the
 * DLL's actual code, transferring control to its exported function.
 *
 * Called both at startup (after all referenced DLLs are loaded) and after a
 * runtime LoadLibrary, since the newly loaded DLL may satisfy imports that
 * were previously left as "unimplemented".
 */
export function resolveExeToDllImports(
  emu: Emulator,
  loadedDlls: Map<string, LoadedNE>,
): number {
  const ne = emu.ne;
  if (!ne) return 0;

  let resolved = 0;
  for (const [, info] of ne.apiMap) {
    const dll = loadedDlls.get(info.dll);
    if (!dll) continue;

    let ordinal = info.ordinal;
    if (ordinal === 0 && info.name) {
      const r = dll.nameToOrdinal.get(info.name.toUpperCase());
      if (r !== undefined) ordinal = r;
    }
    const entry = dll.entryPoints.get(ordinal);
    if (!entry) {
      console.warn(`[NE DLL] ${info.dll}:ord_${info.ordinal} not found in DLL entry table`);
      continue;
    }

    const seg = dll.segments[entry.seg - 1];
    if (!seg) {
      console.warn(`[NE DLL] ${info.dll}:ord_${info.ordinal} references invalid segment ${entry.seg}`);
      continue;
    }

    const linearAddr = seg.linearBase + entry.offset;
    const targetSelector = seg.selector;

    const key = `${info.dll}:${info.name}`;
    emu.apiDefs.set(key, {
      handler: () => {
        emu.cpu.cs = targetSelector;
        emu.cpu.eip = linearAddr;
        return undefined;
      },
      stackBytes: 0,
    });

    resolved++;
  }

  return resolved;
}
