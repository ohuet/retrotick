import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
import type { PEInfo, MenuResult } from '../lib/pe/types';
import { parsePE, parseCOM, extractMenus, extractIcons } from '../lib/pe';
import { Emulator } from '../lib/emu/emulator';
import type { DialogInfo, ControlOverlay, ProcessRegistry, CommonDialogRequest } from '../lib/emu/emulator';
import type { WindowInfo } from '../lib/emu/win32/user32/index';
import { WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_MOUSEMOVE, WM_LBUTTONDBLCLK, WM_RBUTTONDBLCLK, WM_COMMAND, WM_SYSCOMMAND, WM_SIZE, WM_GETMINMAXINFO, WM_KEYDOWN, WM_KEYUP, WM_CHAR, MK_LBUTTON, MK_RBUTTON, SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE, SC_CLOSE } from '../lib/emu/win32/types';
import { MessageBox, MsgBoxIcon, MB_ICONERROR } from './win2k/MessageBox';
import { MenuBar } from './win2k/MenuBar';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, getBorderWidth } from './win2k/Window';
import { AboutDialog } from './win2k/AboutDialog';
import { ConsoleView } from './ConsoleView';
import { renderControlOverlay } from './ControlOverlay';
import { EmulatorDialog } from './EmulatorDialog';
import { FindDialog } from './FindDialog';
import { getAllFiles, getFile, addFile, deleteFile } from '../lib/file-store';
import { RegistryStore } from '../lib/registry-store';
import { loadRegistry, saveRegistry } from '../lib/registry-db';
import { detectPELanguageId, langToHtmlLang } from '../lib/lang';
import { loadSettings, getKeyboardLayout, t } from '../lib/regional-settings';

interface EmulatorViewProps {
  arrayBuffer: ArrayBuffer;
  peInfo: PEInfo;
  additionalFiles?: Map<string, ArrayBuffer>;
  exeName: string;
  commandLine?: string;
  onStop: () => void;
  onFocus?: () => void;
  onReady?: () => void;
  onRunExe?: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles?: Map<string, ArrayBuffer>, exeName?: string, commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => void;
  onSetupEmulator?: (emu: Emulator) => void;
  audioContext?: AudioContext | null;
  onTitleChange?: (title: string) => void;
  onIconChange?: (iconUrl: string | null) => void;
  onMinimize?: () => void;
  onRegisterCloseHandler?: (handler: () => void) => void;
  processRegistry?: ProcessRegistry;
  zIndex?: number;
  focused?: boolean;
  minimized?: boolean;
}

function buildMKFlags(e: PointerEvent): number {
  let flags = 0;
  if (e.buttons & 1) flags |= MK_LBUTTON;
  if (e.buttons & 2) flags |= MK_RBUTTON;
  return flags;
}

function makeLParam(x: number, y: number): number {
  return ((y & 0xFFFF) << 16) | (x & 0xFFFF);
}

// Map DOM key codes to Windows virtual key codes (dynamic, based on regional settings)
function getKeyToVK(): Record<string, number> {
  const settings = loadSettings();
  return getKeyboardLayout(settings.keyboardLayout).codeToVK;
}



// --- Main EmulatorView ---
// (Dialog, FindDialog, and renderControlOverlay have been moved to separate files)

