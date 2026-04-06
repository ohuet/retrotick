/** DOS emulator settings — persisted in localStorage. */

export interface DosSettings {
  /** Text mode renderer: 'dom' allows text selection, 'canvas' eliminates
   *  sub-pixel rendering artifacts in Chrome but disables text selection. */
  textRenderer: 'dom' | 'canvas';
  /** Enable experimental WASM JIT compiler for DOS programs. */
  jitEnabled: boolean;
  /** DPMI 0.9 host (for programs using DPMI directly or via CWSDPMI). */
  dpmi: boolean;
  /** XMS driver (extended memory above 1MB). */
  xms: boolean;
  /** EMS/VCPI driver (expanded memory + V86 PM interface). */
  ems: boolean;
  /** Sound Blaster emulation. */
  soundBlaster: boolean;
  /** AdLib FM synthesis. */
  adlib: boolean;
  /** Gravis UltraSound emulation. */
  gus: boolean;
}

const STORAGE_KEY = 'retrotick-dos';

const DEFAULTS: DosSettings = {
  textRenderer: 'dom',
  jitEnabled: false,
  dpmi: true,
  xms: true,
  ems: true,
  soundBlaster: true,
  adlib: true,
  gus: true,
};

export function loadDosSettings(): DosSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULTS };
}

export function saveDosSettings(settings: DosSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent('retrotick-settings-changed'));
}
