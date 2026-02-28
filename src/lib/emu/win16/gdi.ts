import type { Emulator } from '../emulator';
import type { DCInfo, BitmapInfo, BrushInfo, PenInfo, PaletteInfo } from '../win32/gdi32/types';
import { OPAQUE } from '../win32/types';
import { fillTextBitmap } from '../emu-render';

function colorToCSS(bgr: number): string {
  const r = bgr & 0xFF;
  const g = (bgr >> 8) & 0xFF;
  const b = (bgr >> 16) & 0xFF;
  return `rgb(${r},${g},${b})`;
}

function readDIBPalette(
  emu: Emulator, dc: DCInfo, bmiPtr: number, biSize: number, numColors: number, fuUsage: number,
): [number, number, number][] {
  const palette: [number, number, number][] = [];
  const paletteOffset = bmiPtr + biSize;
  if (fuUsage === 1 && numColors > 0) {
    // DIB_PAL_COLORS: color table contains WORD indices into the DC's logical palette
    const pal = emu.handles.get<PaletteInfo>(dc.selectedPalette);
    for (let i = 0; i < numColors; i++) {
      const idx = emu.memory.readU16(paletteOffset + i * 2);
      if (pal && idx < pal.count) {
        palette.push([pal.entries[idx * 4], pal.entries[idx * 4 + 1], pal.entries[idx * 4 + 2]]);
      } else {
        palette.push([0, 0, 0]);
      }
    }
  } else {
    for (let i = 0; i < numColors; i++) {
      const b = emu.memory.readU8(paletteOffset + i * 4);
      const g = emu.memory.readU8(paletteOffset + i * 4 + 1);
      const r = emu.memory.readU8(paletteOffset + i * 4 + 2);
      palette.push([r, g, b]);
    }
  }
  return palette;
}

function calcDIBStride(biWidth: number, biBitCount: number): number {
  if (biBitCount === 1) return ((Math.ceil(biWidth / 8)) + 3) & ~3;
  if (biBitCount === 4) return ((Math.ceil(biWidth / 2)) + 3) & ~3;
  if (biBitCount === 8) return (biWidth + 3) & ~3;
  if (biBitCount === 24) return (biWidth * 3 + 3) & ~3;
  if (biBitCount === 32) return biWidth * 4;
  return 0;
}

function readDIBPixel(
  emu: Emulator, rowStart: number, sx: number, biBitCount: number, palette: [number, number, number][],
): [number, number, number] {
  if (biBitCount === 8) {
    return palette[emu.memory.readU8(rowStart + sx)] || [0, 0, 0];
  }
  if (biBitCount === 4) {
    const byteVal = emu.memory.readU8(rowStart + (sx >> 1));
    const idx = (sx & 1) === 0 ? (byteVal >> 4) & 0x0F : byteVal & 0x0F;
    return palette[idx] || [0, 0, 0];
  }
  if (biBitCount === 1) {
    const idx = (emu.memory.readU8(rowStart + (sx >> 3)) >> (7 - (sx & 7))) & 1;
    return palette[idx] || [0, 0, 0];
  }
  if (biBitCount === 24) {
    const off = rowStart + sx * 3;
    return [emu.memory.readU8(off + 2), emu.memory.readU8(off + 1), emu.memory.readU8(off)];
  }
  if (biBitCount === 32) {
    const off = rowStart + sx * 4;
    return [emu.memory.readU8(off + 2), emu.memory.readU8(off + 1), emu.memory.readU8(off)];
  }
  return [0, 0, 0];
}

// Win16 ROP codes use different encoding than Win32
const SRCCOPY16     = 0x00CC0020;
const NOTSRCCOPY16  = 0x00330008;
const SRCPAINT16    = 0x00EE0086;
const SRCAND16      = 0x008800C6;
const SRCINVERT16   = 0x00660046;
const BLACKNESS16   = 0x00000042;
const WHITENESS16   = 0x00FF0062;
const PATCOPY16     = 0x00F00021;
const PATINVERT16   = 0x005A0049;

// Map mode constants
const MM_TEXT = 1;

// Region result constants
const SIMPLEREGION = 1;

// Text alignment constants
const TA_LEFT = 0;

// PS_NULL
const PS_NULL = 5;

// BS_NULL
const BS_NULL = 1;