export function EmulatorView({ arrayBuffer, peInfo, additionalFiles, exeName, commandLine, onStop, onFocus, onReady, onRunExe, onSetupEmulator, audioContext: sharedAudioContext, onTitleChange, onIconChange, onMinimize, onRegisterCloseHandler, processRegistry, zIndex = 100, focused = true, minimized: minimizedProp }: EmulatorViewProps) {
  const exeBaseName = exeName.split(/[/\\]/).pop() || exeName;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const emuRef = useRef<Emulator | null>(null);
  const [menus, setMenus] = useState<MenuResult[]>([]);
  const detectedLang = langToHtmlLang(detectPELanguageId(peInfo.resources)) || undefined;
  const [windowTitle, setWindowTitle] = useState('');
  const [windowStyle, setWindowStyle] = useState(0x00CF0000); // WS_OVERLAPPEDWINDOW
  const [canvasSize, setCanvasSize] = useState({ w: 320, h: 240 });
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [dialogInfo, setDialogInfo] = useState<EmulatorDialogInfo | null>(null);
  const [controlOverlays, setControlOverlays] = useState<ControlOverlay[]>([]);
  const [pressedControl, setPressedControl] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [windowPos, setWindowPos] = useState({ x: 40, y: 10 });
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const windowPosInitialized = useRef(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const mouseIsDown = useRef(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const [resetCount, setResetCount] = useState(0);
  const [windowReady, setWindowReady] = useState(false);
  const [hasMainWindow, setHasMainWindow] = useState(false);
  const [isConsole, setIsConsole] = useState(false);
  const [crashInfo, setCrashInfo] = useState<{ eip: string; description: string } | null>(null);
  const [messageBoxes, setMessageBoxes] = useState<{ id: number; caption: string; text: string; type: number; isExit?: boolean }[]>([]);
  const [commonDialog, setCommonDialog] = useState<CommonDialogRequest | null>(null);
  const [findTerm, setFindTerm] = useState('');
  const [modalFlashTrigger, setModalFlashTrigger] = useState(0);
  const flashModal = useCallback(() => setModalFlashTrigger(c => c + 1), []);

  // When restored from taskbar, send SC_RESTORE to the emulator
  const prevMinimized = useRef(minimizedProp);
  useEffect(() => {
    if (prevMinimized.current && !minimizedProp) {
      const emu = emuRef.current;
      if (emu?.mainWindow) {
        emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      }
    }
    prevMinimized.current = minimizedProp;
  }, [minimizedProp]);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Reset all UI state on restart
    setMenus([]);
    setControlOverlays([]);
    setDialogInfo(null);
    setWindowTitle('');
    setWindowPos({ x: 40, y: 10 });
    setMinimized(false);
    setMaximized(false);
    setWindowReady(false);
    setHasMainWindow(false);
    setCrashInfo(null);
    setMessageBoxes([]);
    preMaxState.current = null;

    const canvas = canvasRef.current;
    const emu = new Emulator();
    emu.configuredLcid = loadSettings().localeId;

    // Async init for registry, then start emulator
    let regFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const initAndRun = async () => {
      // Set up registry store with IndexedDB persistence
      const regStore = new RegistryStore();
      try {
        const saved = await loadRegistry();
        if (saved) regStore.deserialize(saved);
      } catch (e) {
        console.warn('[REG] Failed to load registry from IndexedDB:', e);
      }
      regStore.onChange = () => {
        if (regFlushTimer !== null) clearTimeout(regFlushTimer);
        regFlushTimer = setTimeout(() => {
          saveRegistry(regStore.serialize()).catch(e =>
            console.warn('[REG] Failed to save registry:', e)
          );
        }, 500);
      };
      emu.registryStore = regStore;
    };

    try {
      const extractedMenus = extractMenus(peInfo, arrayBuffer);
      setMenus(extractedMenus);
      // Expose menu items to emulator for CheckMenuItem/EnableMenuItem
      if (extractedMenus.length > 0) {
        emu.menuItems = extractedMenus[0].menu.items;
      }

      // Extract the first app icon for the title bar
      const icons = extractIcons(peInfo, arrayBuffer);
      if (icons.length > 0) {
        const url = URL.createObjectURL(icons[0].blob);
        setIconUrl(url);
        onIconChange?.(url);
      }

      if (additionalFiles) {
        for (const [name, data] of additionalFiles) {
          emu.additionalFiles.set(name, data);
        }
      }

      if (commandLine) emu.commandLine = commandLine;
      emu.exeName = exeName;
      if (processRegistry) {
        emu.processRegistry = processRegistry;
        processRegistry.register(emu, exeName);
      }
      emu.screenWidth = window.innerWidth;
      emu.screenHeight = window.innerHeight;
      onSetupEmulator?.(emu);

      emu.load(arrayBuffer, peInfo, canvas);
      emuRef.current = emu;
      onRegisterCloseHandler?.(() => {
        if (emu.mainWindow) {
          emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_CLOSE, 0);
        } else {
          onStop();
        }
      });

      // Assign shared AudioContext — created in App during user gesture
      if (sharedAudioContext) {
        emu.audioContext = sharedAudioContext;
        if (emu.isDOS) emu.dosAudio.init(sharedAudioContext);
      }

      // Console app detection
      if (emu.isConsole) {
        setIsConsole(true);
        setWindowReady(true);
        if (!emu.consoleTitle) emu.consoleTitle = emu.exePath;
        setWindowTitle(emu.consoleTitle);
        onTitleChange?.(emu.consoleTitle);
        setWindowStyle(WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
        setCanvasSize({ w: 640, h: 480 });
        onReady?.();
      }

      emu.onConsoleTitleChange = () => {
        setWindowTitle(emu.consoleTitle);
        onTitleChange?.(emu.consoleTitle);
      };

      // Wire up async file I/O to IndexedDB via FileManager
      emu.fs.onFileRequest = (fileName: string) => getFile(fileName);
      emu.fs.onFileSave = (fileName: string, data: ArrayBuffer) => {
        addFile(fileName, data).then(() => window.dispatchEvent(new Event('desktop-files-changed')));
      };
      emu.fs.onFileDelete = (fileName: string) => {
        deleteFile(fileName).then(() => window.dispatchEvent(new Event('desktop-files-changed')));
      };

      // Wire up browser file picker for GetOpenFileName/GetSaveFileName
      emu.onFileDialog = (type, filter, title) => {
        return new Promise<{ name: string; data: ArrayBuffer } | null>((resolve) => {
          if (type === 'open') {
            const input = document.createElement('input');
            input.type = 'file';
            // Parse filter to extract extensions (e.g. "Text Files|*.txt|All Files|*.*")
            if (filter) {
              const parts = filter.split('|');
              const exts: string[] = [];
              for (let i = 1; i < parts.length; i += 2) {
                const pat = parts[i].trim();
                if (pat && pat !== '*.*' && pat !== '*') {
                  // "*.txt;*.log" → ".txt,.log"
                  pat.split(';').forEach(p => {
                    const m = p.trim().match(/\*(\.\w+)/);
                    if (m) exts.push(m[1]);
                  });
                }
              }
              if (exts.length > 0) input.accept = exts.join(',');
            }
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) { resolve(null); return; }
              file.arrayBuffer().then(data => resolve({ name: file.name, data }));
            };
            // Handle cancel — input doesn't fire change on cancel, use focus fallback
            const onFocus = () => {
              setTimeout(() => {
                if (!input.files?.length) resolve(null);
                window.removeEventListener('focus', onFocus);
              }, 300);
            };
            window.addEventListener('focus', onFocus);
            input.click();
          } else {
            // Save: prompt for filename
            const defaultName = title || 'untitled.txt';
            const name = prompt('Save file as:', defaultName);
            if (!name) { resolve(null); return; }
            resolve({ name, data: new ArrayBuffer(0) });
          }
        });
      };

      // Wire up browser download for Z:\ file save
      emu.fs.onFileSaveExternal = (name, data) => {
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      // Populate virtual filesystem with desktop files (for all app types)
      getAllFiles().then(files => {
        emu.fs.virtualFiles = files.map(f => ({ name: f.name, size: f.data.byteLength }));
      });

      // Listen for window changes from emulator
      emu.onWindowChange = (wnd: WindowInfo) => {
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
        setHasMainWindow(true);
        setWindowTitle(wnd.title);
        onTitleChange?.(wnd.title);
        setWindowStyle(wnd.style);
        setMinimized(!!wnd.minimized);
        setMaximized(!!wnd.maximized);
        // Use emulated window position only for initial mainWindow placement (cascade),
        // not for runtime MoveWindow/SetWindowPos or non-main windows
        if (!windowPosInitialized.current && emu.mainWindow && wnd.hwnd === emu.mainWindow) {
          windowPosInitialized.current = true;
          const x = Math.max(0, Math.min(wnd.x, window.innerWidth - wnd.width));
          const y = Math.max(0, Math.min(wnd.y, window.innerHeight - wnd.height));
          setWindowPos({ x, y });
        }
        if (canvas && !wnd.minimized) {
          setCanvasSize({ w: canvas.width, h: canvas.height });
        }
      };

      emu.onShowDialog = (info: DialogInfo) => {
        setDialogInfo(info);
        // Programs like ssmaze.scr /c show a dialog without creating a main window.
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onCloseDialog = () => setDialogInfo(null);
      emu.onControlsChanged = (controls: ControlOverlay[]) => setControlOverlays(controls);
      emu.onMenuChanged = () => setMenus(prev => [...prev]);
      emu.onShowCommonDialog = (req) => {
        setCommonDialog(req);
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onShowMessageBox = (id, caption, text, type) => {
        setMessageBoxes(prev => [...prev, { id, caption, text, type }]);
        // Programs like winver.exe show a message box without creating a main window.
        // Ensure the UI becomes visible so the message box can be seen.
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onCrash = (eip: string, description: string) => { setCrashInfo({ eip, description }); onReady?.(); };
      emu.onExit = () => {
        if (emu.isConsole) {
          // Keep window open so user can see output, show a message box like cmd.exe
          const finishedTitle = `Finished - ${emu.consoleTitle || exeBaseName}`;
          emu.consoleTitle = finishedTitle;
          setWindowTitle(finishedTitle);
          onTitleChange?.(finishedTitle);
          setMessageBoxes(prev => [...prev, { id: -1, caption: exeBaseName, text: t().processExited.replace('{0}', String(emu.exitCode)), type: 0 /* MB_OK */, isExit: true }]);
          return;
        }
        onStop();
      };
      emu.onCreateProcess = (childExeName: string, childCmdLine: string) => {
        if (!onRunExe) return;
        const lowerName = childExeName.toLowerCase();
        for (const [name, data] of emu.additionalFiles) {
          if (name.toLowerCase() === lowerName) {
            const childPe = lowerName.endsWith('.com') ? parseCOM(data) : parsePE(data);
            // Pass all additionalFiles to the child too
            onRunExe(data, childPe, emu.additionalFiles, name, childCmdLine);
            return;
          }
        }
      };

      // Child console process from console parent: run in-process, share console
      emu.onCreateChildConsole = (childExeName: string, childCmdLine: string, hProcess: number) => {
        const lowerName = childExeName.toLowerCase();
        let childData: ArrayBuffer | undefined;
        let childFileName = childExeName;
        for (const [name, data] of emu.additionalFiles) {
          if (name.toLowerCase() === lowerName) {
            childData = data;
            childFileName = name;
            break;
          }
        }
        if (!childData) return;

        const childPeInfo = lowerName.endsWith('.com') ? parseCOM(childData) : parsePE(childData);
        const procData = emu.handles.get<Record<string, unknown>>(hProcess);

        // Create child emulator in-process
        const childEmu = new Emulator();
        childEmu.configuredLcid = loadSettings().localeId;
        for (const [name, data] of emu.additionalFiles) {
          childEmu.additionalFiles.set(name, data);
        }
        if (childCmdLine) childEmu.commandLine = childCmdLine;
        if (processRegistry) {
          childEmu.processRegistry = processRegistry;
          processRegistry.register(childEmu, childFileName);
        }
        childEmu.screenWidth = emu.screenWidth;
        childEmu.screenHeight = emu.screenHeight;

        // Share file system, inherit current drive/directory
        childEmu.fs = emu.fs;
        childEmu.currentDrive = emu.currentDrive;
        childEmu.currentDirs = new Map(emu.currentDirs);

        // Store child emu on the process handle
        if (procData) {
          procData.childEmu = childEmu;
          procData.childExited = false;
          procData.childExitCode = 0;
        }

        // Load child (this creates its own consoleBuffer via initConsoleBuffer)
        childEmu.load(childData, childPeInfo, canvas);

        // Share console state AFTER load() so initConsoleBuffer doesn't overwrite
        childEmu.consoleBuffer = emu.consoleBuffer;
        childEmu.consoleCursorX = emu.consoleCursorX;
        childEmu.consoleCursorY = emu.consoleCursorY;
        childEmu.consoleAttr = emu.consoleAttr;
        childEmu.consoleMode = emu.consoleMode;
        childEmu.consoleInputMode = emu.consoleInputMode;
        childEmu.consoleInputBuffer = emu.consoleInputBuffer;

        // Allow child to create GUI windows or spawn its own children
        childEmu.onCreateProcess = emu.onCreateProcess;
        childEmu.onCreateChildConsole = emu.onCreateChildConsole;

        // When child writes to console, sync cursor back to parent and notify UI
        childEmu.onConsoleOutput = () => {
          emu.consoleCursorX = childEmu.consoleCursorX;
          emu.consoleCursorY = childEmu.consoleCursorY;
          emu.consoleAttr = childEmu.consoleAttr;
          emu.onConsoleOutput?.();
        };

        childEmu.onConsoleTitleChange = () => {
          emu.consoleTitle = childEmu.consoleTitle;
          emu.onConsoleTitleChange?.();
        };

        // When child exits, signal the parent's process handle and resume parent
        childEmu.onExit = () => {
          emu.consoleCursorX = childEmu.consoleCursorX;
          emu.consoleCursorY = childEmu.consoleCursorY;
          emu.consoleAttr = childEmu.consoleAttr;
          emu.onConsoleOutput?.();

          if (procData) {
            procData.childExited = true;
            procData.childExitCode = childEmu.exitCode;
          }

          // Resume parent if it was waiting on WaitForSingleObject
          if (emu._childProcessWaiting && emu._childProcessResume) {
            const { stackBytes, retVal, completer } = emu._childProcessResume;
            emu._childProcessWaiting = false;
            emu._childProcessResume = null;
            emu.waitingForMessage = false;
            completer(emu, stackBytes, retVal);
            if (emu.running && !emu.halted) {
              requestAnimationFrame(emu.tick);
            }
          }
        };

        // Start the child
        childEmu.run();
      };

      // Load registry from IndexedDB then start
      initAndRun().then(() => emu.run());
    } catch (err: unknown) {
      console.error('Emulator error:', err);
    }

    return () => {
      if (regFlushTimer !== null) clearTimeout(regFlushTimer);
      if (emuRef.current) {
        if (processRegistry && emuRef.current.pid) {
          processRegistry.unregister(emuRef.current.pid);
        }
        emuRef.current.stop();
        emuRef.current = null;
      }
      if (iconUrl) URL.revokeObjectURL(iconUrl);
    };
  }, [arrayBuffer, peInfo, resetCount]);

  // --- File open/save dialogs (trigger native browser UI) ---
  useEffect(() => {
    if (commonDialog?.type === 'file-open') {
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = () => {
            commonDialog.onResult({ name: file.name, data: new Uint8Array(reader.result as ArrayBuffer) });
            setCommonDialog(null);
          };
          reader.readAsArrayBuffer(file);
        } else {
          commonDialog.onResult(null);
          setCommonDialog(null);
        }
      };
      input.addEventListener('cancel', () => {
        commonDialog.onResult(null);
        setCommonDialog(null);
      });
      input.click();
    }
    if (commonDialog?.type === 'file-save') {
      const name = prompt('Save as:', commonDialog.defaultName);
      if (name) {
        const blob = new Blob([commonDialog.content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        commonDialog.onResult(name);
      } else {
        commonDialog.onResult(null);
      }
      setCommonDialog(null);
    }
  }, [commonDialog]);

  // --- Find dialog: Find Next handler ---
  const handleFindNext = useCallback(() => {
    if (!commonDialog || commonDialog.type !== 'find' || !findTerm) return;
    const emu = emuRef.current;
    if (!emu) return;
    const wnd = emu.handles.get<WindowInfo>(commonDialog.editHwnd);
    if (!wnd) return;
    const text = wnd.domInput?.value || wnd.title || '';
    const startPos = (emu.findState?.term === findTerm) ? (emu.findState.lastIndex + 1) : 0;
    const idx = text.toLowerCase().indexOf(findTerm.toLowerCase(), startPos);
    if (idx >= 0) {
      emu.findState = { term: findTerm, lastIndex: idx };
      wnd.editSelStart = idx;
      wnd.editSelEnd = idx + findTerm.length;
      if (wnd.domInput) {
        wnd.domInput.focus();
        wnd.domInput.setSelectionRange(idx, idx + findTerm.length);
      }
      emu.notifyControlOverlays();
    } else {
      emu.findState = { term: findTerm, lastIndex: -1 };
      alert('Cannot find "' + findTerm + '"');
    }
    // Sync search term to FINDREPLACEW struct so menu "Find Next" (F3) also works
    if (emu.findReplacePtr) {
      const lpBuf = emu.memory.readU32(emu.findReplacePtr + 0x10); // lpstrFindWhat
      const bufLen = emu.memory.readU16(emu.findReplacePtr + 0x18); // wFindWhatLen
      if (lpBuf && bufLen > 0) {
        const maxChars = Math.min(findTerm.length, Math.floor(bufLen / 2) - 1);
        for (let i = 0; i < maxChars; i++) {
          emu.memory.writeU16(lpBuf + i * 2, findTerm.charCodeAt(i));
        }
        emu.memory.writeU16(lpBuf + maxChars * 2, 0);
      }
    }
  }, [commonDialog, findTerm]);

  // --- Resize drag handling ---
  const onResizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    // Send WM_GETMINMAXINFO so the app can set its min track size (cached on WindowInfo after dispatch)
    const emu = emuRef.current;
    if (emu && emu.mainWindow) {
      const addr = emu.allocHeap(40); // MINMAXINFO = 40 bytes
      emu.postMessage(emu.mainWindow, WM_GETMINMAXINFO, 0, addr);
    }
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: canvasSize.w, startH: canvasSize.h, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [canvasSize, windowPos]);

  const applyCanvasToEmu = useCallback((w: number, h: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
    if (!wnd) return;
    emu.setupCanvasSize(w, h);
    const bw = getBorderWidth(wnd.style);
    const hasCaption = (wnd.style & WS_CAPTION) === WS_CAPTION;
    const captionH = hasCaption ? 19 : 0;
    const menuH = wnd.hMenu ? 19 : 0;
    wnd.width = w + 2 * bw;
    wnd.height = h + 2 * bw + captionH + menuH;
    emu.postMessage(emu.mainWindow, WM_SIZE, 0, makeLParam(w, h));
    wnd.needsPaint = true;
    wnd.needsErase = true;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // Move drag
      const m = moveDrag.current;
      if (m) {
        setWindowPos({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY });
        return;
      }
      // Resize drag
      const d = resizeDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      let w = d.startW, h = d.startH;
      let px = d.startPosX, py = d.startPosY;
      if (d.edge.includes('e')) w = d.startW + dx;
      if (d.edge.includes('w')) { w = d.startW - dx; px = d.startPosX + dx; }
      if (d.edge.includes('s')) h = d.startH + dy;
      if (d.edge.includes('n')) { h = d.startH - dy; py = d.startPosY + dy; }
      // Windows SM_CXMINTRACK = 112 at 96 DPI (fits icon + caption buttons + borders)
      const SM_CXMINTRACK = 112;
      let minW = SM_CXMINTRACK, minH = 32;
      const emu = emuRef.current;
      if (emu && emu.mainWindow) {
        const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (wnd && wnd.minTrackWidth) {
          const bw = getBorderWidth(wnd.style);
          const hasCaption = (wnd.style & WS_CAPTION) === WS_CAPTION;
          const captionH = hasCaption ? 19 : 0;
          const menuH = wnd.hMenu ? 19 : 0;
          minW = Math.max(SM_CXMINTRACK, wnd.minTrackWidth - 2 * bw);
          minH = Math.max(32, (wnd.minTrackHeight || 0) - 2 * bw - captionH - menuH);
        }
      }
      if (w < minW) { if (d.edge.includes('w')) px -= minW - w; w = minW; }
      if (h < minH) { if (d.edge.includes('n')) py -= minH - h; h = minH; }
      setCanvasSize({ w, h });
      setWindowPos({ x: px, y: py });
      applyCanvasToEmu(w, h);
    };
    const onUp = () => {
      if (moveDrag.current) { moveDrag.current = null; return; }
      resizeDrag.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [canvasSize, applyCanvasToEmu]);

  const handlePointerEvent = useCallback((e: PointerEvent, msg: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    // Block mouse events while a modal dialog/MessageBox is showing
    if (emu.messageBoxes.length > 0) return;
    if (emu.dialogState) return;

    // Resume AudioContext if suspended (user gesture)
    if (emu.audioContext?.state === 'suspended') emu.audioContext.resume();

    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * canvas.width / rect.width);
    const y = Math.round((e.clientY - rect.top) * canvas.height / rect.height);
    const lParam = makeLParam(x, y);
    const wParam = buildMKFlags(e);
    const targetHwnd = emu.capturedWindow || emu.mainWindow;
    emu.postMessage(targetHwnd, msg, wParam, lParam);
  }, []);

  // Document-level mouse listeners for SetCapture support (drag over overlays)
  useEffect(() => {
    const onDocMouseMove = (e: PointerEvent) => {
      if (!mouseIsDown.current || !canvasRef.current) return;
      handlePointerEvent(e, WM_MOUSEMOVE);
    };
    const onDocMouseUp = (e: PointerEvent) => {
      if (!mouseIsDown.current || !canvasRef.current) return;
      mouseIsDown.current = false;
      handlePointerEvent(e, WM_MOUSEMOVE);
      if (e.button === 0) handlePointerEvent(e, WM_LBUTTONUP);
      else if (e.button === 2) handlePointerEvent(e, WM_RBUTTONUP);
    };
    document.addEventListener('pointermove', onDocMouseMove);
    document.addEventListener('pointerup', onDocMouseUp);
    return () => {
      document.removeEventListener('pointermove', onDocMouseMove);
      document.removeEventListener('pointerup', onDocMouseUp);
    };
  }, [handlePointerEvent]);

  // Keyboard input — post WM_KEYDOWN/WM_KEYUP/WM_CHAR to emulator
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!focused) return;
      // Don't intercept input into HTML form elements
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      // Don't intercept browser shortcuts (Ctrl+T, Ctrl+W, etc.)
      if (e.ctrlKey && !e.altKey && ['KeyT', 'KeyW', 'KeyN', 'KeyR', 'KeyL'].includes(e.code)) return;
      const keyToVK = getKeyToVK();
      const vk = keyToVK[e.code];
      if (vk === undefined) return;
      e.preventDefault();
      emu.keyStates.add(vk);
      // lParam: repeat count (1) | scanCode << 16 | extended << 24 | previous state << 30
      const scanCode = e.keyCode & 0xFF;
      const lParam = 1 | (scanCode << 16);
      const target = emu.focusedWindow || emu.mainWindow;
      emu.postMessage(target, WM_KEYDOWN, vk, lParam);
      // Also send WM_CHAR for printable characters
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
        emu.postMessage(target, WM_CHAR, e.key.charCodeAt(0), lParam);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!focused) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const keyToVK = getKeyToVK();
      const vk = keyToVK[e.code];
      if (vk === undefined) return;
      e.preventDefault();
      emu.keyStates.delete(vk);
      const scanCode = e.keyCode & 0xFF;
      const lParam = 1 | (scanCode << 16) | (3 << 30); // transition + previous state
      emu.postMessage(emu.focusedWindow || emu.mainWindow, WM_KEYUP, vk, lParam);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [focused]);

  const handleMenuCommand = useCallback((id: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    emu.postMessage(emu.mainWindow, WM_COMMAND, id, 0);
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    // Don't start drag on caption buttons
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    if (maximized) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [windowPos, maximized]);

  const handleMinimize = useCallback(() => {
    const emu = emuRef.current;
    if (emu?.mainWindow) {
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_MINIMIZE, 0);
    }
    // Don't set minimized on the window — let the taskbar handle hiding via minimizedProp
    onMinimize?.();
  }, [onMinimize]);

  const handleMaximize = useCallback(() => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    if (maximized) {
      // Restore
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      const saved = preMaxState.current;
      if (saved) {
        setWindowPos({ x: saved.x, y: saved.y });
        setCanvasSize({ w: saved.w, h: saved.h });
        preMaxState.current = null;
        // Defer so state settles before applying to emu
        setTimeout(() => applyCanvasToEmu(saved.w, saved.h), 0);
      }
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (wnd) {
        if (saved) { wnd.x = saved.x; wnd.y = saved.y; }
        wnd.minimized = false; wnd.maximized = false;
      }
      setMaximized(false);
      setMinimized(false);
    } else {
      // Maximize
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
      preMaxState.current = { x: windowPos.x, y: windowPos.y, w: canvasSize.w, h: canvasSize.h };
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      const hasCaption = wnd ? (wnd.style & WS_CAPTION) === WS_CAPTION : true;
      const captionH = hasCaption ? 21 : 0;
      const menuH = (menus.length > 0) ? 20 : 0;
      const TASKBAR_HEIGHT = 30;
      const dw = window.innerWidth;
      const dh = window.innerHeight - captionH - menuH - TASKBAR_HEIGHT;
      setWindowPos({ x: 0, y: 0 });
      setCanvasSize({ w: dw, h: dh });
      setTimeout(() => applyCanvasToEmu(dw, dh), 0);
      if (wnd) { wnd.x = 0; wnd.y = 0; wnd.maximized = true; wnd.minimized = false; }
      setMaximized(true);
      setMinimized(false);
    }
  }, [maximized, windowPos, canvasSize, menus.length, applyCanvasToEmu]);

  const handleTitleBarDblClick = useCallback(() => {
    if (minimized) {
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (wnd) {
        wnd.minimized = false; wnd.maximized = false;
        wnd.needsPaint = true; wnd.needsErase = true;
        emu.onWindowChange?.(wnd);
      }
    } else if (windowStyle & WS_MAXIMIZEBOX) {
      handleMaximize();
    }
  }, [minimized, handleMaximize, windowStyle]);


  if (crashInfo) {
    const crashExeName = windowTitle || exeBaseName;
    return (
      <div onPointerDown={onFocus}>
        <MessageBox
          caption={`${crashExeName} - ${t().applicationError}`}
          text={`${t().crashMessage.replace('{0}', crashExeName)}\n\nReason:  ${crashInfo.description}\nAddress: ${crashInfo.eip}\n\n${t().clickOkToTerminate}`}
          icon={<MsgBoxIcon type={MB_ICONERROR} />}
          onDismiss={onStop}
        />
      </div>
    );
  }

  const hasModalDialog = !!(messageBoxes.length > 0 || dialogInfo || commonDialog);
  const parentFocused = focused && !hasModalDialog;

  // Programs like winver.exe / ssmaze.scr /c have no main window — only show the message box / dialog
  if (!hasMainWindow && !isConsole && windowReady) {
    return (
      <>
        {dialogInfo && (
          <EmulatorDialog
            info={dialogInfo}
            emuRef={emuRef}
            focused={focused}
            lang={detectedLang}
            onDismiss={(action, values) => {
              emuRef.current?.dismissDialog(action, values);
              setDialogInfo(null);
            }}
          />
        )}
        {messageBoxes.map(mb => (
          <MessageBox
            key={mb.id}
            caption={mb.caption}
            text={mb.text}
            type={mb.type}
            focused={focused}
            onDismiss={(btnId) => {
              const isExit = mb.isExit;
              emuRef.current?.dismissMessageBox(mb.id, btnId);
              setMessageBoxes(prev => prev.filter(m => m.id !== mb.id));
              if (isExit) onStop();
            }}
          />
        ))}
        {commonDialog?.type === 'about' && (
          <AboutDialog
            caption={commonDialog.caption}
            extraInfo={commonDialog.extraInfo}
            otherText={commonDialog.otherText}
            focused={focused}
            flashTrigger={modalFlashTrigger}
            onDismiss={() => { commonDialog.onDismiss(); setCommonDialog(null); }}
          />
        )}
        {commonDialog?.type === 'find' && (
          <FindDialog
            findTerm={findTerm}
            onTermChange={setFindTerm}
            onFindNext={handleFindNext}
            onClose={() => { commonDialog.onClose(); setCommonDialog(null); setFindTerm(''); }}
            focused={focused}
          />
        )}
      </>
    );
  }

  return (
    <div ref={desktopRef} style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, visibility: windowReady ? 'visible' : 'hidden', display: minimizedProp ? 'none' : undefined, touchAction: 'none' }} onPointerDown={onFocus}>
      <Window
        title={windowTitle}
        style={windowStyle}
        clientW={isConsole ? 640 : canvasSize.w}
        clientH={isConsole ? 480 : canvasSize.h}
        iconUrl={iconUrl}
        focused={parentFocused}
        maximized={maximized}
        minimized={false}
        blocked={hasModalDialog}
        onBlockedClick={flashModal}
        menus={<MenuBar menus={menus} onCommand={handleMenuCommand} onFocus={onFocus} />}
        onClose={() => {
          const emu = emuRef.current;
          if (emu?.mainWindow) {
            emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_CLOSE, 0);
          } else {
            onStop();
          }
        }}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={handleTitleBarDblClick}
        onResizeStart={onResizeStart}
        lang={detectedLang}
      >
        <div
          style={{ width: '100%', height: '100%' }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            mouseIsDown.current = true;
            if (e.button === 0) handlePointerEvent(e, e.detail >= 2 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN);
            else if (e.button === 2) handlePointerEvent(e, e.detail >= 2 ? WM_RBUTTONDBLCLK : WM_RBUTTONDOWN);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {isConsole && emuRef.current ? (
            <ConsoleView emu={emuRef.current} focused={focused} />
          ) : (
            <canvas
              ref={canvasRef}
              style={{ imageRendering: 'pixelated', cursor: 'var(--win2k-cursor)', display: 'block', position: 'relative', zIndex: 0 }}
              onPointerDown={(e) => {
                e.preventDefault();
                mouseIsDown.current = true;
                if (e.button === 0) handlePointerEvent(e, e.detail >= 2 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN);
                else if (e.button === 2) handlePointerEvent(e, e.detail >= 2 ? WM_RBUTTONDBLCLK : WM_RBUTTONDOWN);
              }}
              onPointerMove={(e) => {
                if (!mouseIsDown.current) handlePointerEvent(e, WM_MOUSEMOVE);
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          {!isConsole && controlOverlays.map((ctrl) => renderControlOverlay(ctrl, emuRef, setPressedControl, pressedControl, onResizeStart))}
        </div>
      </Window>
      {dialogInfo && (
        <EmulatorDialog
          info={dialogInfo}
          emuRef={emuRef}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          lang={detectedLang}
          onDismiss={(action, values) => {
            emuRef.current?.dismissDialog(action, values);
            setDialogInfo(null);
          }}
        />
      )}
      {messageBoxes.map(mb => (
        <MessageBox
          key={mb.id}
          caption={mb.caption}
          text={mb.text}
          type={mb.type}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          onDismiss={(btnId) => {
            emuRef.current?.dismissMessageBox(mb.id, btnId);
            setMessageBoxes(prev => prev.filter(m => m.id !== mb.id));
          }}
        />
      ))}
      {commonDialog?.type === 'about' && (
        <AboutDialog
          caption={commonDialog.caption}
          extraInfo={commonDialog.extraInfo}
          otherText={commonDialog.otherText}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          onDismiss={() => { commonDialog.onDismiss(); setCommonDialog(null); }}
        />
      )}
      {commonDialog?.type === 'find' && (
        <FindDialog
          findTerm={findTerm}
          onTermChange={setFindTerm}
          onFindNext={handleFindNext}
          onClose={() => { commonDialog.onClose(); setCommonDialog(null); setFindTerm(''); }}
          focused={focused}
          parentRef={desktopRef}
        />
      )}
    </div>
  );
}
