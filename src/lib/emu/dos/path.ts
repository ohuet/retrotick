import type { Emulator } from '../emulator';

/** Resolve a DOS path using per-process current drive/directory. */
export function dosResolvePath(emu: Emulator, input: string): string {
  let p = input.replace(/\//g, '\\');
  p = p.replace(/(?!^)\\\\+/g, '\\');
  let resolved: string;
  if (/^[A-Za-z]:\\/.test(p)) {
    resolved = p;
  } else if (/^[A-Za-z]:$/.test(p)) {
    const drive = p[0].toUpperCase();
    resolved = emu.currentDirs.get(drive) || (drive + ':\\');
  } else if (/^[A-Za-z]:/.test(p) && p[2] !== '\\') {
    const drive = p[0].toUpperCase();
    const rel = p.substring(2);
    const base = emu.currentDirs.get(drive) || (drive + ':\\');
    resolved = base.endsWith('\\') ? base + rel : base + '\\' + rel;
  } else if (p.startsWith('\\')) {
    resolved = emu.currentDrive + ':' + p;
  } else {
    const base = emu.currentDirs.get(emu.currentDrive) || (emu.currentDrive + ':\\');
    resolved = base.endsWith('\\') ? base + p : base + '\\' + p;
  }
  return resolved.toUpperCase();
}
