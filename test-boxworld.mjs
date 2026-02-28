import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

class MockCtx {
  fillStyle = '#000'; strokeStyle = '#000'; font = '12px sans-serif';
  textBaseline = 'top'; lineWidth = 1; globalCompositeOperation = 'source-over';
  fillRect() {} clearRect() {} strokeRect() {} drawImage() {}
  getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData() {} beginPath() {} closePath() {} moveTo() {} lineTo() {}
  arc() {} ellipse() {} fill() {} stroke() {} fillText() {}
  measureText() { return { width: 0 }; } save() {} restore() {}
  scale() {} translate() {} setTransform() {}
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  clip() {} rect() {} setLineDash() {} quadraticCurveTo() {} bezierCurveTo() {}
  createLinearGradient() { return { addColorStop() {} }; }
  createPattern() { return {}; }
  roundRect() {}
}

class MockCanvas {
  constructor(w = 1, h = 1) { this.width = w; this.height = h; this.style = {}; }
  getContext() { return new MockCtx(); }
}

globalThis.requestAnimationFrame = (cb) => setImmediate(cb);

globalThis.OffscreenCanvas = class OffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return new MockCtx(); }
};

async function main() {
  const { parsePE } = await import('./src/lib/pe/parse.ts');
  const { Emulator } = await import('./src/lib/emu/emulator.ts');

  const buf = readFileSync(join(__dirname, 'examples', 'BOXWORLD.EXE'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const pe = parsePE(ab);

  const emu = new Emulator();
  await emu.load(ab, pe, new MockCanvas(640, 480));

  emu.run();
  const start = Date.now();
  while (Date.now() - start < 5000 && !emu.waitingForMessage && !emu.halted) {
    await new Promise(r => setTimeout(r, 10));
  }

  if (emu.halted) {
    console.log(`[TEST] FAILED: Halted at eip=0x${(emu.cpu.eip >>> 0).toString(16)}, reason: ${emu.haltReason}`);
    return;
  }

  if (!emu.waitingForMessage) {
    console.log('[TEST] FAILED: Did not reach message loop');
    return;
  }
  console.log('[TEST] SUCCESS: Reached message loop');
}

main().catch(e => console.error(e));
