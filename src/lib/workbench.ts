/**
 * Workbench export/import — packs the entire user environment into a single
 * zip-compressed file so it can be moved between origins (different dev
 * ports) and machines.
 *
 * Bundle contents:
 *   - All IndexedDB stores: filesMeta, filesData, registry, profiles
 *   - All localStorage keys
 *
 * On-disk format: a fflate-produced .zip containing
 *   - manifest.json   — JSON with localStorage, registry, profiles, file index
 *   - files/0000.bin  — raw bytes for each stored file (sequential names avoid
 *                       any path-escaping question for IDB keys with slashes)
 *
 * The async fflate APIs (`zip`, `unzip`) are used instead of the sync versions
 * so compression and decompression run on a Web Worker — the UI thread stays
 * responsive even when bundling several megabytes of binaries.
 */

import { zip, unzip, zipSync, unzipSync, strToU8, strFromU8, type Unzipped } from 'fflate';
import {
  openDB,
  FILES_META_STORE,
  FILES_DATA_STORE,
  REGISTRY_STORE,
  PROFILES_STORE,
} from './idb';

export const WORKBENCH_VERSION = 1;
export const WORKBENCH_EXTENSION = '.workbench';

interface WorkbenchFileEntry {
  name: string;
  size: number;
  addedAt: number;
  archivePath: string;
}

interface WorkbenchManifest {
  version: number;
  exportedAt: string;
  userAgent: string;
  localStorage: Record<string, string>;
  registry: unknown;
  profiles: unknown;
  files: WorkbenchFileEntry[];
}

interface RawFile {
  name: string;
  size: number;
  addedAt: number;
  data: Uint8Array;
}

/** Phase reported by export/import while running. The UI maps this to a label
 *  and uses (current/total) when present to render a progress bar. */
export type WorkbenchProgress =
  | { phase: 'reading'; current: number; total: number }
  | { phase: 'compressing' }
  | { phase: 'finalizing' }
  | { phase: 'loading'; current: number; total: number }
  | { phase: 'decompressing' }
  | { phase: 'restoring'; current: number; total: number };

export type ProgressCallback = (p: WorkbenchProgress) => void;

async function readAllFiles(): Promise<RawFile[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_META_STORE, FILES_DATA_STORE], 'readonly');
    const metaReq = tx.objectStore(FILES_META_STORE).getAll();
    const dataReq = tx.objectStore(FILES_DATA_STORE).getAll();
    tx.oncomplete = () => {
      const metas = metaReq.result as { name: string; size: number; addedAt: number }[];
      const datas = dataReq.result as { name: string; data: ArrayBuffer }[];
      const dataByName = new Map<string, ArrayBuffer>();
      for (const d of datas) dataByName.set(d.name, d.data);
      const out: RawFile[] = metas.map(m => {
        const ab = dataByName.get(m.name) ?? new ArrayBuffer(0);
        return { name: m.name, size: m.size, addedAt: m.addedAt, data: new Uint8Array(ab) };
      });
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function readSingleton(storeName: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get('data');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function readAllLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const val = localStorage.getItem(key);
    if (val !== null) out[key] = val;
  }
  return out;
}

function zipAsync(data: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(data, { level: 6 }, (err, output) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, output) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

/** fflate's async API serializes its input to a Worker via `postMessage`, which
 *  fails with `DataCloneError: out of memory` when the bundle is too large for
 *  V8 to clone twice. In that case we fall back to the synchronous API: the
 *  UI freezes briefly during compression/decompression, but the operation
 *  completes instead of dying with an OOM. */
function isWorkerOOM(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'DataCloneError') return true;
  return /cannot be cloned|out of memory/i.test(err.message);
}

async function zipWithFallback(data: Record<string, Uint8Array>): Promise<Uint8Array> {
  try {
    return await zipAsync(data);
  } catch (err) {
    if (!isWorkerOOM(err)) throw err;
    return zipSync(data, { level: 6 });
  }
}

async function unzipWithFallback(data: Uint8Array): Promise<Unzipped> {
  try {
    return await unzipAsync(data);
  } catch (err) {
    if (!isWorkerOOM(err)) throw err;
    return unzipSync(data);
  }
}

/** Build the workbench archive bytes. The caller is responsible for triggering
 *  a download or any other side-effect. */
