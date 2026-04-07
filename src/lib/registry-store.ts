export interface RegistryValue {
  type: number; // REG_SZ=1, REG_EXPAND_SZ=2, REG_BINARY=3, REG_DWORD=4, REG_MULTI_SZ=7
  data: Uint8Array;
}

export interface RegistryKey {
  values: Map<string, RegistryValue>;
  subKeys: Set<string>;
}

// Predefined root key handles
const HKEY_CLASSES_ROOT = 0x80000000;
const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const HKEY_USERS = 0x80000003;
const HKEY_CURRENT_CONFIG = 0x80000005;
const HKEY_DYN_DATA = 0x80000006;

const ROOT_HANDLES = new Map<number, string>([
  [HKEY_CLASSES_ROOT, 'hkey_classes_root'],
  [HKEY_CURRENT_USER, 'hkey_current_user'],
  [HKEY_LOCAL_MACHINE, 'hkey_local_machine'],
  [HKEY_USERS, 'hkey_users'],
  [HKEY_CURRENT_CONFIG, 'hkey_current_config'],
  [HKEY_DYN_DATA, 'hkey_dyn_data'],
  // Win16 uses small integer handles for root keys (HKEY_CLASSES_ROOT = 1)
  [1, 'hkey_classes_root'],
]);

const REG_CREATED_NEW_KEY = 1;
const REG_OPENED_EXISTING_KEY = 2;

export class RegistryStore {
  private keys = new Map<string, RegistryKey>();
  private handleToPath = new Map<number, string>();
  private nextHandle = 0x2000;
  onChange?: () => void;

  constructor() {
    // Ensure root keys exist
    for (const path of ROOT_HANDLES.values()) {
      this.ensureKey(path);
    }
  }

  private normalize(path: string): string {
    return path.toLowerCase().replace(/\/+/g, '\\').replace(/\\+$/, '');
  }

  private ensureKey(path: string): RegistryKey {
    let key = this.keys.get(path);
    if (!key) {
      key = { values: new Map(), subKeys: new Set() };
      this.keys.set(path, key);
    }
    return key;
  }

  private resolveParent(hKey: number): string | null {
    const root = ROOT_HANDLES.get(hKey >>> 0);
    if (root) return root;
    return this.handleToPath.get(hKey) ?? null;
  }

  private allocHandle(path: string): number {
    const h = this.nextHandle++;
    this.handleToPath.set(h, path);
    return h;
  }

  createKey(hParent: number, subKey: string): { handle: number; disposition: number } | null {
    const parentPath = this.resolveParent(hParent);
    if (parentPath === null) return null;
    const fullPath = subKey ? this.normalize(parentPath + '\\' + subKey) : parentPath;

    const existed = this.keys.has(fullPath);
    this.ensureKey(fullPath);

    // Ensure all intermediate keys exist and register subkey relationships
    if (subKey) {
      const parts = this.normalize(subKey).split('\\');
      let current = parentPath;
      for (const part of parts) {
        const parentKey = this.ensureKey(current);
        const next = current + '\\' + part;
        parentKey.subKeys.add(part);
        this.ensureKey(next);
        current = next;
      }
    }

    this.onChange?.();
    return {
      handle: this.allocHandle(fullPath),
      disposition: existed ? REG_OPENED_EXISTING_KEY : REG_CREATED_NEW_KEY,
    };
  }

  openKey(hParent: number, subKey: string): number | null {
    const parentPath = this.resolveParent(hParent);
    if (parentPath === null) return null;
    const fullPath = subKey ? this.normalize(parentPath + '\\' + subKey) : parentPath;
    if (!this.keys.has(fullPath)) return null;
    return this.allocHandle(fullPath);
  }

  closeKey(handle: number): void {
    this.handleToPath.delete(handle);
  }

  setValue(handle: number, name: string, type: number, data: Uint8Array): boolean {
    const path = this.resolveParent(handle);
    if (path === null) return false;
    const key = this.keys.get(path);
    if (!key) return false;
    key.values.set(name.toLowerCase(), { type, data: new Uint8Array(data) });
    this.onChange?.();
    return true;
  }

  queryValue(handle: number, name: string): RegistryValue | null {
    const path = this.resolveParent(handle);
    if (path === null) return null;
    const key = this.keys.get(path);
    if (!key) return null;
    return key.values.get(name.toLowerCase()) ?? null;
  }

  deleteValue(handle: number, name: string): boolean {
    const path = this.resolveParent(handle);
    if (path === null) return false;
    const key = this.keys.get(path);
    if (!key) return false;
    const deleted = key.values.delete(name.toLowerCase());
    if (deleted) this.onChange?.();
    return deleted;
  }

  deleteKey(hParent: number, subKey: string): boolean {
    const parentPath = this.resolveParent(hParent);
    if (parentPath === null) return false;
    const fullPath = this.normalize(parentPath + '\\' + subKey);
    const key = this.keys.get(fullPath);
    if (!key) return false;
    // Windows doesn't allow deleting keys with subkeys
    if (key.subKeys.size > 0) return false;
    this.keys.delete(fullPath);
    // Remove from parent's subKeys
    const parent = this.keys.get(parentPath);
    if (parent) {
      const lastPart = this.normalize(subKey).split('\\').pop()!;
      parent.subKeys.delete(lastPart);
    }
    this.onChange?.();
    return true;
  }

  enumKey(handle: number, index: number): string | null {
    const path = this.resolveParent(handle);
    if (path === null) return null;
    const key = this.keys.get(path);
    if (!key) return null;
    const arr = Array.from(key.subKeys);
    return index < arr.length ? arr[index] : null;
  }

  enumValue(handle: number, index: number): { name: string; type: number; data: Uint8Array } | null {
    const path = this.resolveParent(handle);
    if (path === null) return null;
    const key = this.keys.get(path);
    if (!key) return null;
    const entries = Array.from(key.values.entries());
    if (index >= entries.length) return null;
    const [name, val] = entries[index];
    return { name, type: val.type, data: val.data };
  }

  // Serialization for IndexedDB persistence
  serialize(): object {
    const result: Record<string, { values: [string, { type: number; data: number[] }][]; subKeys: string[] }> = {};
    for (const [path, key] of this.keys) {
      const values: [string, { type: number; data: number[] }][] = [];
      for (const [name, val] of key.values) {
        values.push([name, { type: val.type, data: Array.from(val.data) }]);
      }
      result[path] = { values, subKeys: Array.from(key.subKeys) };
    }
    return result;
  }

  deserialize(obj: unknown): void {
    this.keys.clear();
    if (!obj || typeof obj !== 'object') return;
    for (const [path, entry] of Object.entries(obj) as [string, { values?: [string, { type: number; data: number[] }][]; subKeys?: string[] }][]) {
      const values = new Map<string, RegistryValue>();
      if (Array.isArray(entry.values)) {
        for (const [name, val] of entry.values) {
          values.set(name, { type: val.type, data: new Uint8Array(val.data) });
        }
      }
      const subKeys = new Set<string>(entry.subKeys || []);
      this.keys.set(path, { values, subKeys });
    }
    // Ensure root keys exist
    for (const path of ROOT_HANDLES.values()) {
      this.ensureKey(path);
    }
  }
}
