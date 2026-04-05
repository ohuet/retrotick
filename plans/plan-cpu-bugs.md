# Plan: Fix CPU Emulation Bugs

## Context

STMIK audio mixing produces DC offset and Second Reality (+ other DOS games) crash after running for a while. A thorough audit of the x86 CPU emulation, cross-referenced with dosemu/QEMU source code and Intel manuals, has revealed **6 confirmed bugs**. The most impactful is likely **Bug #1 (segment overrides ignored in 32-bit mode)** — this would cause DPMI programs using ES:/SS:/GS: overrides to access wrong memory addresses, explaining both the STMIK DC (reading wrong sample data) and Second Reality crashes (memory corruption).

## Confirmed Bugs

### Bug 1: Segment overrides silently ignored in 32-bit protected mode (CRITICAL)
**Files:** `src/lib/emu/x86/dispatch.ts:121-122`
**Problem:** Only FS (0x64) segment override is recognized in 32-bit mode. ES (0x26), CS (0x2E), SS (0x36), DS (0x3E), GS (0x65) are consumed as prefix bytes but `_segOverride` is never set.
```js
// Current (broken):
else if (opcode === 0x26 || ... || opcode === 0x65) {
  if (!cpu.use32) cpu._segOverride = opcode;  // ← only in 16-bit mode!
}
```
**Fix:** Remove the `if (!cpu.use32)` guard. Segment overrides must be recognized in all modes.
**Impact:** DPMI programs using non-DS segment overrides access wrong addresses. Most likely cause of STMIK DC and Second Reality crashes.

### Bug 2: GS missing from getSegOverrideSel (HIGH)
**File:** `src/lib/emu/x86/decode.ts:103-111`
**Problem:** GS override (0x65) falls through to `default: return cpu.ds`. GS-based memory accesses silently use DS base.
**Fix:** Add `case 0x65: return cpu.gs;` to the switch.

### Bug 3: MOV r/m16, Sreg (0x8C) broken in 32-bit mode (HIGH)
**File:** `src/lib/emu/x86/dispatch.ts:705-719`
**Problem:** The `if (!cpu.use32)` guard makes all segment register reads return 0 in 32-bit mode. Also missing FS (case 4) and GS (case 5).
**Fix:** Remove the `if (!cpu.use32)` guard. Add FS and GS cases. In 32-bit mode with register dest, zero-extend to 32 bits (use `decodeModRM(opSize)` instead of hardcoded 16).

### Bug 4: ADC/SBB AF flag computation incorrect (MEDIUM)
**Files:** `src/lib/emu/x86/cpu.ts:343-355`, `src/lib/emu/x86/flags.ts:38,48,60,70,80,91`
**Problem:** ADC stores `(b >>> 0) + cf` as lazyB. The AF formula `(a ^ b ^ res) & 0x10` then uses corrupted b — when adding cf flips bit 4 of b, AF is wrong. Confirmed by QEMU/Bochs implementations.
**Fix:** Store cf separately. Options:
- **Option A (simplest):** Add a `lazyCF` field to CPU. ADC/SBB store original b in lazyB and cf in lazyCF. In materializeFlags, compute AF as `((a ^ b ^ res) & 0x10)` with original b, and compute CF using `(a >>> 0) + (b >>> 0) + lazyCF > 0xFFFFFFFF` (for 32-bit).
- **Option B:** Compute AF eagerly in the ADC/SBB handler (before modifying b), store it in flagsCache. This avoids adding a new field.
**Impact:** BCD instructions (DAA/DAS/AAA/AAS) after ADC/SBB give wrong results.

### Bug 5: 16-bit IN/OUT split into two 8-bit operations (MEDIUM)
**File:** `src/lib/emu/x86/dispatch.ts:1322-1364`
**Problem:** `IN AX,DX` and `OUT DX,AX` (opcodes 0xED/0xEF) split into two separate 8-bit I/O operations to port and port+1. On real x86, these are single 16-bit transactions. Same for imm8 variants (0xE5/0xE7).
**Fix:** Call `portIn`/`portOut` once with the full 16-bit value. May need to extend portIn/portOut to accept a size parameter, or let the port handler decide how to handle 16-bit values.

### Bug 6: INC/DEC lose IOPL and NT flags (LOW)
**File:** `src/lib/emu/x86/dispatch.ts` (all INC/DEC handlers)
**Problem:** Save mask `(DF | 0x0300)` = `0x0700` doesn't include IOPL (0x3000) or NT (0x4000). After INC/DEC, these flags are zeroed.
**Fix:** Change mask to `(DF | 0x7300)` to match the mask used in `materializeFlags`.

## Implementation Order

1. **Bug 1** — Segment overrides in 32-bit mode (1 line change in dispatch.ts)
2. **Bug 2** — GS in getSegOverrideSel (1 line addition in decode.ts)
3. **Bug 3** — MOV Sreg 0x8C (rewrite ~15 lines in dispatch.ts)
4. **Bug 6** — INC/DEC flag mask (search-replace `(DF | 0x0300)` → `(DF | 0x7300)` in dispatch.ts)
5. **Bug 4** — ADC/SBB AF (requires careful design in cpu.ts + flags.ts)
6. **Bug 5** — 16-bit IN/OUT (dispatch.ts + possibly emulator port API)

## Verification

1. `npm run build` — type check passes
2. Run existing test suite: `timeout 2 npx tsx tests/test-calc.mjs` (and other test-*.mjs files)
3. Test Second Reality in browser — should run longer without crashing
4. Test STMIK-based programs — audio mixing should no longer produce DC offset