export async function exportWorkbench(onProgress?: ProgressCallback): Promise<Uint8Array> {
  onProgress?.({ phase: 'reading', current: 0, total: 1 });
  const [files, registry, profiles] = await Promise.all([
    readAllFiles(),
    readSingleton(REGISTRY_STORE),
    readSingleton(PROFILES_STORE),
  ]);
  onProgress?.({ phase: 'reading', current: files.length, total: files.length });

  const fileEntries: WorkbenchFileEntry[] = files.map((f, i) => ({
    name: f.name,
    size: f.size,
    addedAt: f.addedAt,
    archivePath: `files/${String(i).padStart(4, '0')}.bin`,
  }));

  const manifest: WorkbenchManifest = {
    version: WORKBENCH_VERSION,
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    localStorage: readAllLocalStorage(),
    registry,
    profiles,
    files: fileEntries,
  };

  const archive: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
  };
  for (let i = 0; i < files.length; i++) {
    archive[fileEntries[i].archivePath] = files[i].data;
  }

  onProgress?.({ phase: 'compressing' });
  const out = await zipWithFallback(archive);
  onProgress?.({ phase: 'finalizing' });
  return out;
}

/** Suggest a filename for the exported bundle. */
export function workbenchFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `retrotick-${stamp}${WORKBENCH_EXTENSION}`;
}

/** Trigger a browser download for an exported bundle. */
export function downloadWorkbench(bytes: Uint8Array, fileName = workbenchFileName()): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Open a file picker and resolve with the selected File handle (or null).
 *  Reading the bytes is left to the caller so progress can be displayed. */
export function pickWorkbenchFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${WORKBENCH_EXTENSION},application/zip`;
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ?? null);
    };
    // Cancellation through the OS file picker doesn't fire `change`. Use
    // `cancel` (Chrome 113+, Firefox 91+) when available; fall back to the
    // window focus event so we don't leave the import flow hanging forever.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Read the entire file as a Uint8Array, reporting bytes loaded along the way. */
export function readWorkbenchFile(
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    reader.onload = () => {
      onProgress?.(file.size, file.size);
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/** Replace the entire user environment with the contents of a workbench bundle.
 *  Throws if the bundle is malformed. The caller should reload the page after
 *  this resolves so the new state is picked up everywhere. */
export async function importWorkbench(bytes: Uint8Array, onProgress?: ProgressCallback): Promise<void> {
  onProgress?.({ phase: 'decompressing' });
  const archive = await unzipWithFallback(bytes);
  const manifestBytes = archive['manifest.json'];
  if (!manifestBytes) throw new Error('Invalid workbench: missing manifest.json');

  let manifest: WorkbenchManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new Error('Invalid workbench: manifest.json is not valid JSON');
  }
  if (manifest.version !== WORKBENCH_VERSION) {
    throw new Error(`Unsupported workbench version: ${manifest.version}`);
  }

  onProgress?.({ phase: 'restoring', current: 0, total: manifest.files.length });

  const db = await openDB();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [FILES_META_STORE, FILES_DATA_STORE, REGISTRY_STORE, PROFILES_STORE],
      'readwrite',
    );
    const metaStore = tx.objectStore(FILES_META_STORE);
    const dataStore = tx.objectStore(FILES_DATA_STORE);
    const registryStore = tx.objectStore(REGISTRY_STORE);
    const profilesStore = tx.objectStore(PROFILES_STORE);

    metaStore.clear();
    dataStore.clear();
    registryStore.clear();
    profilesStore.clear();

    let written = 0;
    for (const entry of manifest.files) {
      const data = archive[entry.archivePath];
      if (!data) { written++; continue; }
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      metaStore.put({ name: entry.name, size: entry.size, addedAt: entry.addedAt });
      dataStore.put({ name: entry.name, data: ab });
      written++;
      // Report restore progress every 16 files to avoid flooding the UI.
      if ((written & 0xF) === 0 || written === manifest.files.length) {
        onProgress?.({ phase: 'restoring', current: written, total: manifest.files.length });
      }
    }

    if (manifest.registry !== null && manifest.registry !== undefined) {
      registryStore.put(manifest.registry, 'data');
    }
    if (manifest.profiles !== null && manifest.profiles !== undefined) {
      profilesStore.put(manifest.profiles, 'data');
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Workbench import transaction aborted'));
  });

  localStorage.clear();
  for (const [key, value] of Object.entries(manifest.localStorage)) {
    localStorage.setItem(key, value);
  }
  onProgress?.({ phase: 'finalizing' });
}
