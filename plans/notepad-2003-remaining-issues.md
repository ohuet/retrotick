# Notepad 2003 - Remaining Issues

## Status of fixes (branch: fix-notepad-open-file)

### Fixed and working
1. **WM_INITMENU sent when menu opens** - MenuBar calls `onMenuOpen` → EmulatorView sends WM_INITMENU + WM_INITMENUPOPUP via callWndProc. Win2003 Notepad uses WM_INITMENU (not WM_INITMENUPOPUP) for enabling/disabling menu items.
2. **Menu handle tree auto-populated** - `buildMenuHandleTree()` in menu.ts creates handle hierarchy from PE menu items. CreateWindowExA/W auto-loads menu from class `menuName` when hMenu=0.
3. **EnableMenuItem/CheckMenuItem sync** - Handle-table path now syncs to legacy `emu.menuItems` and calls `onMenuChanged()`.
4. **Status bar visibility** - `CreateStatusWindowW` now respects WS_VISIBLE flag (was forced to true). ShowWindow on child windows calls `notifyControlOverlays()`.
5. **Select All** - Works correctly (verified headless).
6. **Clipboard storage** - `SetClipboardData`/`IsClipboardFormatAvailable`/`GetClipboardData` now track formats and data.
7. **WM_COPY/WM_CUT/WM_PASTE/WM_CLEAR** - Implemented in EDIT built-in handler. Sets `emu._clipboardText`.
8. **DispatchMessage for built-in controls** - Now calls `handleBuiltinMessage` for controls with wndProc=0 (was calling `callWndProc(0)` which returned 0 immediately).
9. **GetFocus** - Now returns first visible child when focus is on parent window (Notepad checks `GetFocus() == hwndEdit`).

### ~~Issue 1: Cut/Copy/Delete menus don't enable in browser~~ FIXED

**Fix**: Sync DOM textarea selection (`selectionStart`/`selectionEnd`) to `editSelStart`/`editSelEnd` on all EDIT controls before sending WM_INITMENU in `handleMenuOpen` (EmulatorView.tsx). The WM_INITMENU handler calls EM_GETSEL which now returns the correct selection range.

### ~~Issue 2: Paste stays grayed after Copy~~ FIXED

**Fix**: Same as Issue 1 — once WM_INITMENU executes fully (with correct EM_GETSEL values), it reaches the `IsClipboardFormatAvailable(CF_TEXT)` check and enables Paste correctly.

### Issue 3: Go To dialog OK button does nothing

**Symptom**: The "Aller à la ligne" dialog appears, user enters a line number, clicks OK, nothing happens.

**Investigation state**:
- Dialog template ID=14, Edit control ID=258 for line number
- `GetDlgItemInt` and `EndDialog` have diagnostic logging added
- The dialog dismiss flow should work: dismissDialog → callWndProc(WM_COMMAND/IDOK) → dialog proc calls GetDlgItemInt + EndDialog → _endDialog resolves promise → emuCompleteThunk
- Need to check browser console for `[DLG] EndDialog` and `[EDIT] GetDlgItemInt` logs when OK is clicked

### Issue 4: File sometimes doesn't load on double-click

**Symptom**: Double-clicking a text file sometimes shows empty Notepad. Closing and re-opening works.

**Not investigated yet**. Could be a race condition with the file loading or the `onShowCommonDialog` callback timing.

## Key files modified

- `src/components/win2k/MenuBar.tsx` — added `onMenuOpen` callback
- `src/components/EmulatorView.tsx` — added `handleMenuOpen`, imported WM_INITMENU/WM_INITMENUPOPUP
- `src/lib/emu/win32/user32/menu.ts` — `buildMenuHandleTree()`, EnableMenuItem/CheckMenuItem sync to legacy
- `src/lib/emu/win32/user32/create-window.ts` — auto-load menu from class menuName, ShowWindow notifyControlOverlays
- `src/lib/emu/win32/user32/clipboard.ts` — clipboard format/data storage
- `src/lib/emu/win32/user32/message.ts` — WM_COPY/CUT/PASTE/CLEAR in EDIT handler, DispatchMessage built-in control handling, SendMessage interception range 0x0300-0x0303
- `src/lib/emu/win32/user32/focus.ts` — GetFocus returns child when parent focused
- `src/lib/emu/win32/user32/dialog.ts` — EndDialog diagnostic logging
- `src/lib/emu/win32/comctl32.ts` — CreateStatusWindowW respects WS_VISIBLE
- `src/lib/emu/emu-render.ts` — notifyControlOverlays sends empty list
- `src/lib/emu/emulator.ts` — `_clipboardText` field

## Test files

- `tests/test-notepad2003.mjs` — Tests WM_INITMENU, Select All, menu handle tree (all pass)
- `tests/test-notepad-open.mjs` — Existing test (passes, no regression)

## Next steps

1. ~~Fix Issue 1 by syncing DOM selection to editSelStart/editSelEnd before WM_INITMENU~~ DONE
2. ~~Verify Issue 2 is resolved by Issue 1 fix~~ DONE
3. Investigate Issue 3 (Go To dialog) via browser console logs
4. Investigate Issue 4 (file load race condition)