export function registerWin16Gdi(emu: Emulator): void {
  const gdi = emu.registerModule16('GDI');

  // Set up stock objects for Win16
  const stockBrushes: Record<number, BrushInfo> = {
    0: { color: 0xFFFFFF, isNull: false },  // WHITE_BRUSH
    1: { color: 0xC8D0D4, isNull: false },  // LTGRAY_BRUSH
    2: { color: 0x808080, isNull: false },  // GRAY_BRUSH
    3: { color: 0x404040, isNull: false },  // DKGRAY_BRUSH
    4: { color: 0x000000, isNull: false },  // BLACK_BRUSH
    5: { color: 0, isNull: true },           // NULL_BRUSH
  };
  const stockPens: Record<number, PenInfo> = {
    6: { style: 0, width: 1, color: 0xFFFFFF },  // WHITE_PEN
    7: { style: 0, width: 1, color: 0x000000 },  // BLACK_PEN
    8: { style: PS_NULL, width: 0, color: 0 },    // NULL_PEN
  };
  emu.getStockBrush = (idx: number) => stockBrushes[idx] || null;
  emu.getStockPen = (idx: number) => stockPens[idx] || null;

  // Font helpers — read font info from DC's selected font handle
  function getFontSize(hdc: number): number {
    const dc = emu.getDC(hdc);
    if (!dc) return 13;
    const font = emu.handles.get<{ height: number }>(dc.selectedFont);
    if (font && font.height) return Math.abs(font.height);
    return 13;
  }

  function getFontCSS(hdc: number): string {
    const sz = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    const font = dc ? emu.handles.get<{ height: number; faceName?: string; weight?: number; italic?: boolean }>(dc.selectedFont) : null;
    const face = font?.faceName || 'Tahoma';
    const weight = font?.weight && font.weight >= 700 ? 'bold ' : '';
    const italic = font?.italic ? 'italic ' : '';
    return `${italic}${weight}${sz}px "${face}", Tahoma, sans-serif`;
  }

  function createMemDC(): number {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    const defBmpCanvas = new OffscreenCanvas(1, 1);
    const defBmpCtx = defBmpCanvas.getContext('2d')!;
    const defBmp: BitmapInfo = { width: 1, height: 1, canvas: defBmpCanvas, ctx: defBmpCtx };
    const defBmpHandle = emu.handles.alloc('bitmap', defBmp);
    const dc: DCInfo = {
      canvas, ctx, hwnd: 0,
      selectedBitmap: defBmpHandle, selectedPen: 0, selectedBrush: 0, selectedFont: 0, selectedPalette: 0,
      textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
      penPosX: 0, penPosY: 0, rop2: 13,
    };
    return emu.handles.alloc('dc', dc);
  }

  function brushToFillStyle(dc: DCInfo, brush: BrushInfo): string | CanvasPattern | null {
    if (brush.patternBitmap) {
      return dc.ctx.createPattern(brush.patternBitmap, 'repeat');
    }
    return colorToCSS(brush.color);
  }

  function fillAndStroke(dc: DCInfo) {
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
      dc.ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = pen.width || 1;
      dc.ctx.stroke();
    }
  }

  // Ordinal 1: SetBkColor(hdc, color_long) — pascal, 6 bytes (2+4)
  gdi.register('ord_1', 6, () => {
    const [hdc, color] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.bkColor;
      dc.bkColor = color;
      return old;
    }
    return 0;
  });

  // Ordinal 2: SetBkMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('ord_2', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.bkMode;
      dc.bkMode = mode;
      return old;
    }
    return 0;
  });

  // Ordinal 3: SetMapMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('ord_3', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.mapMode ?? MM_TEXT;
      dc.mapMode = mode;
      return old;
    }
    return MM_TEXT;
  });

  // Ordinal 4: SetROP2(hdc, fnDrawMode) — pascal -ret16, 4 bytes
  gdi.register('ord_4', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.rop2;
      dc.rop2 = mode;
      return old;
    }
    return 0;
  });

  // Ordinal 5: SetRelAbs(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('ord_5', 4, () => 1);

  // Ordinal 6: SetPolyFillMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('ord_6', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.polyFillMode ?? 1; // ALTERNATE=1
      dc.polyFillMode = mode;
      return old;
    }
    return 1;
  });

  // Ordinal 7: SetStretchBltMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('ord_7', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.stretchBltMode ?? 1;
      dc.stretchBltMode = mode;
      return old;
    }
    return 0;
  });

  // Ordinal 8: SetTextCharacterExtra(hdc, nCharExtra) — pascal -ret16, 4 bytes
  gdi.register('ord_8', 4, () => {
    const [hdc, nCharExtra] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.textCharExtra ?? 0;
      dc.textCharExtra = (nCharExtra << 16) >> 16; // sign extend
      return old;
    }
    return 0;
  });

  // Ordinal 9: SetTextColor(hdc, color_long) — pascal, 6 bytes (2+4)
  gdi.register('ord_9', 6, () => {
    const [hdc, color] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.textColor;
      dc.textColor = color;
      return old;
    }
    return 0;
  });

  // Ordinal 10: SetTextJustification(hdc, nBreakExtra, nBreakCount) — pascal -ret16, 6 bytes
  gdi.register('ord_10', 6, () => {
    const [hdc, nBreakExtra, nBreakCount] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.textJustBreakExtra = (nBreakExtra << 16) >> 16;
      dc.textJustBreakCount = (nBreakCount << 16) >> 16;
    }
    return 1;
  });

  // Ordinal 11: SetWindowOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_11', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.windowOrgX ?? 0;
      const oldY = dc.windowOrgY ?? 0;
      dc.windowOrgX = (x << 16) >> 16;
      dc.windowOrgY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 12: SetWindowExt(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_12', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.windowExtX ?? 1;
      const oldY = dc.windowExtY ?? 1;
      dc.windowExtX = (x << 16) >> 16;
      dc.windowExtY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 13: SetViewportOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_13', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.viewportOrgX ?? 0;
      const oldY = dc.viewportOrgY ?? 0;
      dc.viewportOrgX = (x << 16) >> 16;
      dc.viewportOrgY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 14: SetViewportExt(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_14', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.viewportExtX ?? 1;
      const oldY = dc.viewportExtY ?? 1;
      dc.viewportExtX = (x << 16) >> 16;
      dc.viewportExtY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 15: OffsetWindowOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_15', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.windowOrgX = (dc.windowOrgX ?? 0) + ((x << 16) >> 16);
      dc.windowOrgY = (dc.windowOrgY ?? 0) + ((y << 16) >> 16);
      return ((dc.windowOrgY & 0xFFFF) << 16) | (dc.windowOrgX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 16: ScaleWindowExt(hdc, xNum, xDenom, yNum, yDenom) — pascal, 10 bytes
  gdi.register('ord_16', 10, () => {
    const [hdc, xNum, xDenom, yNum, yDenom] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc && xDenom && yDenom) {
      dc.windowExtX = Math.round((dc.windowExtX ?? 1) * ((xNum << 16) >> 16) / ((xDenom << 16) >> 16));
      dc.windowExtY = Math.round((dc.windowExtY ?? 1) * ((yNum << 16) >> 16) / ((yDenom << 16) >> 16));
      return (((dc.windowExtY ?? 1) & 0xFFFF) << 16) | ((dc.windowExtX ?? 1) & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 17: OffsetViewportOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_17', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.viewportOrgX = (dc.viewportOrgX ?? 0) + ((x << 16) >> 16);
      dc.viewportOrgY = (dc.viewportOrgY ?? 0) + ((y << 16) >> 16);
      return ((dc.viewportOrgY & 0xFFFF) << 16) | (dc.viewportOrgX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 18: ScaleViewportExt(hdc, xNum, xDenom, yNum, yDenom) — pascal, 10 bytes
  gdi.register('ord_18', 10, () => {
    const [hdc, xNum, xDenom, yNum, yDenom] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc && xDenom && yDenom) {
      dc.viewportExtX = Math.round((dc.viewportExtX ?? 1) * ((xNum << 16) >> 16) / ((xDenom << 16) >> 16));
      dc.viewportExtY = Math.round((dc.viewportExtY ?? 1) * ((yNum << 16) >> 16) / ((yDenom << 16) >> 16));
      return (((dc.viewportExtY ?? 1) & 0xFFFF) << 16) | ((dc.viewportExtX ?? 1) & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 19: LineTo(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('ord_19', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.beginPath();
        dc.ctx.moveTo(dc.penPosX + 0.5, dc.penPosY + 0.5);
        dc.ctx.lineTo(x + 0.5, y + 0.5);
        dc.ctx.stroke();
      }
      dc.penPosX = x;
      dc.penPosY = y;
    }
    return 1;
  });

  // Ordinal 20: MoveTo(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_20', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.penPosX;
      const oldY = dc.penPosY;
      dc.penPosX = x;
      dc.penPosY = y;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 21: ExcludeClipRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ord_21', 10, () => SIMPLEREGION);

  // Ordinal 22: IntersectClipRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ord_22', 10, () => SIMPLEREGION);

  // Ordinal 23: Arc(hdc, l, t, r, b, xStart, yStart, xEnd, yEnd) — pascal -ret16, 18 bytes
  gdi.register('ord_23', 18, () => {
    const [hdc, l, t, r, b, xStart, yStart, xEnd, yEnd] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      const rx = Math.abs(r - l) / 2;
      const ry = Math.abs(b - t) / 2;
      const startAngle = Math.atan2((((yStart << 16) >> 16) - cy) / ry, (((xStart << 16) >> 16) - cx) / rx);
      const endAngle = Math.atan2((((yEnd << 16) >> 16) - cy) / ry, (((xEnd << 16) >> 16) - cx) / rx);
      dc.ctx.beginPath();
      dc.ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, startAngle, endAngle, true);
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.stroke();
      }
    }
    return 1;
  });

  // Ordinal 24: Ellipse(hdc, left, top, right, bottom) — pascal -ret16, 10 bytes
  gdi.register('ord_24', 10, () => {
    const [hdc, left, top, right, bottom] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const rx = (right - left) / 2;
      const ry = (bottom - top) / 2;
      dc.ctx.beginPath();
      dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
      fillAndStroke(dc);
    }
    return 1;
  });

  // Ordinal 25: FloodFill(hdc, x, y, crColor) — pascal -ret16, 10 bytes (2+2+2+4)
  // FloodFill fills until it hits crColor (boundary fill)
  gdi.register('ord_25', 10, () => {
    const [hdc, x, y, crColor] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const brush = emu.getBrush(dc.selectedBrush);
    if (!brush || brush.isNull) return 0;
    const fillR = brush.color & 0xFF, fillG = (brush.color >> 8) & 0xFF, fillB = (brush.color >> 16) & 0xFF;
    const bndR = crColor & 0xFF, bndG = (crColor >> 8) & 0xFF, bndB = (crColor >> 16) & 0xFF;
    const w = dc.canvas.width, h = dc.canvas.height;
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    const imgData = dc.ctx.getImageData(0, 0, w, h);
    const px = imgData.data;
    const isBoundary = (i: number) => px[i] === bndR && px[i + 1] === bndG && px[i + 2] === bndB;
    const startIdx = (y * w + x) * 4;
    if (isBoundary(startIdx)) return 0;
    const visited = new Uint8Array(w * h);
    const stack = [x + y * w];
    visited[x + y * w] = 1;
    while (stack.length > 0) {
      const pos = stack.pop()!;
      const px0 = pos % w, py0 = (pos / w) | 0;
      const i = pos * 4;
      px[i] = fillR; px[i + 1] = fillG; px[i + 2] = fillB; px[i + 3] = 255;
      const neighbors = [pos - 1, pos + 1, pos - w, pos + w];
      for (const n of neighbors) {
        if (n < 0 || n >= w * h) continue;
        const nx = n % w;
        if (Math.abs(nx - px0) > 1) continue; // wrap guard
        if (visited[n]) continue;
        visited[n] = 1;
        const ni = n * 4;
        if (!isBoundary(ni)) stack.push(n);
      }
    }
    dc.ctx.putImageData(imgData, 0, 0);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ordinal 26: Pie(hdc, l, t, r, b, xR1, yR1, xR2, yR2) — pascal -ret16, 18 bytes
  gdi.register('ord_26', 18, () => {
    const [hdc, l, t, r, b, xR1, yR1, xR2, yR2] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      const rx = Math.abs(r - l) / 2;
      const ry = Math.abs(b - t) / 2;
      const a1 = Math.atan2((((yR1 << 16) >> 16) - cy) / (ry || 1), (((xR1 << 16) >> 16) - cx) / (rx || 1));
      const a2 = Math.atan2((((yR2 << 16) >> 16) - cy) / (ry || 1), (((xR2 << 16) >> 16) - cx) / (rx || 1));
      dc.ctx.beginPath();
      dc.ctx.moveTo(cx, cy);
      dc.ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, a1, a2, true);
      dc.ctx.closePath();
      fillAndStroke(dc);
    }
    return 1;
  });

  // Ordinal 27: Rectangle(hdc, left, top, right, bottom) — pascal -ret16, 10 bytes
  gdi.register('ord_27', 10, () => {
    const [hdc, leftRaw, topRaw, rightRaw, bottomRaw] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const left = (leftRaw << 16) >> 16;
    const top = (topRaw << 16) >> 16;
    const right = (rightRaw << 16) >> 16;
    const bottom = (bottomRaw << 16) >> 16;
    const dc = emu.getDC(hdc);
    if (dc) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fillRect(left, top, right - left, bottom - top);
      }
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
      }
    }
    return 1;
  });

  // Ordinal 28: RoundRect(hdc, l, t, r, b, w, h) — pascal -ret16, 14 bytes
  gdi.register('ord_28', 14, () => {
    const [hdc, l, t, r, b, w, h] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const left = (l << 16) >> 16;
      const top = (t << 16) >> 16;
      const right = (r << 16) >> 16;
      const bottom = (b << 16) >> 16;
      const rx = ((w << 16) >> 16) / 2;
      const ry = ((h << 16) >> 16) / 2;
      dc.ctx.beginPath();
      dc.ctx.roundRect(left, top, right - left, bottom - top, [Math.min(rx, ry)]);
      fillAndStroke(dc);
    }
    return 1;
  });

  // Ordinal 29: PatBlt(hdc, x, y, w, h, rop_long) — pascal -ret16, 14 bytes (2+2+2+2+2+4)
  gdi.register('ord_29', 14, () => {
    const [hdc, xRaw, yRaw, wRaw, hRaw, rop] = emu.readPascalArgs16([2, 2, 2, 2, 2, 4]);
    const x = (xRaw << 16) >> 16;
    const y = (yRaw << 16) >> 16;
    const w = (wRaw << 16) >> 16;
    const h = (hRaw << 16) >> 16;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    if (rop === BLACKNESS16) {
      dc.ctx.fillStyle = '#000';
      dc.ctx.fillRect(x, y, w, h);
    } else if (rop === WHITENESS16) {
      dc.ctx.fillStyle = '#fff';
      dc.ctx.fillRect(x, y, w, h);
    } else if (rop === PATCOPY16) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
        dc.ctx.fillRect(x, y, w, h);
      }
    } else if (rop === PATINVERT16) {
      dc.ctx.globalCompositeOperation = 'xor';
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
        dc.ctx.fillRect(x, y, w, h);
      }
      dc.ctx.globalCompositeOperation = 'source-over';
    } else {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
        dc.ctx.fillRect(x, y, w, h);
      }
    }
    return 1;
  });

  // Ordinal 30: SaveDC(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_30', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.save();
    return 1;
  });

  // Ordinal 31: SetPixel(hdc, x, y, crColor_long) — pascal, 10 bytes (2+2+2+4)
  gdi.register('ord_31', 10, () => {
    const [hdc, x, y, color] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.ctx.fillStyle = colorToCSS(color);
      dc.ctx.fillRect(x, y, 1, 1);
    }
    return color;
  });

  // Ordinal 32: OffsetClipRgn(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('ord_32', 6, () => SIMPLEREGION);

  // Ordinal 33: TextOut(hdc, x, y, lpString_ptr, nCount) — pascal -ret16, 12 bytes (2+2+2+4+2)
  gdi.register('ord_33', 12, () => {
    const [hdc, x, y, lpString, nCount] = emu.readPascalArgs16([2, 2, 2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (dc && lpString && nCount > 0) {
      let text = '';
      for (let i = 0; i < nCount; i++) {
        text += String.fromCharCode(emu.memory.readU8(lpString + i));
      }
      const fontSize = getFontSize(hdc);
      dc.ctx.font = getFontCSS(hdc);
      if (dc.bkMode === OPAQUE) {
        dc.ctx.fillStyle = colorToCSS(dc.bkColor);
        const m = dc.ctx.measureText(text);
        dc.ctx.fillRect(x, y, m.width, fontSize);
      }
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';
      fillTextBitmap(dc.ctx, text, (x << 16) >> 16, (y << 16) >> 16);
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  // Ordinal 34: BitBlt(hdcDest, xDest, yDest, w, h, hdcSrc, xSrc, ySrc, rop_long) — pascal -ret16, 20 bytes
  gdi.register('ord_34', 20, () => {
    const [hdcDest, xDstRaw, yDstRaw, wRaw, hRaw, hdcSrc, xSrcRaw, ySrcRaw, rop] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 4]);
    const xDst = (xDstRaw << 16) >> 16;
    const yDst = (yDstRaw << 16) >> 16;
    const w = (wRaw << 16) >> 16;
    const h = (hRaw << 16) >> 16;
    const xSrc = (xSrcRaw << 16) >> 16;
    const ySrc = (ySrcRaw << 16) >> 16;

    const dstDC = emu.getDC(hdcDest);
    if (!dstDC) return 0;

    if (rop === BLACKNESS16) {
      dstDC.ctx.fillStyle = '#000';
      dstDC.ctx.fillRect(xDst, yDst, w, h);
      return 1;
    }
    if (rop === WHITENESS16) {
      dstDC.ctx.fillStyle = '#fff';
      dstDC.ctx.fillRect(xDst, yDst, w, h);
      return 1;
    }
    if (rop === PATCOPY16) {
      const brush = emu.getBrush(dstDC.selectedBrush);
      if (brush && !brush.isNull) {
        dstDC.ctx.fillStyle = colorToCSS(brush.color);
        dstDC.ctx.fillRect(xDst, yDst, w, h);
      }
      return 1;
    }

    const srcDC = emu.getDC(hdcSrc);
    if (!srcDC) return 0;

    if (w <= 0 || h <= 0) return 1;

    if (rop === SRCCOPY16) {
      dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, w, h, xDst, yDst, w, h);
    } else if (rop === NOTSRCCOPY16) {
      dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, w, h, xDst, yDst, w, h);
      const imgData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      const px = imgData.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i];
        px[i+1] = 255 - px[i+1];
        px[i+2] = 255 - px[i+2];
      }
      dstDC.ctx.putImageData(imgData, xDst, yDst);
    } else if (rop === SRCPAINT16) {
      const srcData = srcDC.ctx.getImageData(xSrc, ySrc, w, h);
      const dstData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] |= srcData.data[i];
        dstData.data[i+1] |= srcData.data[i+1];
        dstData.data[i+2] |= srcData.data[i+2];
      }
      dstDC.ctx.putImageData(dstData, xDst, yDst);
    } else if (rop === SRCAND16) {
      const srcData = srcDC.ctx.getImageData(xSrc, ySrc, w, h);
      const dstData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] &= srcData.data[i];
        dstData.data[i+1] &= srcData.data[i+1];
        dstData.data[i+2] &= srcData.data[i+2];
      }
      dstDC.ctx.putImageData(dstData, xDst, yDst);
    } else if (rop === SRCINVERT16) {
      const srcData = srcDC.ctx.getImageData(xSrc, ySrc, w, h);
      const dstData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] ^= srcData.data[i];
        dstData.data[i+1] ^= srcData.data[i+1];
        dstData.data[i+2] ^= srcData.data[i+2];
      }
      dstDC.ctx.putImageData(dstData, xDst, yDst);
    } else {
      dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, w, h, xDst, yDst, w, h);
    }
    return 1;
  });

  // Ordinal 35: StretchBlt — pascal -ret16, 24 bytes
  gdi.register('ord_35', 24, () => {
    const [hdcDest, xDstR, yDstR, wDstR, hDstR, hdcSrc, xSrcR, ySrcR, wSrcR, hSrcR, rop] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4]);
    const dstDC = emu.getDC(hdcDest);
    const srcDC = emu.getDC(hdcSrc);
    if (!dstDC || !srcDC) return 0;
    // Sign-extend 16-bit values
    let xDst = (xDstR << 16) >> 16, yDst = (yDstR << 16) >> 16;
    let wDst = (wDstR << 16) >> 16, hDst = (hDstR << 16) >> 16;
    let xSrc = (xSrcR << 16) >> 16, ySrc = (ySrcR << 16) >> 16;
    let wSrc = (wSrcR << 16) >> 16, hSrc = (hSrcR << 16) >> 16;
    if (wDst === 0 || hDst === 0 || wSrc === 0 || hSrc === 0) return 1;
    // Handle negative dimensions via canvas scale transforms
    dstDC.ctx.save();
    if (wDst < 0) { xDst += wDst; wDst = -wDst; dstDC.ctx.translate(xDst + wDst, 0); dstDC.ctx.scale(-1, 1); xDst = 0; }
    if (hDst < 0) { yDst += hDst; hDst = -hDst; dstDC.ctx.translate(0, yDst + hDst); dstDC.ctx.scale(1, -1); yDst = 0; }
    if (wSrc < 0) { xSrc += wSrc; wSrc = -wSrc; }
    if (hSrc < 0) { ySrc += hSrc; hSrc = -hSrc; }
    dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, wSrc, hSrc, xDst, yDst, wDst, hDst);
    dstDC.ctx.restore();
    return 1;
  });

  // Ordinal 36: Polygon(hdc, lpPoints, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_36', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (dc && lpPoints && nCount > 2) {
      dc.ctx.beginPath();
      for (let i = 0; i < nCount; i++) {
        const px = emu.memory.readI16(lpPoints + i * 4);
        const py = emu.memory.readI16(lpPoints + i * 4 + 2);
        if (i === 0) dc.ctx.moveTo(px, py);
        else dc.ctx.lineTo(px, py);
      }
      dc.ctx.closePath();
      fillAndStroke(dc);
    }
    return 1;
  });

  // Ordinal 37: Polyline(hdc, lpPoints_ptr, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_37', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (dc && lpPoints && nCount > 1) {
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.beginPath();
        for (let i = 0; i < nCount; i++) {
          const px = emu.memory.readI16(lpPoints + i * 4);
          const py = emu.memory.readI16(lpPoints + i * 4 + 2);
          if (i === 0) dc.ctx.moveTo(px + 0.5, py + 0.5);
          else dc.ctx.lineTo(px + 0.5, py + 0.5);
        }
        dc.ctx.stroke();
      }
    }
    return 1;
  });

  // Ordinal 38: Escape(hdc, nEscape, cbInput, lpInData, lpOutData) — pascal -ret16, 14 bytes (2+2+2+4+4)
  gdi.register('ord_38', 14, () => 0);

  // Ordinal 39: RestoreDC(hdc, nSavedDC) — pascal -ret16, 4 bytes
  gdi.register('ord_39', 4, () => {
    const [hdc] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.restore();
    return 1;
  });

  // Ordinal 40: FillRgn(hdc, hRgn, hBrush) — pascal -ret16, 6 bytes
  gdi.register('ord_40', 6, () => 1);

  // Ordinal 41: FrameRgn(hdc, hRgn, hBrush, w, h) — pascal -ret16, 10 bytes
  gdi.register('ord_41', 10, () => 1);

  // Ordinal 42: InvertRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('ord_42', 4, () => 1);

  // Ordinal 43: PaintRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('ord_43', 4, () => 1);

  // Ordinal 44: SelectClipRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('ord_44', 4, () => SIMPLEREGION);

  // Ordinal 45: SelectObject(hdc, hGdiObj) — pascal -ret16, 4 bytes
  gdi.register('ord_45', 4, () => {
    const [hdc, hObj] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const objType = emu.handles.getType(hObj);

    if (objType === 'bitmap') {
      const bmp = emu.handles.get<BitmapInfo>(hObj);
      if (bmp && bmp.width && bmp.height && bmp.canvas) {
        const old = dc.selectedBitmap || hObj;
        dc.selectedBitmap = hObj;
        dc.canvas.width = bmp.width;
        dc.canvas.height = bmp.height;
        dc.ctx = (dc.canvas as OffscreenCanvas).getContext('2d')!;
        dc.ctx.drawImage(bmp.canvas, 0, 0);
        return old;
      }
    }
    if (objType === 'pen') {
      const old = dc.selectedPen || hObj;
      dc.selectedPen = hObj;
      return old;
    }
    if (objType === 'brush') {
      const old = dc.selectedBrush || hObj;
      dc.selectedBrush = hObj;
      return old;
    }
    if (objType === 'font') {
      const old = dc.selectedFont || hObj;
      dc.selectedFont = hObj;
      return old;
    }
    if (objType === 'palette') {
      const old = dc.selectedPalette || hObj;
      dc.selectedPalette = hObj;
      return old;
    }

    // Stock objects (handle >= 0x8000 in 16-bit)
    if (hObj >= 0x8000) {
      const stockIdx = hObj - 0x8000;
      if (stockIdx <= 5) {
        const old = dc.selectedBrush || hObj;
        dc.selectedBrush = hObj;
        return old;
      }
      if (stockIdx >= 6 && stockIdx <= 8) {
        const old = dc.selectedPen || hObj;
        dc.selectedPen = hObj;
        return old;
      }
      if (stockIdx >= 10 && stockIdx <= 17) {
        const old = dc.selectedFont || hObj;
        dc.selectedFont = hObj;
        return old;
      }
      // Stock palette: 15 = DEFAULT_PALETTE
      if (stockIdx === 15) {
        const old = dc.selectedPalette || hObj;
        dc.selectedPalette = hObj;
        return old;
      }
    }

    return 0;
  });

  // Ordinal 47: CombineRgn(hrgnDest, hrgnSrc1, hrgnSrc2, fnCombineMode) — pascal -ret16, 8 bytes
  gdi.register('ord_47', 8, () => SIMPLEREGION);

  // Ordinal 48: CreateBitmap(w, h, nPlanes, nBitCount, lpBits) — pascal -ret16, 12 bytes (2+2+2+2+4)
  gdi.register('ord_48', 12, () => {
    const [w, h, nPlanes, nBitCount, lpBits] = emu.readPascalArgs16([2, 2, 2, 2, 4]);
    const bw = w || 1, bh = h || 1;
    const canvas = new OffscreenCanvas(bw, bh);
    const ctx = canvas.getContext('2d')!;
    if (lpBits && nBitCount === 1) {
      // Monochrome bitmap: read bits and render
      const imgData = ctx.createImageData(bw, bh);
      const bytesPerRow = Math.ceil(bw / 16) * 2; // WORD-aligned
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const byteIdx = Math.floor(x / 8);
          const bitIdx = 7 - (x % 8);
          const b = emu.memory.readU8(lpBits + y * bytesPerRow + byteIdx);
          const set = (b >> bitIdx) & 1;
          const off = (y * bw + x) * 4;
          imgData.data[off] = imgData.data[off + 1] = imgData.data[off + 2] = set ? 255 : 0;
          imgData.data[off + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    const bmp: BitmapInfo = { width: bw, height: bh, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  });

  // Ordinal 49: CreateBitmapIndirect(lpBitmap_ptr) — pascal -ret16, 4 bytes
  gdi.register('ord_49', 4, () => {
    const lpBitmap = emu.readArg16DWord(0);
    if (lpBitmap) {
      const w = emu.memory.readU16(lpBitmap + 2);
      const h = emu.memory.readU16(lpBitmap + 4);
      const canvas = new OffscreenCanvas(w || 1, h || 1);
      const ctx = canvas.getContext('2d')!;
      const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
      return emu.handles.alloc('bitmap', bmp);
    }
    return 0;
  });

  // Ordinal 50: CreateBrushIndirect(lpLogBrush) — pascal -ret16, 4 bytes
  gdi.register('ord_50', 4, () => {
    const lpLogBrush = emu.readArg16DWord(0);
    if (lpLogBrush) {
      const lbStyle = emu.memory.readU16(lpLogBrush);
      const lbColor = emu.memory.readU32(lpLogBrush + 2) & 0xFFFFFF;
      const isNull = (lbStyle === BS_NULL);
      const brush: BrushInfo = { color: lbColor, isNull };
      return emu.handles.alloc('brush', brush);
    }
    return 0;
  });

  // Ordinal 51: CreateCompatibleBitmap(hdc, w, h) — pascal -ret16, 6 bytes
  gdi.register('ord_51', 6, () => {
    const [hdc, w, h] = emu.readPascalArgs16([2, 2, 2]);
    const canvas = new OffscreenCanvas(w || 1, h || 1);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  });

  // Ordinal 52: CreateCompatibleDC(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_52', 2, () => createMemDC());

  // Ordinal 53: CreateDC(lpDriverName, lpDeviceName, lpOutput, lpInitData) — pascal -ret16, 16 bytes (4+4+4+4)
  gdi.register('ord_53', 16, () => createMemDC());

  // Ordinal 54: CreateEllipticRgn(l, t, r, b) — pascal -ret16, 8 bytes
  gdi.register('ord_54', 8, () => emu.handles.alloc('region', {}));

  // Ordinal 55: CreateEllipticRgnIndirect(lpRect) — pascal -ret16, 4 bytes
  gdi.register('ord_55', 4, () => emu.handles.alloc('region', {}));

  // Ordinal 56: CreateFont(nHeight, nWidth, nEsc, nOrient, fnWeight, fdwItalic, fdwUnderline, fdwStrikeOut,
  //   fdwCharSet, fdwOutputPrecision, fdwClipPrecision, fdwQuality, fdwPitchAndFamily, lpszFace)
  // pascal -ret16, 28 bytes (2*9 + 1*4 + 1 + 4 = actually 2+2+2+2+2+1+1+1+1+1+1+1+1+4 but Win16 pushes WORDs)
  // Win16 CreateFont: 14 params all pushed as WORDs = 28 bytes
  gdi.register('ord_56', 28, () => {
    const [nHeight, _nWidth, _nEsc, _nOrient, fnWeight,
           fdwItalic, _fdwUnderline, _fdwStrikeOut, _fdwCharSet,
           _fdwOutPrec, _fdwClipPrec, _fdwQuality, _fdwPitch, lpszFace] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4]);
    const height = (nHeight << 16) >> 16;
    let faceName = '';
    if (lpszFace) {
      faceName = emu.memory.readCString(lpszFace);
    }
    return emu.handles.alloc('font', {
      height: height || 13,
      faceName: faceName || undefined,
      weight: fnWeight,
      italic: !!(fdwItalic & 0xFF),
    });
  });

  // Ordinal 57: CreateFontIndirect(lpLogFont) — pascal -ret16, 4 bytes
  // LOGFONT16: lfHeight(2), lfWidth(2), lfEscapement(2), lfOrientation(2), lfWeight(2),
  //   lfItalic(1), lfUnderline(1), lfStrikeOut(1), lfCharSet(1), lfOutPrecision(1),
  //   lfClipPrecision(1), lfQuality(1), lfPitchAndFamily(1), lfFaceName(32)
  gdi.register('ord_57', 4, () => {
    const lpLogFont = emu.readArg16DWord(0);
    if (!lpLogFont) return emu.handles.alloc('font', { height: 13 });
    const height = emu.memory.readI16(lpLogFont);
    const weight = emu.memory.readU16(lpLogFont + 8);
    const italic = emu.memory.readU8(lpLogFont + 10);
    // lfFaceName at offset 18, 32 bytes
    const faceName = emu.memory.readCString(lpLogFont + 18);
    return emu.handles.alloc('font', {
      height: height || 13,
      faceName: faceName || undefined,
      weight,
      italic: !!italic,
    });
  });

  // Ordinal 58: CreateHatchBrush(fnStyle, clrref) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_58', 6, () => {
    const [fnStyle, color] = emu.readPascalArgs16([2, 4]);
    const brush: BrushInfo = { color, isNull: false };
    return emu.handles.alloc('brush', brush);
  });

  // Ordinal 60: CreatePatternBrush(hBitmap) — pascal -ret16, 2 bytes
  gdi.register('ord_60', 2, () => {
    const hBitmap = emu.readArg16(0);
    const bmp = emu.handles.get<BitmapInfo>(hBitmap);
    const brush: BrushInfo = { color: 0x808080, isNull: false, patternBitmap: bmp?.canvas };
    return emu.handles.alloc('brush', brush);
  });

  // Ordinal 61: CreatePen(fnPenStyle, nWidth, crColor_long) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('ord_61', 8, () => {
    const [style, width, color] = emu.readPascalArgs16([2, 2, 4]);
    const pen: PenInfo = { style, width, color };
    return emu.handles.alloc('pen', pen);
  });

  // Ordinal 62: CreatePenIndirect(lpLogPen) — pascal -ret16, 4 bytes
  gdi.register('ord_62', 4, () => {
    const lpLogPen = emu.readArg16DWord(0);
    if (lpLogPen) {
      const style = emu.memory.readU16(lpLogPen);
      const width = emu.memory.readI16(lpLogPen + 2);
      const color = emu.memory.readU32(lpLogPen + 6) & 0xFFFFFF; // POINT is 4 bytes (x,y), color follows
      const pen: PenInfo = { style, width: width || 1, color };
      return emu.handles.alloc('pen', pen);
    }
    return 0;
  });

  // Ordinal 63: CreatePolygonRgn(lpPoints, nCount, fnPolyFillMode) — pascal -ret16, 10 bytes (4+2+2)
  gdi.register('ord_63', 10, () => emu.handles.alloc('region', {}));

  // Ordinal 64: CreateRectRgn(l, t, r, b) — pascal -ret16, 8 bytes
  gdi.register('ord_64', 8, () => emu.handles.alloc('region', {}));

  // Ordinal 65: CreateRectRgnIndirect(lpRect) — pascal -ret16, 4 bytes
  gdi.register('ord_65', 4, () => emu.handles.alloc('region', {}));

  // Ordinal 66: CreateSolidBrush(crColor_long) — pascal -ret16, 4 bytes
  gdi.register('ord_66', 4, () => {
    const color = emu.readArg16DWord(0);
    const brush: BrushInfo = { color, isNull: false };
    return emu.handles.alloc('brush', brush);
  });

  // Ordinal 67: DPtoLP(hdc, lpPoints, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_67', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints) return 0;
    const mode = dc.mapMode ?? MM_TEXT;
    if (mode === MM_TEXT) return 1;
    const wOx = dc.windowOrgX ?? 0, wOy = dc.windowOrgY ?? 0;
    const wEx = dc.windowExtX ?? 1, wEy = dc.windowExtY ?? 1;
    const vOx = dc.viewportOrgX ?? 0, vOy = dc.viewportOrgY ?? 0;
    const vEx = dc.viewportExtX ?? 1, vEy = dc.viewportExtY ?? 1;
    for (let i = 0; i < nCount; i++) {
      const addr = lpPoints + i * 4;
      const dpX = emu.memory.readI16(addr);
      const dpY = emu.memory.readI16(addr + 2);
      const lpX = vEx !== 0 ? Math.round((dpX - vOx) * wEx / vEx + wOx) : dpX;
      const lpY = vEy !== 0 ? Math.round((dpY - vOy) * wEy / vEy + wOy) : dpY;
      emu.memory.writeI16(addr, lpX);
      emu.memory.writeI16(addr + 2, lpY);
    }
    return 1;
  });

  // Ordinal 68: DeleteDC(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_68', 2, () => 1);

  // Ordinal 69: DeleteObject(hObj) — pascal -ret16, 2 bytes
  gdi.register('ord_69', 2, () => 1);

  // Ordinal 70: EnumFonts(hdc, lpFaceName, lpFontFunc, lParam) — pascal -ret16, 14 bytes (2+4+4+4)
  gdi.register('ord_70', 14, () => 0);

  // Ordinal 71: EnumObjects(hdc, nObjectType, lpObjectFunc, lParam) — pascal -ret16, 12 bytes (2+2+4+4)
  gdi.register('ord_71', 12, () => 0);

  // Ordinal 72: EqualRgn(hRgn1, hRgn2) — pascal -ret16, 4 bytes
  gdi.register('ord_72', 4, () => 0);

  // Ordinal 73: ExcludeVisRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ord_73', 10, () => SIMPLEREGION);

  // Ordinal 74: GetBitmapBits(hBitmap, cbBuffer, lpvBits) — pascal, 10 bytes (2+4+4)
  gdi.register('ord_74', 10, () => {
    const [hBitmap, cbBuffer, lpvBits] = emu.readPascalArgs16([2, 4, 4]);
    const bmp = emu.handles.get<BitmapInfo>(hBitmap);
    if (!bmp || !lpvBits || cbBuffer <= 0) return 0;
    const imgData = bmp.ctx.getImageData(0, 0, bmp.width, bmp.height);
    const px = imgData.data;
    // Output as packed 8bpp grayscale-ish (simple: R channel)
    const total = Math.min(cbBuffer, bmp.width * bmp.height);
    for (let i = 0; i < total; i++) {
      emu.memory.writeU8(lpvBits + i, px[i * 4]);
    }
    return total;
  });

  // Ordinal 75: GetBkColor(hdc) — pascal, 2 bytes
  gdi.register('ord_75', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.bkColor : 0xFFFFFF;
  });

  // Ordinal 76: GetBkMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_76', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.bkMode : OPAQUE;
  });

  // Ordinal 77: GetClipBox(hdc, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_77', 6, () => {
    const [hdc, lpRect] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc && lpRect) {
      emu.memory.writeI16(lpRect, 0);
      emu.memory.writeI16(lpRect + 2, 0);
      emu.memory.writeI16(lpRect + 4, dc.canvas.width);
      emu.memory.writeI16(lpRect + 6, dc.canvas.height);
    }
    return SIMPLEREGION;
  });

  // Ordinal 78: GetCurrentPosition(hdc) — pascal, 2 bytes
  gdi.register('ord_78', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) return ((dc.penPosY & 0xFFFF) << 16) | (dc.penPosX & 0xFFFF);
    return 0;
  });

  // Ordinal 79: GetDCOrg(hdc) — pascal, 2 bytes
  gdi.register('ord_79', 2, () => 0);

  // Ordinal 80: GetDeviceCaps(hdc, nIndex) — pascal -ret16, 4 bytes
  gdi.register('ord_80', 4, () => {
    const [hdc, nIndex] = emu.readPascalArgs16([2, 2]);
    const DRIVERVERSION = 0;
    const TECHNOLOGY = 2;
    const HORZSIZE = 4;
    const VERTSIZE = 6;
    const HORZRES = 8;
    const VERTRES = 10;
    const BITSPIXEL = 12;
    const PLANES = 14;
    const NUMBRUSHES = 16;
    const NUMPENS = 18;
    const NUMFONTS = 22;
    const NUMCOLORS = 24;
    const ASPECTX = 36;
    const ASPECTY = 38;
    const ASPECTXY = 40;
    const LOGPIXELSX = 88;
    const LOGPIXELSY = 90;
    const SIZEPALETTE = 104;
    const NUMRESERVED = 106;
    const COLORRES = 108;
    const RASTERCAPS = 38; // actually 38 is ASPECTXY; RASTERCAPS=38 in some refs but 38 in Win16 is different
    const caps: Record<number, number> = {
      [DRIVERVERSION]: 0x0300,
      [TECHNOLOGY]: 1,     // DT_RASDISPLAY
      [HORZSIZE]: 320,
      [VERTSIZE]: 240,
      [HORZRES]: 640,
      [VERTRES]: 480,
      [BITSPIXEL]: 8,
      [PLANES]: 1,
      [NUMBRUSHES]: 256,
      [NUMPENS]: 256,
      [NUMFONTS]: 0,
      [NUMCOLORS]: 256,
      [ASPECTX]: 36,
      [ASPECTY]: 36,
      [ASPECTXY]: 51,
      [LOGPIXELSX]: 96,
      [LOGPIXELSY]: 96,
      [SIZEPALETTE]: 256,
      [NUMRESERVED]: 20,
      [COLORRES]: 18,
      26: 0x7E99,          // RASTERCAPS
    };
    return caps[nIndex] ?? 0;
  });

  // Ordinal 81: GetMapMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_81', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.mapMode ?? MM_TEXT;
  });

  // Ordinal 82: GetObject(hObj, cbBuffer, lpvObject_ptr) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('ord_82', 8, () => {
    const [hObj, cbBuffer, lpvObject] = emu.readPascalArgs16([2, 2, 4]);
    if (!lpvObject || cbBuffer <= 0) return 0;

    const objType = emu.handles.getType(hObj);
    if (objType === 'bitmap') {
      const bmp = emu.handles.get<BitmapInfo>(hObj);
      if (!bmp) return 0;
      const bytesToWrite = Math.min(cbBuffer, 14);
      const bpp = 8;
      const bmWidthBytes = ((bmp.width * bpp + 15) >> 4) << 1;
      if (bytesToWrite >= 2) emu.memory.writeU16(lpvObject + 0, 0);      // bmType
      if (bytesToWrite >= 4) emu.memory.writeU16(lpvObject + 2, bmp.width);
      if (bytesToWrite >= 6) emu.memory.writeU16(lpvObject + 4, bmp.height);
      if (bytesToWrite >= 8) emu.memory.writeU16(lpvObject + 6, bmWidthBytes);
      if (bytesToWrite >= 9) emu.memory.writeU8(lpvObject + 8, 1);       // bmPlanes
      if (bytesToWrite >= 10) emu.memory.writeU8(lpvObject + 9, bpp);    // bmBitsPixel
      if (bytesToWrite >= 14) emu.memory.writeU32(lpvObject + 10, 0);    // bmBits
      return bytesToWrite;
    }
    if (objType === 'pen') {
      const pen = emu.handles.get<PenInfo>(hObj);
      if (!pen) return 0;
      const bytesToWrite = Math.min(cbBuffer, 10);
      // LOGPEN16: style(2), width POINT(4), color(4)
      if (bytesToWrite >= 2) emu.memory.writeU16(lpvObject, pen.style);
      if (bytesToWrite >= 4) emu.memory.writeI16(lpvObject + 2, pen.width);
      if (bytesToWrite >= 6) emu.memory.writeI16(lpvObject + 4, 0);
      if (bytesToWrite >= 10) emu.memory.writeU32(lpvObject + 6, pen.color);
      return bytesToWrite;
    }
    if (objType === 'brush') {
      const brush = emu.handles.get<BrushInfo>(hObj);
      if (!brush) return 0;
      const bytesToWrite = Math.min(cbBuffer, 8);
      // LOGBRUSH16: style(2), color(4), hatch(2)
      if (bytesToWrite >= 2) emu.memory.writeU16(lpvObject, brush.isNull ? BS_NULL : 0);
      if (bytesToWrite >= 6) emu.memory.writeU32(lpvObject + 2, brush.color);
      if (bytesToWrite >= 8) emu.memory.writeU16(lpvObject + 6, 0);
      return bytesToWrite;
    }
    return 0;
  });

  // Ordinal 83: GetPixel(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_83', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      try {
        const imgData = dc.ctx.getImageData(x, y, 1, 1);
        const [r, g, b] = imgData.data;
        return r | (g << 8) | (b << 16);
      } catch { /* empty */ }
    }
    return 0;
  });

  // Ordinal 84: GetPolyFillMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_84', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.polyFillMode ?? 1;
  });

  // Ordinal 85: GetROP2(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_85', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.rop2 ?? 13;
  });

  // Ordinal 86: GetRelAbs(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_86', 2, () => 1); // ABSOLUTE

  // Ordinal 87: GetStockObject(fnObject) — pascal -ret16, 2 bytes
  gdi.register('ord_87', 2, () => {
    const fnObject = emu.readArg16(0);
    return 0x8000 + fnObject;
  });

  // Ordinal 88: GetStretchBltMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_88', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.stretchBltMode ?? 1;
  });

  // Ordinal 89: GetTextCharacterExtra(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_89', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.textCharExtra ?? 0;
  });

  // Ordinal 90: GetTextColor(hdc) — pascal, 2 bytes
  gdi.register('ord_90', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.textColor : 0;
  });

  // Ordinal 91: GetTextExtent(hdc, lpString_ptr, nCount) — pascal, 8 bytes (2+4+2)
  // Returns DWORD: HIWORD=height, LOWORD=width
  gdi.register('ord_91', 8, () => {
    const [hdc, lpString, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const fontSize = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    let width = nCount * Math.round(fontSize * 0.5);
    if (dc && lpString && nCount > 0) {
      let text = '';
      for (let i = 0; i < nCount; i++) text += String.fromCharCode(emu.memory.readU8(lpString + i));
      dc.ctx.font = getFontCSS(hdc);
      width = Math.ceil(dc.ctx.measureText(text).width);
    }
    return ((fontSize & 0xFFFF) << 16) | (width & 0xFFFF);
  });

  // Ordinal 92: GetTextFace(hdc, nCount, lpFaceName) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('ord_92', 8, () => {
    const [hdc, nCount, lpFaceName] = emu.readPascalArgs16([2, 2, 4]);
    if (lpFaceName && nCount > 0) {
      const face = 'System';
      for (let i = 0; i < Math.min(face.length, nCount - 1); i++) {
        emu.memory.writeU8(lpFaceName + i, face.charCodeAt(i));
      }
      emu.memory.writeU8(lpFaceName + Math.min(face.length, nCount - 1), 0);
      return Math.min(face.length, nCount - 1);
    }
    return 0;
  });

  // Ordinal 93: GetTextMetrics(hdc, lptm_ptr) — pascal -ret16, 6 bytes (2+4)
  // TEXTMETRIC16: 24 bytes total
  gdi.register('ord_93', 6, () => {
    const [hdc, lptm] = emu.readPascalArgs16([2, 4]);
    if (lptm) {
      const fontSize = getFontSize(hdc);
      const dc = emu.getDC(hdc);
      const font = dc ? emu.handles.get<{ height: number; weight?: number; italic?: boolean }>(dc.selectedFont) : null;
      const ascent = Math.round(fontSize * 0.8);
      const descent = fontSize - ascent;
      let aveCharWidth = Math.round(fontSize * 0.45);
      let maxCharWidth = fontSize;
      if (dc) {
        dc.ctx.font = getFontCSS(hdc);
        const sample = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        aveCharWidth = Math.round(dc.ctx.measureText(sample).width / sample.length);
        maxCharWidth = Math.ceil(dc.ctx.measureText('W').width);
      }
      let off = 0;
      emu.memory.writeI16(lptm + off, fontSize);      off += 2; // tmHeight
      emu.memory.writeI16(lptm + off, ascent);         off += 2; // tmAscent
      emu.memory.writeI16(lptm + off, descent);        off += 2; // tmDescent
      emu.memory.writeI16(lptm + off, 0);              off += 2; // tmInternalLeading
      emu.memory.writeI16(lptm + off, 0);              off += 2; // tmExternalLeading
      emu.memory.writeI16(lptm + off, aveCharWidth);   off += 2; // tmAveCharWidth
      emu.memory.writeI16(lptm + off, maxCharWidth);   off += 2; // tmMaxCharWidth
      emu.memory.writeI16(lptm + off, font?.weight ?? 400); off += 2; // tmWeight
      emu.memory.writeU8(lptm + off, font?.italic ? 1 : 0); off += 1; // tmItalic
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmUnderlined
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmStruckOut
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmFirstChar
      emu.memory.writeU8(lptm + off, 255);  off += 1; // tmLastChar
      emu.memory.writeU8(lptm + off, 32);   off += 1; // tmDefaultChar
      emu.memory.writeU8(lptm + off, 32);   off += 1; // tmBreakChar
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmPitchAndFamily
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmCharSet
      emu.memory.writeI16(lptm + off, 0);   off += 2; // tmOverhang
      emu.memory.writeI16(lptm + off, 96);  off += 2; // tmDigitizedAspectX
      emu.memory.writeI16(lptm + off, 96);            // tmDigitizedAspectY
    }
    return 1;
  });

  // Ordinal 94: GetViewportExt(hdc) — pascal, 2 bytes
  gdi.register('ord_94', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const extX = dc?.viewportExtX ?? 1;
    const extY = dc?.viewportExtY ?? 1;
    return ((extY & 0xFFFF) << 16) | (extX & 0xFFFF);
  });

  // Ordinal 95: GetViewportOrg(hdc) — pascal, 2 bytes
  gdi.register('ord_95', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const orgX = dc?.viewportOrgX ?? 0;
    const orgY = dc?.viewportOrgY ?? 0;
    return ((orgY & 0xFFFF) << 16) | (orgX & 0xFFFF);
  });

  // Ordinal 96: GetWindowExt(hdc) — pascal, 2 bytes
  gdi.register('ord_96', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const extX = dc?.windowExtX ?? 1;
    const extY = dc?.windowExtY ?? 1;
    return ((extY & 0xFFFF) << 16) | (extX & 0xFFFF);
  });

  // Ordinal 97: GetWindowOrg(hdc) — pascal, 2 bytes
  gdi.register('ord_97', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const orgX = dc?.windowOrgX ?? 0;
    const orgY = dc?.windowOrgY ?? 0;
    return ((orgY & 0xFFFF) << 16) | (orgX & 0xFFFF);
  });

  // Ordinal 98: IntersectVisRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ord_98', 10, () => SIMPLEREGION);

  // Ordinal 99: LPtoDP(hdc, lpPoints, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_99', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints) return 0;
    const mode = dc.mapMode ?? MM_TEXT;
    if (mode === MM_TEXT) return 1;
    const wOx = dc.windowOrgX ?? 0, wOy = dc.windowOrgY ?? 0;
    const wEx = dc.windowExtX ?? 1, wEy = dc.windowExtY ?? 1;
    const vOx = dc.viewportOrgX ?? 0, vOy = dc.viewportOrgY ?? 0;
    const vEx = dc.viewportExtX ?? 1, vEy = dc.viewportExtY ?? 1;
    for (let i = 0; i < nCount; i++) {
      const addr = lpPoints + i * 4;
      const lx = emu.memory.readI16(addr);
      const ly = emu.memory.readI16(addr + 2);
      const dpX = wEx !== 0 ? Math.round((lx - wOx) * vEx / wEx + vOx) : lx;
      const dpY = wEy !== 0 ? Math.round((ly - wOy) * vEy / wEy + vOy) : ly;
      emu.memory.writeI16(addr, dpX);
      emu.memory.writeI16(addr + 2, dpY);
    }
    return 1;
  });

  // Ordinal 100: LineDDA(x1, y1, x2, y2, lpLineFunc, lParam) — pascal -ret16, 16 bytes (2+2+2+2+4+4)
  gdi.register('ord_100', 16, () => 0);

  // Ordinal 101: OffsetRgn(hRgn, x, y) — pascal -ret16, 6 bytes
  gdi.register('ord_101', 6, () => SIMPLEREGION);

  // Ordinal 102: OffsetVisRgn(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('ord_102', 6, () => SIMPLEREGION);

  // Ordinal 103: PtVisible(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('ord_103', 6, () => 1);

  // Ordinal 104: RectVisibleOld(hdc, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_104', 6, () => 1);

  // Ordinal 105: SelectVisRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('ord_105', 4, () => SIMPLEREGION);

  // Ordinal 106: SetBitmapBits(hBitmap, cbBuffer, lpBits) — pascal, 10 bytes (2+4+4)
  gdi.register('ord_106', 10, () => {
    const [hBitmap, cbBuffer, lpBits] = emu.readPascalArgs16([2, 4, 4]);
    const bmp = emu.handles.get<BitmapInfo>(hBitmap);
    if (!bmp || !lpBits || cbBuffer <= 0) return 0;
    const imgData = bmp.ctx.createImageData(bmp.width, bmp.height);
    const px = imgData.data;
    const total = Math.min(cbBuffer, bmp.width * bmp.height);
    for (let i = 0; i < total; i++) {
      const v = emu.memory.readU8(lpBits + i);
      px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
    }
    bmp.ctx.putImageData(imgData, 0, 0);
    return total;
  });

  // Ordinal 117: SetDCOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_117', 6, () => 0);

  // Ordinal 119: AddFontResource(lpFilename) — pascal -ret16, 4 bytes
  gdi.register('ord_119', 4, () => 1);

  // Ordinal 128: MulDiv(nNumber, nNumerator, nDenominator) — pascal -ret16, 6 bytes
  gdi.register('ord_128', 6, () => {
    const [nNumber, nNumerator, nDenominator] = emu.readPascalArgs16([2, 2, 2]);
    const a = (nNumber << 16) >> 16;
    const b = (nNumerator << 16) >> 16;
    const c = (nDenominator << 16) >> 16;
    if (c === 0) return -1;
    return Math.round((a * b) / c) & 0xFFFF;
  });

  // Ordinal 129: SaveVisRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_129', 2, () => 1);

  // Ordinal 130: RestoreVisRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_130', 2, () => SIMPLEREGION);

  // Ordinal 131: InquireVisRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_131', 2, () => emu.handles.alloc('region', {}));

  // Ordinal 134: GetRgnBox(hRgn, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_134', 6, () => {
    const [hRgn, lpRect] = emu.readPascalArgs16([2, 4]);
    if (lpRect) {
      emu.memory.writeI16(lpRect, 0);
      emu.memory.writeI16(lpRect + 2, 0);
      emu.memory.writeI16(lpRect + 4, 640);
      emu.memory.writeI16(lpRect + 6, 480);
    }
    return SIMPLEREGION;
  });

  // Ordinal 136: RemoveFontResource(lpFilename) — pascal -ret16, 4 bytes
  gdi.register('ord_136', 4, () => 1);

  // Ordinal 148: SetBrushOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('ord_148', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.brushOrgX ?? 0;
      const oldY = dc.brushOrgY ?? 0;
      dc.brushOrgX = (x << 16) >> 16;
      dc.brushOrgY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 149: GetBrushOrg(hdc) — pascal, 2 bytes
  gdi.register('ord_149', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const orgX = dc.brushOrgX ?? 0;
      const orgY = dc.brushOrgY ?? 0;
      return ((orgY & 0xFFFF) << 16) | (orgX & 0xFFFF);
    }
    return 0;
  });

  // Ordinal 150: UnrealizeObject(hObj) — pascal -ret16, 2 bytes
  gdi.register('ord_150', 2, () => 1);

  // Ordinal 153: CreateIC(lpDriverName, lpDeviceName, lpOutput, lpInitData) — pascal -ret16, 16 bytes (4+4+4+4)
  gdi.register('ord_153', 16, () => createMemDC());

  // Ordinal 154: GetNearestColor(hdc, crColor) — pascal, 6 bytes (2+4)
  gdi.register('ord_154', 6, () => {
    const [hdc, crColor] = emu.readPascalArgs16([2, 4]);
    return crColor;
  });

  // Ordinal 156: CreateDiscardableBitmap(hdc, w, h) — pascal -ret16, 6 bytes
  gdi.register('ord_156', 6, () => {
    const [hdc, w, h] = emu.readPascalArgs16([2, 2, 2]);
    const canvas = new OffscreenCanvas(w || 1, h || 1);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  });

  // Ordinal 161: PtInRegion(hRgn, x, y) — pascal -ret16, 6 bytes
  gdi.register('ord_161', 6, () => 0);

  // Ordinal 162: GetBitmapDimension(hBitmap) — pascal, 2 bytes
  gdi.register('ord_162', 2, () => {
    const hbmp = emu.readArg16(0);
    const bmp = emu.handles.get<BitmapInfo>(hbmp);
    if (bmp) return ((bmp.height & 0xFFFF) << 16) | (bmp.width & 0xFFFF);
    return 0;
  });

  // Ordinal 163: SetBitmapDimension(hBitmap, x, y) — pascal, 6 bytes
  gdi.register('ord_163', 6, () => 0);

  // Ordinal 172: SetRectRgn(hRgn, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ord_172', 10, () => 1);

  // Ordinal 173: GetClipRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_173', 2, () => 0);

  // Ordinal 307: GetCharABCWidths(hdc, uFirstChar, uLastChar, lpabc) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_307', 10, () => {
    const [hdc, uFirstChar, uLastChar, lpabc] = emu.readPascalArgs16([2, 2, 2, 4]);
    if (lpabc) {
      const dc = emu.getDC(hdc);
      if (dc) dc.ctx.font = getFontCSS(hdc);
      for (let i = 0; i <= uLastChar - uFirstChar; i++) {
        let charW = Math.round(getFontSize(hdc) * 0.5);
        if (dc) {
          charW = Math.ceil(dc.ctx.measureText(String.fromCharCode(uFirstChar + i)).width);
        }
        // ABC16: a(2), b(2), c(2) — simplify: a=0, b=width, c=0
        emu.memory.writeI16(lpabc + i * 6, 0);
        emu.memory.writeU16(lpabc + i * 6 + 2, charW);
        emu.memory.writeI16(lpabc + i * 6 + 4, 0);
      }
    }
    return 1;
  });

  // Ordinal 330: EnumFontFamilies(hdc, lpszFamily, lpEnumFontFamProc, lParam) — pascal -ret16, 14 bytes (2+4+4+4)
  gdi.register('ord_330', 14, () => 0);

  // Ordinal 345: GetTextAlign(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_345', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.textAlign ?? TA_LEFT;
  });

  // Ordinal 346: SetTextAlign(hdc, fMode) — pascal -ret16, 4 bytes
  gdi.register('ord_346', 4, () => {
    const [hdc, fMode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.textAlign ?? TA_LEFT;
      dc.textAlign = fMode;
      return old;
    }
    return TA_LEFT;
  });

  // Ordinal 348: Chord(hdc, l, t, r, b, xR1, yR1, xR2, yR2) — pascal -ret16, 18 bytes
  gdi.register('ord_348', 18, () => {
    const [hdc, l, t, r, b, xR1, yR1, xR2, yR2] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      const rx = Math.abs(r - l) / 2;
      const ry = Math.abs(b - t) / 2;
      const a1 = Math.atan2((((yR1 << 16) >> 16) - cy) / (ry || 1), (((xR1 << 16) >> 16) - cx) / (rx || 1));
      const a2 = Math.atan2((((yR2 << 16) >> 16) - cy) / (ry || 1), (((xR2 << 16) >> 16) - cx) / (rx || 1));
      dc.ctx.beginPath();
      dc.ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, a1, a2, true);
      dc.ctx.closePath();
      fillAndStroke(dc);
    }
    return 1;
  });

  // Ordinal 349: SetMapperFlags(hdc, dwFlag) — pascal, 6 bytes (2+4)
  gdi.register('ord_349', 6, () => 0);

  // Ordinal 350: GetCharWidth(hdc, uFirstChar, uLastChar, lpBuffer) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_350', 10, () => {
    const [hdc, uFirstChar, uLastChar, lpBuffer] = emu.readPascalArgs16([2, 2, 2, 4]);
    if (lpBuffer) {
      const dc = emu.getDC(hdc);
      if (dc) dc.ctx.font = getFontCSS(hdc);
      for (let i = 0; i <= uLastChar - uFirstChar; i++) {
        let w = Math.round(getFontSize(hdc) * 0.5);
        if (dc) {
          w = Math.ceil(dc.ctx.measureText(String.fromCharCode(uFirstChar + i)).width);
        }
        emu.memory.writeI16(lpBuffer + i * 2, w);
      }
    }
    return 1;
  });

  // Ordinal 351: ExtTextOut(hdc, x, y, fuOptions, lprc, lpString, cbCount, lpDx) — pascal -ret16, 22 bytes
  gdi.register('ord_351', 22, () => {
    const [hdc, xRaw, yRaw, fuOptions, lprc, lpString, cbCount, lpDx] =
      emu.readPascalArgs16([2, 2, 2, 2, 4, 4, 2, 4]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const xPos = (xRaw << 16) >> 16;
    const yPos = (yRaw << 16) >> 16;

    const ETO_OPAQUE = 0x2;
    if ((fuOptions & ETO_OPAQUE) && lprc) {
      const l = emu.memory.readI16(lprc);
      const t = emu.memory.readI16(lprc + 2);
      const r = emu.memory.readI16(lprc + 4);
      const b = emu.memory.readI16(lprc + 6);
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      dc.ctx.fillRect(l, t, r - l, b - t);
    }

    if (lpString && cbCount > 0) {
      dc.ctx.font = getFontCSS(hdc);
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';

      if (lpDx) {
        // Per-character positioning via lpDx array (each entry is INT16)
        let cx = xPos;
        for (let i = 0; i < cbCount; i++) {
          const ch = String.fromCharCode(emu.memory.readU8(lpString + i));
          fillTextBitmap(dc.ctx, ch, cx, yPos);
          cx += emu.memory.readI16(lpDx + i * 2);
        }
      } else {
        let text = '';
        for (let i = 0; i < cbCount; i++) {
          text += String.fromCharCode(emu.memory.readU8(lpString + i));
        }
        fillTextBitmap(dc.ctx, text, xPos, yPos);
      }
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ordinal 360: CreatePalette(lpLogPalette) — pascal -ret16, 4 bytes
  gdi.register('ord_360', 4, () => {
    const lpLogPalette = emu.readArg16DWord(0);
    if (lpLogPalette) {
      const count = emu.memory.readU16(lpLogPalette + 2);
      const entries = new Uint8Array(count * 4);
      for (let i = 0; i < count * 4; i++) {
        entries[i] = emu.memory.readU8(lpLogPalette + 4 + i);
      }
      const pal: PaletteInfo = { entries, count };
      return emu.handles.alloc('palette', pal);
    }
    return emu.handles.alloc('palette', { entries: new Uint8Array(0), count: 0 });
  });

  // Ordinal 361: GDISelectPalette(hdc, hPal, bForceBackground) — pascal -ret16, 6 bytes
  gdi.register('ord_361', 6, () => {
    const [hdc, hPal, bForce] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.selectedPalette || hPal;
      dc.selectedPalette = hPal;
      return old;
    }
    return 0;
  });

  // Ordinal 362: GDIRealizePalette(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_362', 2, () => 0);

  // Ordinal 363: GetPaletteEntries(hPal, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_363', 10, () => {
    const [hPal, wStart, wNum, lpEntries] = emu.readPascalArgs16([2, 2, 2, 4]);
    const pal = emu.handles.get<PaletteInfo>(hPal);
    if (pal && lpEntries) {
      const count = Math.min(wNum, pal.count - wStart);
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < 4; j++) {
          emu.memory.writeU8(lpEntries + i * 4 + j, pal.entries[(wStart + i) * 4 + j]);
        }
      }
      return count;
    }
    return 0;
  });

  // Ordinal 364: SetPaletteEntries(hPal, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_364', 10, () => {
    const [hPal, wStart, wNum, lpEntries] = emu.readPascalArgs16([2, 2, 2, 4]);
    const pal = emu.handles.get<PaletteInfo>(hPal);
    if (pal && lpEntries) {
      const count = Math.min(wNum, pal.count - wStart);
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < 4; j++) {
          pal.entries[(wStart + i) * 4 + j] = emu.memory.readU8(lpEntries + i * 4 + j);
        }
      }
      return count;
    }
    return 0;
  });

  // Ordinal 365: RealizeDefaultPalette(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_365', 2, () => 0);

  // Ordinal 366: UpdateColors(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_366', 2, () => 0);

  // Ordinal 367: AnimatePalette(hPal, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_367', 10, () => 1);

  // Ordinal 368: ResizePalette(hPal, nEntries) — pascal -ret16, 4 bytes
  gdi.register('ord_368', 4, () => 1);

  // Ordinal 370: GetNearestPaletteIndex(hPal, crColor) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_370', 6, () => 0);

  // Ordinal 372: ExtFloodFill(hdc, x, y, crColor, fuFillType) — pascal -ret16, 12 bytes (2+2+2+4+2)
  // fuFillType: FLOODFILLBORDER=0, FLOODFILLSURFACE=1
  gdi.register('ord_372', 12, () => {
    const [hdc, x, y, crColor, fuFillType] = emu.readPascalArgs16([2, 2, 2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const brush = emu.getBrush(dc.selectedBrush);
    if (!brush || brush.isNull) return 0;
    const fillR = brush.color & 0xFF, fillG = (brush.color >> 8) & 0xFF, fillB = (brush.color >> 16) & 0xFF;
    const tgtR = crColor & 0xFF, tgtG = (crColor >> 8) & 0xFF, tgtB = (crColor >> 16) & 0xFF;
    const w = dc.canvas.width, h = dc.canvas.height;
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    const imgData = dc.ctx.getImageData(0, 0, w, h);
    const px = imgData.data;

    const FLOODFILLSURFACE = 1;
    let shouldFill: (i: number) => boolean;
    if (fuFillType === FLOODFILLSURFACE) {
      // Fill while pixel matches crColor (surface fill)
      const startIdx = (y * w + x) * 4;
      if (px[startIdx] !== tgtR || px[startIdx + 1] !== tgtG || px[startIdx + 2] !== tgtB) return 0;
      if (fillR === tgtR && fillG === tgtG && fillB === tgtB) return 1; // already filled
      shouldFill = (i: number) => px[i] === tgtR && px[i + 1] === tgtG && px[i + 2] === tgtB;
    } else {
      // Fill until boundary color hit
      const startIdx = (y * w + x) * 4;
      if (px[startIdx] === tgtR && px[startIdx + 1] === tgtG && px[startIdx + 2] === tgtB) return 0;
      shouldFill = (i: number) => !(px[i] === tgtR && px[i + 1] === tgtG && px[i + 2] === tgtB);
    }

    const visited = new Uint8Array(w * h);
    const stack = [x + y * w];
    visited[x + y * w] = 1;
    while (stack.length > 0) {
      const pos = stack.pop()!;
      const px0 = pos % w;
      const i = pos * 4;
      px[i] = fillR; px[i + 1] = fillG; px[i + 2] = fillB; px[i + 3] = 255;
      const neighbors = [pos - 1, pos + 1, pos - w, pos + w];
      for (const n of neighbors) {
        if (n < 0 || n >= w * h) continue;
        const nx = n % w;
        if (Math.abs(nx - px0) > 1) continue;
        if (visited[n]) continue;
        visited[n] = 1;
        if (shouldFill(n * 4)) stack.push(n);
      }
    }
    dc.ctx.putImageData(imgData, 0, 0);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ordinal 373: SetSystemPaletteUse(hdc, wUsage) — pascal -ret16, 4 bytes
  gdi.register('ord_373', 4, () => 1); // SYSPAL_STATIC

  // Ordinal 374: GetSystemPaletteUse(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_374', 2, () => 1); // SYSPAL_STATIC

  // Ordinal 375: GetSystemPaletteEntries(hdc, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_375', 10, () => 0);

  // Ordinal 377: StartDoc(hdc, lpDocInfo) — pascal -ret16, 6 bytes (2+4)
  // NOTE: Ordinal 377 is StartDoc in the Wine spec, not CreateDIBitmap. CreateDIBitmap is 442.
  gdi.register('ord_377', 6, () => 1);

  // Ordinal 378: EndDoc(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_378', 2, () => 1);

  // Ordinal 379: StartPage(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_379', 2, () => 1);

  // Ordinal 380: EndPage(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_380', 2, () => 1);

  // Ordinal 439: StretchDIBits(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, lpBits, lpBitsInfo, fuUsage, rop)
  // pascal -ret16, 28 bytes (2+2+2+2+2+2+2+2+2+4+4+2+4)
  gdi.register('ord_439', 28, () => {
    const [hdc, xDstRaw, yDstRaw, wDstRaw, hDstRaw, xSrcRaw, ySrcRaw, wSrcRaw, hSrcRaw, bitsPtr, bmiPtr, fuUsage, rop] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 2, 4]);
    const dc = emu.getDC(hdc);
    if (!dc || !bitsPtr || !bmiPtr) return 0;

    const xDst = (xDstRaw << 16) >> 16;
    const yDst = (yDstRaw << 16) >> 16;
    const wDst = (wDstRaw << 16) >> 16;
    const hDst = (hDstRaw << 16) >> 16;
    const xSrc = (xSrcRaw << 16) >> 16;
    const ySrc = (ySrcRaw << 16) >> 16;
    const wSrc = (wSrcRaw << 16) >> 16;
    const hSrc = (hSrcRaw << 16) >> 16;

    const biSize = emu.memory.readU32(bmiPtr);
    const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const biHeight = emu.memory.readI32(bmiPtr + 8);
    const biBitCount = emu.memory.readU16(bmiPtr + 14);
    const biCompression = emu.memory.readU32(bmiPtr + 16);
    const biClrUsed = emu.memory.readU32(bmiPtr + 32);
    const isBottomUp = biHeight > 0;
    const absHeight = Math.abs(biHeight);

    if (biCompression !== 0) return 0; // BI_RGB only

    const paddedRow = calcDIBStride(biWidth, biBitCount);
    if (!paddedRow) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const palette = readDIBPalette(emu, dc, bmiPtr, biSize, numColors, fuUsage);

    const absWDst = Math.abs(wDst);
    const absHDst = Math.abs(hDst);
    const absWSrc = Math.abs(wSrc);
    const absHSrc = Math.abs(hSrc);
    if (absWDst <= 0 || absHDst <= 0 || absWSrc <= 0 || absHSrc <= 0) return 0;

    // Decode source rectangle into a temporary canvas
    const srcCanvas = new OffscreenCanvas(absWSrc, absHSrc);
    const srcCtx = srcCanvas.getContext('2d')!;
    const srcImg = srcCtx.createImageData(absWSrc, absHSrc);
    const srcPx = srcImg.data;

    for (let y = 0; y < absHSrc; y++) {
      const srcY = ySrc + (hSrc > 0 ? y : absHSrc - 1 - y);
      // Map srcY to DIB scan line
      const scanLine = isBottomUp ? (absHeight - 1 - srcY) : srcY;
      if (scanLine < 0 || scanLine >= absHeight) continue;
      const rowStart = bitsPtr + scanLine * paddedRow;

      for (let x = 0; x < absWSrc; x++) {
        const srcX = xSrc + (wSrc > 0 ? x : absWSrc - 1 - x);
        if (srcX < 0 || srcX >= biWidth) continue;
        const [r, g, b] = readDIBPixel(emu, rowStart, srcX, biBitCount, palette);
        const off = (y * absWSrc + x) * 4;
        srcPx[off] = r; srcPx[off + 1] = g; srcPx[off + 2] = b; srcPx[off + 3] = 255;
      }
    }
    srcCtx.putImageData(srcImg, 0, 0);

    // Stretch to destination
    const dstX = wDst > 0 ? xDst : xDst + wDst;
    const dstY = hDst > 0 ? yDst : yDst + hDst;

    if (rop === BLACKNESS16) {
      dc.ctx.fillStyle = '#000';
      dc.ctx.fillRect(dstX, dstY, absWDst, absHDst);
    } else if (rop === WHITENESS16) {
      dc.ctx.fillStyle = '#fff';
      dc.ctx.fillRect(dstX, dstY, absWDst, absHDst);
    } else {
      dc.ctx.drawImage(srcCanvas, 0, 0, absWSrc, absHSrc, dstX, dstY, absWDst, absHDst);
    }

    emu.syncDCToCanvas(hdc);
    return absHSrc;
  });

  // Ordinal 440: SetDIBits(hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse) — pascal -ret16, 18 bytes (2+2+2+2+4+4+2)
  gdi.register('ord_440', 18, () => {
    const [hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse] =
      emu.readPascalArgs16([2, 2, 2, 2, 4, 4, 2]);
    const bmp = emu.handles.get<BitmapInfo>(hbmp);
    if (!bmp || !lpvBits || !lpbmi) return 0;

    const biWidth = Math.abs(emu.memory.readI32(lpbmi + 4));
    const biHeight = emu.memory.readI32(lpbmi + 8);
    const biBitCount = emu.memory.readU16(lpbmi + 14);
    const biSize = emu.memory.readU32(lpbmi);
    const biClrUsed = emu.memory.readU32(lpbmi + 32);
    const absHeight = Math.abs(biHeight);

    const paddedRow = calcDIBStride(biWidth, biBitCount);
    if (!paddedRow) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const dc = emu.getDC(hdc);
    const palette = dc ? readDIBPalette(emu, dc, lpbmi, biSize, numColors, fuColorUse) : readDIBPalette(emu, {} as DCInfo, lpbmi, biSize, numColors, 0);

    const lines = Math.min(cScanLines, absHeight - uStartScan);
    const drawW = Math.min(biWidth, bmp.width);
    const drawH = Math.min(lines, bmp.height);
    if (drawW <= 0 || drawH <= 0) return 0;

    const imgData = bmp.ctx.createImageData(drawW, drawH);
    const px = imgData.data;
    const isBottomUp = biHeight > 0;

    for (let y = 0; y < drawH; y++) {
      const srcRow = lpvBits + (uStartScan + y) * paddedRow;
      const outY = isBottomUp ? (drawH - 1 - y) : y;
      for (let x = 0; x < drawW; x++) {
        const [r, g, b] = readDIBPixel(emu, srcRow, x, biBitCount, palette);
        const off = (outY * drawW + x) * 4;
        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
      }
    }
    bmp.ctx.putImageData(imgData, 0, 0);
    return lines;
  });

  // Ordinal 441: GetDIBits(hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse) — pascal -ret16, 18 bytes (2+2+2+2+4+4+2)
  gdi.register('ord_441', 18, () => {
    const [hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, _fuColorUse] =
      emu.readPascalArgs16([2, 2, 2, 2, 4, 4, 2]);
    const bmp = emu.handles.get<BitmapInfo>(hbmp);
    if (!bmp || !lpbmi) return 0;

    const absH = bmp.height;
    // If lpvBits is NULL, just fill in the BITMAPINFOHEADER
    if (!lpvBits) {
      emu.memory.writeU32(lpbmi, 40);           // biSize
      emu.memory.writeI32(lpbmi + 4, bmp.width);
      emu.memory.writeI32(lpbmi + 8, bmp.height);
      emu.memory.writeU16(lpbmi + 12, 1);       // biPlanes
      emu.memory.writeU16(lpbmi + 14, 24);      // biBitCount
      emu.memory.writeU32(lpbmi + 16, 0);       // biCompression = BI_RGB
      const stride = (bmp.width * 3 + 3) & ~3;
      emu.memory.writeU32(lpbmi + 20, stride * absH); // biSizeImage
      return absH;
    }

    // Read pixels from bitmap canvas and write as 24bpp bottom-up DIB
    const lines = Math.min(cScanLines, absH - uStartScan);
    if (lines <= 0) return 0;
    const stride = (bmp.width * 3 + 3) & ~3;
    const imgData = bmp.ctx.getImageData(0, 0, bmp.width, absH);
    const px = imgData.data;

    for (let y = 0; y < lines; y++) {
      const srcY = absH - 1 - (uStartScan + y); // bottom-up
      const dstRow = lpvBits + y * stride;
      for (let x = 0; x < bmp.width; x++) {
        const si = (srcY * bmp.width + x) * 4;
        emu.memory.writeU8(dstRow + x * 3, px[si + 2]);     // B
        emu.memory.writeU8(dstRow + x * 3 + 1, px[si + 1]); // G
        emu.memory.writeU8(dstRow + x * 3 + 2, px[si]);     // R
      }
    }
    return lines;
  });

  // Ordinal 442: CreateDIBitmap(hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage) — pascal -ret16, 20 bytes (2+4+4+4+4+2)
  gdi.register('ord_442', 20, () => {
    const [hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage] =
      emu.readPascalArgs16([2, 4, 4, 4, 4, 2]);
    let w = 1, h = 1;
    if (lpbmih) {
      w = emu.memory.readU32(lpbmih + 4) || 1;
      h = Math.abs(emu.memory.readI32(lpbmih + 8)) || 1;
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  });

  // Ordinal 443: SetDIBitsToDevice(hdc, xDst, yDst, cx, cy, xSrc, ySrc, startScan, numScans, lpBits, lpBitsInfo, fuUsage)
  // pascal -ret16, 24 bytes (2+2+2+2+2+2+2+2+2+4+4+2)
  gdi.register('ord_443', 24, () => {
    const [hdc, xDest, yDest, width, height, xSrc, ySrc, startScan, numScans, bitsPtr, bmiPtr, fuUsage] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !bitsPtr || !bmiPtr) return 0;

    const biSize = emu.memory.readU32(bmiPtr);
    const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const biHeight = emu.memory.readI32(bmiPtr + 8);
    const biBitCount = emu.memory.readU16(bmiPtr + 14);
    const biCompression = emu.memory.readU32(bmiPtr + 16);
    const biClrUsed = emu.memory.readU32(bmiPtr + 32);
    const isBottomUp = biHeight > 0;
    const absHeight = Math.abs(biHeight);

    if (biCompression !== 0) return 0; // BI_RGB only

    const paddedRow = calcDIBStride(biWidth, biBitCount);
    if (!paddedRow) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const palette = readDIBPalette(emu, dc, bmiPtr, biSize, numColors, fuUsage);

    const drawW = Math.min(width, biWidth - xSrc);
    const drawH = Math.min(height, absHeight);
    if (drawW <= 0 || drawH <= 0) return 0;

    const imgData = dc.ctx.createImageData(drawW, drawH);
    const px = imgData.data;

    for (let y = 0; y < drawH; y++) {
      const scanLine = isBottomUp ? (ySrc + drawH - 1 - y) : (ySrc + y);
      const bufferRow = scanLine - startScan;
      if (bufferRow < 0 || bufferRow >= numScans) continue;

      const rowStart = bitsPtr + bufferRow * paddedRow;
      for (let x = 0; x < drawW; x++) {
        const [r, g, b] = readDIBPixel(emu, rowStart, xSrc + x, biBitCount, palette);
        const off = (y * drawW + x) * 4;
        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
      }
    }

    dc.ctx.putImageData(imgData, (xDest << 16) >> 16, (yDest << 16) >> 16);
    emu.syncDCToCanvas(hdc);
    return drawH;
  });

  // Ordinal 444: CreateRoundRectRgn(l, t, r, b, w, h) — pascal -ret16, 12 bytes
  gdi.register('ord_444', 12, () => emu.handles.alloc('region', {}));

  // Ordinal 445: CreateDIBPatternBrush(hGlobal, fuColorSpec) — pascal -ret16, 4 bytes
  gdi.register('ord_445', 4, () => {
    const brush: BrushInfo = { color: 0, isNull: false };
    return emu.handles.alloc('brush', brush);
  });

  // Ordinal 450: PolyPolygon(hdc, lpPoints, lpPolyCounts, nCount) — pascal -ret16, 12 bytes (2+4+4+2)
  gdi.register('ord_450', 12, () => {
    const [hdc, lpPoints, lpPolyCounts, nCount] = emu.readPascalArgs16([2, 4, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints || !lpPolyCounts || nCount <= 0) return 0;

    dc.ctx.beginPath();
    let ptOffset = 0;
    for (let poly = 0; poly < nCount; poly++) {
      const vertCount = emu.memory.readI16(lpPolyCounts + poly * 2);
      for (let i = 0; i < vertCount; i++) {
        const px = emu.memory.readI16(lpPoints + (ptOffset + i) * 4);
        const py = emu.memory.readI16(lpPoints + (ptOffset + i) * 4 + 2);
        if (i === 0) dc.ctx.moveTo(px, py);
        else dc.ctx.lineTo(px, py);
      }
      dc.ctx.closePath();
      ptOffset += vertCount;
    }
    fillAndStroke(dc);
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ordinal 461: SetObjectOwner(hObj, hOwner) — pascal -ret16, 4 bytes
  gdi.register('ord_461', 4, () => 1);

  // Ordinal 462: IsGDIObject(hObj) — pascal -ret16, 2 bytes
  gdi.register('ord_462', 2, () => {
    const hObj = emu.readArg16(0);
    return emu.handles.getType(hObj) ? 1 : 0;
  });

  // Ordinal 465: RectVisible(hdc, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_465', 6, () => 1);

  // Ordinal 466: RectInRegion(hRgn, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_466', 6, () => 0);

  // Ordinal 468: GetBitmapDimensionEx(hbmp, lpDimension) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_468', 6, () => {
    const [hbmp, lpDimension] = emu.readPascalArgs16([2, 4]);
    if (lpDimension) {
      const bmp = emu.handles.get<BitmapInfo>(hbmp);
      if (bmp) {
        emu.memory.writeU16(lpDimension, bmp.width);
        emu.memory.writeU16(lpDimension + 2, bmp.height);
      } else {
        emu.memory.writeU32(lpDimension, 0);
      }
    }
    return 1;
  });

  // Ordinal 469: GetBrushOrgEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_469', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpPoint) {
      emu.memory.writeI16(lpPoint, dc?.brushOrgX ?? 0);
      emu.memory.writeI16(lpPoint + 2, dc?.brushOrgY ?? 0);
    }
    return 1;
  });

  // Ordinal 470: GetCurrentPositionEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_470', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc && lpPoint) {
      emu.memory.writeI16(lpPoint, dc.penPosX);
      emu.memory.writeI16(lpPoint + 2, dc.penPosY);
    }
    return 1;
  });

  // Ordinal 471: GetTextExtentPoint(hdc, lpString, cbString, lpSize) — pascal -ret16, 12 bytes (2+4+2+4)
  gdi.register('ord_471', 12, () => {
    const [hdc, lpString, cbString, lpSize] = emu.readPascalArgs16([2, 4, 2, 4]);
    if (lpSize) {
      const fontSize = getFontSize(hdc);
      const dc = emu.getDC(hdc);
      let width = cbString * Math.round(fontSize * 0.5);
      if (dc && lpString && cbString > 0) {
        let text = '';
        for (let i = 0; i < cbString; i++) text += String.fromCharCode(emu.memory.readU8(lpString + i));
        dc.ctx.font = getFontCSS(hdc);
        width = Math.ceil(dc.ctx.measureText(text).width);
      }
      emu.memory.writeI16(lpSize, width);
      emu.memory.writeI16(lpSize + 2, fontSize);
    }
    return 1;
  });

  // Ordinal 472: GetViewportExtEx(hdc, lpSize) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_472', 6, () => {
    const [hdc, lpSize] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpSize) {
      emu.memory.writeI16(lpSize, dc?.viewportExtX ?? 1);
      emu.memory.writeI16(lpSize + 2, dc?.viewportExtY ?? 1);
    }
    return 1;
  });

  // Ordinal 473: GetViewportOrgEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_473', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpPoint) {
      emu.memory.writeI16(lpPoint, dc?.viewportOrgX ?? 0);
      emu.memory.writeI16(lpPoint + 2, dc?.viewportOrgY ?? 0);
    }
    return 1;
  });

  // Ordinal 474: GetWindowExtEx(hdc, lpSize) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_474', 6, () => {
    const [hdc, lpSize] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpSize) {
      emu.memory.writeI16(lpSize, dc?.windowExtX ?? 1);
      emu.memory.writeI16(lpSize + 2, dc?.windowExtY ?? 1);
    }
    return 1;
  });

  // Ordinal 475: GetWindowOrgEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_475', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpPoint) {
      emu.memory.writeI16(lpPoint, dc?.windowOrgX ?? 0);
      emu.memory.writeI16(lpPoint + 2, dc?.windowOrgY ?? 0);
    }
    return 1;
  });

  // Ordinal 476: OffsetViewportOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_476', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.viewportOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.viewportOrgY ?? 0);
      }
      dc.viewportOrgX = (dc.viewportOrgX ?? 0) + ((x << 16) >> 16);
      dc.viewportOrgY = (dc.viewportOrgY ?? 0) + ((y << 16) >> 16);
    }
    return 1;
  });

  // Ordinal 477: OffsetWindowOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_477', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.windowOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.windowOrgY ?? 0);
      }
      dc.windowOrgX = (dc.windowOrgX ?? 0) + ((x << 16) >> 16);
      dc.windowOrgY = (dc.windowOrgY ?? 0) + ((y << 16) >> 16);
    }
    return 1;
  });

  // Ordinal 478: SetBitmapDimensionEx(hBitmap, x, y, lpSize) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_478', 10, () => 1);

  // Ordinal 479: SetViewportExtEx(hdc, x, y, lpSize) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_479', 10, () => {
    const [hdc, x, y, lpSize] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.viewportExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.viewportExtY ?? 1);
      }
      dc.viewportExtX = (x << 16) >> 16;
      dc.viewportExtY = (y << 16) >> 16;
    }
    return 1;
  });

  // Ordinal 480: SetViewportOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_480', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.viewportOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.viewportOrgY ?? 0);
      }
      dc.viewportOrgX = (x << 16) >> 16;
      dc.viewportOrgY = (y << 16) >> 16;
    }
    return 1;
  });

  // Ordinal 481: SetWindowExtEx(hdc, x, y, lpSize) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_481', 10, () => {
    const [hdc, x, y, lpSize] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.windowExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.windowExtY ?? 1);
      }
      dc.windowExtX = (x << 16) >> 16;
      dc.windowExtY = (y << 16) >> 16;
    }
    return 1;
  });

  // Ordinal 482: SetWindowOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_482', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.windowOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.windowOrgY ?? 0);
      }
      dc.windowOrgX = (x << 16) >> 16;
      dc.windowOrgY = (y << 16) >> 16;
    }
    return 1;
  });

  // Ordinal 483: MoveToEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_483', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.penPosX);
        emu.memory.writeI16(lpPoint + 2, dc.penPosY);
      }
      dc.penPosX = (x << 16) >> 16;
      dc.penPosY = (y << 16) >> 16;
    }
    return 1;
  });

  // Ordinal 489: CreateDIBSection(hdc, lpbmi, fuUsage, lplpvBits, hSection, dwOffset) — pascal -ret16, 20 bytes (2+4+2+4+4+4)
  gdi.register('ord_489', 20, () => {
    const [hdc, lpbmi, fuUsage, lplpvBits, hSection, dwOffset] =
      emu.readPascalArgs16([2, 4, 2, 4, 4, 4]);
    let w = 1, h = 1, bpp = 8;
    if (lpbmi) {
      w = Math.abs(emu.memory.readI32(lpbmi + 4)) || 1;
      h = Math.abs(emu.memory.readI32(lpbmi + 8)) || 1;
      bpp = emu.memory.readU16(lpbmi + 14) || 8;
    }
    // Allocate pixel buffer in emulated memory
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    const bufSize = stride * h;
    const pixelBuf = emu.allocHeap(bufSize);
    if (lplpvBits) emu.memory.writeU32(lplpvBits, pixelBuf);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx, dibBitsPtr: pixelBuf, dibBpp: bpp };
    return emu.handles.alloc('bitmap', bmp);
  });

  // Ordinal 502: PolyBezier(hdc, lppt, cPoints) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_502', 8, () => {
    const [hdc, lppt, cPoints] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lppt || cPoints < 4) return 0;
    dc.ctx.beginPath();
    const x0 = emu.memory.readI16(lppt);
    const y0 = emu.memory.readI16(lppt + 2);
    dc.ctx.moveTo(x0, y0);
    for (let i = 1; i + 2 < cPoints; i += 3) {
      const cp1x = emu.memory.readI16(lppt + (i) * 4);
      const cp1y = emu.memory.readI16(lppt + (i) * 4 + 2);
      const cp2x = emu.memory.readI16(lppt + (i + 1) * 4);
      const cp2y = emu.memory.readI16(lppt + (i + 1) * 4 + 2);
      const ex = emu.memory.readI16(lppt + (i + 2) * 4);
      const ey = emu.memory.readI16(lppt + (i + 2) * 4 + 2);
      dc.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = pen.width || 1;
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ordinal 503: PolyBezierTo(hdc, lppt, cPoints) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_503', 8, () => {
    const [hdc, lppt, cPoints] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lppt || cPoints < 3) return 0;
    dc.ctx.beginPath();
    dc.ctx.moveTo(dc.penPosX, dc.penPosY);
    for (let i = 0; i + 2 < cPoints; i += 3) {
      const cp1x = emu.memory.readI16(lppt + (i) * 4);
      const cp1y = emu.memory.readI16(lppt + (i) * 4 + 2);
      const cp2x = emu.memory.readI16(lppt + (i + 1) * 4);
      const cp2y = emu.memory.readI16(lppt + (i + 1) * 4 + 2);
      const ex = emu.memory.readI16(lppt + (i + 2) * 4);
      const ey = emu.memory.readI16(lppt + (i + 2) * 4 + 2);
      dc.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
    }
    // Update pen position to last point
    const lastIdx = cPoints - 1;
    dc.penPosX = emu.memory.readI16(lppt + lastIdx * 4);
    dc.penPosY = emu.memory.readI16(lppt + lastIdx * 4 + 2);
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = pen.width || 1;
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // Ordinal 508: ExtSelectClipRgn(hdc, hRgn, fnMode) — pascal -ret16, 6 bytes
  gdi.register('ord_508', 6, () => SIMPLEREGION);

  // Ordinal 529: CreateHalftonePalette(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_529', 2, () => emu.handles.alloc('palette', { entries: new Uint8Array(0), count: 0 }));

  // Ordinal 612: GetTextCharset(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_612', 2, () => 0); // ANSI_CHARSET

  // Ordinal 613: EnumFontFamiliesEx(hdc, lpLogFont, lpEnumFontFamExProc, lParam, dwFlags) — pascal -ret16, 18 bytes (2+4+4+4+4)
  gdi.register('ord_613', 18, () => 0);

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional Wine-referenced GDI16 APIs
  // ═══════════════════════════════════════════════════════════════════════════

  // Ordinal 121: Death(hdc) — pascal -ret16, 2 bytes (prepares for mode switch)
  gdi.register('ord_121', 2, () => 1);

  // Ordinal 122: Resurrection(hdc, w1, w2, w3, w4, w5, w6) — pascal -ret16, 14 bytes
  gdi.register('ord_122', 14, () => 1);

  // Ordinal 123: PlayMetaFile(hdc, hmf) — pascal -ret16, 4 bytes
  gdi.register('ord_123', 4, () => 1);

  // Ordinal 124: GetMetaFile(lpFileName) — pascal -ret16, 4 bytes
  gdi.register('ord_124', 4, () => 0);

  // Ordinal 125: CreateMetaFile(lpFileName) — pascal -ret16, 4 bytes
  gdi.register('ord_125', 4, () => 0);

  // Ordinal 126: CloseMetaFile(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_126', 2, () => 0);

  // Ordinal 127: DeleteMetaFile(hmf) — pascal -ret16, 2 bytes
  gdi.register('ord_127', 2, () => 1);

  // Ordinal 132: SetEnvironment(lpPortName, lpEnviron, nCount) — pascal -ret16, 10 bytes (4+4+2)
  gdi.register('ord_132', 10, () => 0);

  // Ordinal 133: GetEnvironment(lpPortName, lpEnviron, nMaxCount) — pascal -ret16, 10 bytes (4+4+2)
  gdi.register('ord_133', 10, () => 0);

  // Ordinal 151: CopyMetaFile(hmfSrc, lpFileName) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_151', 6, () => 0);

  // Ordinal 155: QueryAbort(hdc, reserved) — pascal -ret16, 4 bytes
  gdi.register('ord_155', 4, () => 1); // continue

  // Ordinal 159: GetMetaFileBits(hmf) — pascal -ret16, 2 bytes
  gdi.register('ord_159', 2, () => 0);

  // Ordinal 160: SetMetaFileBits(hMem) — pascal -ret16, 2 bytes
  gdi.register('ord_160', 2, () => 0);

  // Ordinal 175: EnumMetaFile(hdc, hmf, lpMFFunc, lParam) — pascal -ret16, 12 bytes (2+2+4+4)
  gdi.register('ord_175', 12, () => 1);

  // Ordinal 176: PlayMetaFileRecord(hdc, lpHandleTable, lpMR, nHandles) — pascal -ret16, 12 bytes (2+4+4+2)
  gdi.register('ord_176', 12, () => 1);

  // Ordinal 179: GetDCState(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_179', 2, () => 0);

  // Ordinal 180: SetDCState(hdc, hSavedDC) — pascal -ret16, 4 bytes
  gdi.register('ord_180', 4, () => 0);

  // Ordinal 181: RectInRegion(hRgn, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_181', 6, () => 1);

  // Ordinal 190: SetDCHook(hdc, hookProc, dwHookData) — pascal -ret16, 10 bytes (2+4+4)
  gdi.register('ord_190', 10, () => 1);

  // Ordinal 191: GetDCHook(hdc, lpHookData) — pascal, 6 bytes (2+4)
  gdi.register('ord_191', 6, () => 0);

  // Ordinal 192: SetHookFlags(hdc, flags) — pascal -ret16, 4 bytes
  gdi.register('ord_192', 4, () => 0);

  // Ordinal 193: SetBoundsRect(hdc, lprcBounds, flags) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_193', 8, () => 0);

  // Ordinal 194: GetBoundsRect(hdc, lprcBounds, flags) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('ord_194', 8, () => 0);

  // Ordinal 196: SetMetaFileBitsBetter(hMem) — pascal -ret16, 2 bytes
  gdi.register('ord_196', 2, () => 0);

  // Ordinal 308: GetOutlineTextMetrics(hdc, cbData, lpOTM) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('ord_308', 8, () => 0); // not supported

  // Ordinal 309: GetGlyphOutline(hdc, uChar, fuFormat, lpgm, cbBuffer, lpBuffer, lpmat2) — 22 bytes
  gdi.register('ord_309', 22, () => 0xFFFFFFFF); // GDI_ERROR

  // Ordinal 310: CreateScalableFontResource(fHidden, lpszResFile, lpszFontFile, lpszCurPath) — 16 bytes (2+4+4+4)
  gdi.register('ord_310', 16, () => 0);

  // Ordinal 311: GetFontData(hdc, dwTable, dwOffset, lpvBuffer, cbData) — 14 bytes (2+4+4+4+4→ wait, need to check)
  gdi.register('ord_311', 14, () => 0xFFFFFFFF); // GDI_ERROR

  // Ordinal 313: GetRasterizerCaps(lprs, cb) — pascal -ret16, 6 bytes (4+2)
  gdi.register('ord_313', 6, () => {
    const [lprs, cb] = emu.readPascalArgs16([4, 2]);
    if (lprs && cb >= 4) {
      emu.memory.writeU16(lprs, 4);     // nSize
      emu.memory.writeU16(lprs + 2, 3); // wFlags: TT_AVAILABLE | TT_ENABLED
    }
    return 1;
  });

  // Ordinal 332: GetKerningPairs(hdc, nNumPairs, lpkrnpair) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('ord_332', 8, () => 0);

  // Ordinal 376: ResetDC(hdc, lpDevMode) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_376', 6, () => {
    return emu.readArg16(0); // return the hdc
  });

  // Ordinal 377: StartDoc(hdc, lpdi) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_377', 6, () => 1);

  // Ordinal 378: EndDoc(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_378', 2, () => 1);

  // Ordinal 379: StartPage(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_379', 2, () => 1);

  // Ordinal 380: EndPage(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_380', 2, () => 1);

  // Ordinal 381: SetAbortProc(hdc, lpAbortProc) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_381', 6, () => 1);

  // Ordinal 382: AbortDoc(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_382', 2, () => 1);

  // Ordinal 400: FastWindowFrame(hdc, lpRect, xWidth, yWidth, rop) — pascal -ret16, 14 bytes (2+4+2+2+4)
  gdi.register('ord_400', 14, () => 1);

  // Ordinal 403: GdiInit2(hInstance, hPrevInstance) — pascal -ret16, 4 bytes (2+2)
  gdi.register('ord_403', 4, () => 1);

  // Ordinal 405: FinalGdiInit(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_405', 2, () => 1);

  // Ordinal 410: IsValidMetaFile(hmf) — pascal -ret16, 2 bytes
  gdi.register('ord_410', 2, () => 0);

  // Ordinal 411: GetCurLogFont(hdc) — pascal -ret16, 2 bytes
  gdi.register('ord_411', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.selectedFont ?? 0;
  });

  // Ordinal 451: CreatePolyPolygonRgn(lpPoints, lpPolyCounts, nCount, fnPolyFillMode) — pascal -ret16, 14 bytes (4+4+2+2→ but need check)
  gdi.register('ord_451', 14, () => {
    return emu.handles.alloc('region', { type: 'poly' });
  });

  // Ordinal 484: ScaleViewportExtEx(hdc, xNum, xDenom, yNum, yDenom, lpSize) — pascal -ret16, 14 bytes (2+2+2+2+2+4)
  gdi.register('ord_484', 14, () => {
    const [hdc, xNum, xDenom, yNum, yDenom, lpSize] = emu.readPascalArgs16([2, 2, 2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.viewportExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.viewportExtY ?? 1);
      }
      const xn = (xNum << 16) >> 16, xd = (xDenom << 16) >> 16;
      const yn = (yNum << 16) >> 16, yd = (yDenom << 16) >> 16;
      if (xd && yd) {
        dc.viewportExtX = Math.round((dc.viewportExtX ?? 1) * xn / xd);
        dc.viewportExtY = Math.round((dc.viewportExtY ?? 1) * yn / yd);
      }
    }
    return 1;
  });

  // Ordinal 485: ScaleWindowExtEx(hdc, xNum, xDenom, yNum, yDenom, lpSize) — pascal -ret16, 14 bytes (2+2+2+2+2+4)
  gdi.register('ord_485', 14, () => {
    const [hdc, xNum, xDenom, yNum, yDenom, lpSize] = emu.readPascalArgs16([2, 2, 2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.windowExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.windowExtY ?? 1);
      }
      const xn = (xNum << 16) >> 16, xd = (xDenom << 16) >> 16;
      const yn = (yNum << 16) >> 16, yd = (yDenom << 16) >> 16;
      if (xd && yd) {
        dc.windowExtX = Math.round((dc.windowExtX ?? 1) * xn / xd);
        dc.windowExtY = Math.round((dc.windowExtY ?? 1) * yn / yd);
      }
    }
    return 1;
  });

  // Ordinal 486: GetAspectRatioFilterEx(hdc, lpAspectRatio) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_486', 6, () => {
    const [hdc, lpAspectRatio] = emu.readPascalArgs16([2, 4]);
    if (lpAspectRatio) {
      emu.memory.writeI16(lpAspectRatio, 0);
      emu.memory.writeI16(lpAspectRatio + 2, 0);
    }
    return 1;
  });

  // Path operations (ordinals 511-522)
  // Ordinal 511: AbortPath(hdc) — 2 bytes
  gdi.register('ord_511', 2, () => 1);

  // Ordinal 512: BeginPath(hdc) — 2 bytes
  gdi.register('ord_512', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.beginPath();
    return 1;
  });

  // Ordinal 513: CloseFigure(hdc) — 2 bytes
  gdi.register('ord_513', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.closePath();
    return 1;
  });

  // Ordinal 514: EndPath(hdc) — 2 bytes
  gdi.register('ord_514', 2, () => 1);

  // Ordinal 515: FillPath(hdc) — 2 bytes
  gdi.register('ord_515', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fill();
      }
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  // Ordinal 516: FlattenPath(hdc) — 2 bytes
  gdi.register('ord_516', 2, () => 1);

  // Ordinal 517: GetPath(hdc, lpPoints, lpTypes, nSize) — pascal -ret16, 12 bytes (2+4+4+2)
  gdi.register('ord_517', 12, () => -1); // error / no path

  // Ordinal 518: PathToRegion(hdc) — 2 bytes
  gdi.register('ord_518', 2, () => {
    return emu.handles.alloc('region', { type: 'path' });
  });

  // Ordinal 519: SelectClipPath(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('ord_519', 4, () => 1);

  // Ordinal 520: StrokeAndFillPath(hdc) — 2 bytes
  gdi.register('ord_520', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fill();
      }
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.stroke();
      }
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  // Ordinal 521: StrokePath(hdc) — 2 bytes
  gdi.register('ord_521', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.stroke();
      }
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  });

  // Ordinal 522: WidenPath(hdc) — 2 bytes
  gdi.register('ord_522', 2, () => 1);

  // Ordinal 524: GetArcDirection(hdc) — 2 bytes
  gdi.register('ord_524', 2, () => 2); // AD_COUNTERCLOCKWISE

  // Ordinal 525: SetArcDirection(hdc, dir) — pascal -ret16, 4 bytes
  gdi.register('ord_525', 4, () => 2); // return old direction

  // Ordinal 602: SetDIBColorTable(hdc, uStartIndex, cEntries, pColors) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_602', 10, () => {
    const [hdc, uStartIndex, cEntries] = emu.readPascalArgs16([2, 2, 2, 4]);
    return cEntries;
  });

  // Ordinal 603: GetDIBColorTable(hdc, uStartIndex, cEntries, pColors) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('ord_603', 10, () => 0);

  // Ordinal 604: SetSolidBrush(hBrush, color) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_604', 6, () => {
    const [hBrush, color] = emu.readPascalArgs16([2, 4]);
    const brush = emu.getBrush(hBrush);
    if (brush) brush.color = color;
    return 1;
  });

  // Ordinal 607: GetRegionData(hRgn, dwCount, lpRgnData) — pascal, 10 bytes (2+4+4)
  gdi.register('ord_607', 10, () => 0);

  // Ordinal 609: GdiFreeResources(wFlags) — pascal -ret16, 4 bytes
  gdi.register('ord_609', 4, () => 90); // 90% free

  // Ordinal 616: GetFontLanguageInfo(hdc) — pascal, 2 bytes
  gdi.register('ord_616', 2, () => 0);

  // Ordinal 1000: SetLayout(hdc, dwLayout) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ord_1000', 6, () => 0);
}
