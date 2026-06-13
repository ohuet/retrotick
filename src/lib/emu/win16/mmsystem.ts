import type { Emulator } from '../emulator';

// Win16 MMSYSTEM module — sound, wave audio, and multimedia timers.
// Reference: Wine dlls/mmsystem.dll16/mmsystem.dll16.spec
//            Microsoft MMSYSTEM.H / MMSYSTEM Programmer's Reference

// MMRESULT codes
const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_NODRIVER = 6;
const WAVERR_BADFORMAT = 32;
const TIMERR_NOERROR = 0;

// Wave format
const WAVE_FORMAT_PCM = 1;
const WAVE_MAPPER = 0xFFFFFFFF;

// WAVEHDR.dwFlags bits
const WHDR_DONE = 0x00000001;
const WHDR_PREPARED = 0x00000002;

// waveOutOpen flags
const WAVE_FORMAT_QUERY = 0x0001;
const CALLBACK_TYPEMASK = 0x00070000;
const CALLBACK_NULL     = 0x00000000;
const CALLBACK_WINDOW   = 0x00010000;
const CALLBACK_TASK     = 0x00020000;
const CALLBACK_FUNCTION = 0x00030000;

// Notifications posted to callback
const MM_WOM_OPEN  = 0x3BB;
const MM_WOM_CLOSE = 0x3BC;
const MM_WOM_DONE  = 0x3BD;

// timeSetEvent fuEvent
const TIME_PERIODIC = 0x0001;

interface WaveOutDevice {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  callback: number;       // Win16 far ptr (seg:off DWORD) or hwnd
  callbackType: number;
  dwInstance: number;
  hwo: number;
  scheduledTime: number;
  startTime: number;
  nodes: { source: AudioBufferSourceNode; lpwhFar: number }[];
}

export function registerWin16Mmsystem(emu: Emulator): void {
  const mmsystem = emu.registerModule16('MMSYSTEM');

  function ensureAudioContext(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (!emu.audioContext) return null;
    if (emu.audioContext.state === 'suspended') emu.audioContext.resume();
    return emu.audioContext;
  }

  // Resolve a Win16 far pointer (DWORD packed seg:off) to a linear address.
  // Uses a freshly-loaded segment base (LoadLibrary'd resource DLL etc. may
  // reuse existing selectors, so the cached map is the source of truth here).
  function farLinear(segOff: number): number {
    if (!segOff) return 0;
    const off = segOff & 0xFFFF;
    const seg = (segOff >>> 16) & 0xFFFF;
    if (!seg) return off;
    return (emu.cpu.segBases.get(seg) ?? (seg * 0x10000)) + off;
  }

  function postWaveOutCallback(device: WaveOutDevice, message: number, lpwhFar: number) {
    if (device.callbackType === CALLBACK_WINDOW) {
      // dwParam1 = lpwh (far ptr DWORD), dwParam2 = 0
      emu.postMessage(device.callback & 0xFFFF, message, device.hwo, lpwhFar);
    } else if (device.callbackType === CALLBACK_FUNCTION) {
      // void CALLBACK waveOutProc(HWAVEOUT hwo, UINT uMsg, DWORD dwInstance,
      //                           DWORD dwParam1, DWORD dwParam2)
      // Pascal far call: 16 bytes args (2+2+4+4+4)
      emu._pendingCb16.push({
        addr: device.callback,
        args: [device.hwo, message, device.dwInstance, lpwhFar, 0],
        sizes: [2, 2, 4, 4, 4],
      });
    }
    // CALLBACK_NULL / CALLBACK_TASK → no notification
  }

  // ─────────────────────────── sndPlaySound (ord 2) ───────────────────────────
  mmsystem.register('sndPlaySound', 6, () => 1, 2);

  // ─────────────────────────── PlaySound (ord 401) ────────────────────────────
  mmsystem.register('PlaySound', 10, () => 1, 401);

  // ─── waveOutGetNumDevs (ord 403) — returns 0 if no AudioContext, else 1 ─────
  mmsystem.register('waveOutGetNumDevs', 0, () => {
    return (typeof AudioContext === 'undefined' || !emu.audioContext) ? 0 : 1;
  }, 403);

  // ─── waveOutGetDevCaps (ord 402) ────────────────────────────────────────────
  // (uDeviceID:word, lpCaps:ptr, uSize:word) — 8 bytes
  mmsystem.register('waveOutGetDevCaps', 8, () => {
    const [_uDevID, lpCapsRaw, uSize] = emu.readPascalArgs16([2, 4, 2]);
    const lpCaps = farLinear(lpCapsRaw);
    if (!lpCaps || uSize < 50) return MMSYSERR_NODRIVER;
    if (typeof AudioContext === 'undefined' || !emu.audioContext) return MMSYSERR_NODRIVER;
    // WAVEOUTCAPS16: wMid(2), wPid(2), vDriverVersion(4), szPname[32], dwFormats(4),
    //                wChannels(2), dwSupport(4) — 50 bytes total
    emu.memory.writeU16(lpCaps + 0, 0xFFFF);  // wMid (manufacturer)
    emu.memory.writeU16(lpCaps + 2, 0x0001);  // wPid (product)
    emu.memory.writeU32(lpCaps + 4, 0x0100);  // version 1.0
    const name = 'Web Audio';
    for (let i = 0; i < 32; i++) {
      emu.memory.writeU8(lpCaps + 8 + i, i < name.length ? name.charCodeAt(i) : 0);
    }
    // dwFormats: support all common formats. Bits per Win32 mmsystem.h.
    emu.memory.writeU32(lpCaps + 40, 0x0FFF);
    emu.memory.writeU16(lpCaps + 44, 2);       // wChannels (stereo)
    emu.memory.writeU32(lpCaps + 46, 0);       // dwSupport
    return MMSYSERR_NOERROR;
  }, 402);

  // ─── waveOutOpen (ord 404) ──────────────────────────────────────────────────
  // (lphDev:ptr, uDeviceID:word, lpFmt:ptr, dwCallback:long, dwInstance:long,
  //  dwFlags:long) — 22 bytes
  mmsystem.register('waveOutOpen', 22, () => {
    const [lphDevRaw, _uDevID, lpFmtRaw, dwCallback, dwInstance, dwFlags] =
      emu.readPascalArgs16([4, 2, 4, 4, 4, 4]);
    const lpFmt = farLinear(lpFmtRaw);
    if (!lpFmt) return WAVERR_BADFORMAT;

    const wFormatTag = emu.memory.readU16(lpFmt);
    if (wFormatTag !== WAVE_FORMAT_PCM) return WAVERR_BADFORMAT;
    const channels = emu.memory.readU16(lpFmt + 2);
    const sampleRate = emu.memory.readU32(lpFmt + 4);
    const bitsPerSample = emu.memory.readU16(lpFmt + 14);

    if (dwFlags & WAVE_FORMAT_QUERY) return MMSYSERR_NOERROR;

    const ctx = ensureAudioContext();
    if (!ctx) return MMSYSERR_NODRIVER;

    const device: WaveOutDevice = {
      channels, sampleRate, bitsPerSample,
      callback: dwCallback,
      callbackType: dwFlags & CALLBACK_TYPEMASK,
      dwInstance,
      hwo: 0,
      scheduledTime: 0,
      startTime: 0,
      nodes: [],
    };
    const hwo = emu.handles.alloc('waveout16', device);
    device.hwo = hwo;

    const lphDev = farLinear(lphDevRaw);
    if (lphDev) emu.memory.writeU16(lphDev, hwo);

    postWaveOutCallback(device, MM_WOM_OPEN, 0);
    return MMSYSERR_NOERROR;
  }, 404);

  // ─── waveOutClose (ord 405) ─────────────────────────────────────────────────
  mmsystem.register('waveOutClose', 2, () => {
    const [hwo] = emu.readPascalArgs16([2]);
    const device = emu.handles.get<WaveOutDevice>(hwo);
    if (!device) return MMSYSERR_INVALHANDLE;
    for (const n of device.nodes) {
      try { n.source.stop(); } catch { /* already stopped */ }
    }
    device.nodes.length = 0;
    postWaveOutCallback(device, MM_WOM_CLOSE, 0);
    emu.handles.free(hwo);
    return MMSYSERR_NOERROR;
  }, 405);

  // ─── waveOutPrepareHeader (ord 406) ─────────────────────────────────────────
  mmsystem.register('waveOutPrepareHeader', 8, () => {
    const [_hwo, lpwhRaw, _uSize] = emu.readPascalArgs16([2, 4, 2]);
    const lpwh = farLinear(lpwhRaw);
    if (!lpwh) return MMSYSERR_INVALHANDLE;
    const flags = emu.memory.readU32(lpwh + 16);
    emu.memory.writeU32(lpwh + 16, (flags | WHDR_PREPARED) & ~WHDR_DONE);
    return MMSYSERR_NOERROR;
  }, 406);

  // ─── waveOutUnprepareHeader (ord 407) ───────────────────────────────────────
  mmsystem.register('waveOutUnprepareHeader', 8, () => {
    const [_hwo, lpwhRaw, _uSize] = emu.readPascalArgs16([2, 4, 2]);
    const lpwh = farLinear(lpwhRaw);
    if (!lpwh) return MMSYSERR_INVALHANDLE;
    const flags = emu.memory.readU32(lpwh + 16);
    emu.memory.writeU32(lpwh + 16, flags & ~WHDR_PREPARED);
    return MMSYSERR_NOERROR;
  }, 407);

  // ─── waveOutWrite (ord 408) ─────────────────────────────────────────────────
  mmsystem.register('waveOutWrite', 8, () => {
    const [hwo, lpwhRaw, _uSize] = emu.readPascalArgs16([2, 4, 2]);
    const device = emu.handles.get<WaveOutDevice>(hwo);
    const lpwh = farLinear(lpwhRaw);
    if (!device || !lpwh) return MMSYSERR_INVALHANDLE;

    const lpDataFar = emu.memory.readU32(lpwh);
    const lpData = farLinear(lpDataFar);
    const dwBufferLength = emu.memory.readU32(lpwh + 4);
    const { channels, sampleRate, bitsPerSample } = device;
    const bytesPerSample = bitsPerSample >> 3;
    const numSamples = Math.floor(dwBufferLength / (bytesPerSample * channels));

    const ctx = ensureAudioContext();
    if (!ctx || numSamples === 0) {
      // Mark done immediately so the caller's mixer loop keeps progressing.
      const flags = emu.memory.readU32(lpwh + 16);
      emu.memory.writeU32(lpwh + 16, flags | WHDR_DONE);
      postWaveOutCallback(device, MM_WOM_DONE, lpwhRaw);
      return MMSYSERR_NOERROR;
    }

    const audioBuffer = ctx.createBuffer(channels, numSamples, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numSamples; i++) {
        const byteOff = lpData + (i * channels + ch) * bytesPerSample;
        if (bitsPerSample === 8) {
          channelData[i] = (emu.memory.readU8(byteOff) - 128) / 128;
        } else {
          const lo = emu.memory.readU8(byteOff);
          const hi = emu.memory.readU8(byteOff + 1);
          const sample = ((hi << 8) | lo) << 16 >> 16;
          channelData[i] = sample / 32768;
        }
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (device.scheduledTime < now) {
      device.scheduledTime = now;
      device.startTime = now;
    }
    source.start(device.scheduledTime);
    device.scheduledTime += audioBuffer.duration;
    device.nodes.push({ source, lpwhFar: lpwhRaw });

    source.onended = () => {
      const idx = device.nodes.findIndex(n => n.source === source);
      if (idx >= 0) device.nodes.splice(idx, 1);
      const flags = emu.memory.readU32(lpwh + 16);
      emu.memory.writeU32(lpwh + 16, flags | WHDR_DONE);
      postWaveOutCallback(device, MM_WOM_DONE, lpwhRaw);
    };

    return MMSYSERR_NOERROR;
  }, 408);

  // ─── waveOutReset (ord 411) ─────────────────────────────────────────────────
  mmsystem.register('waveOutReset', 2, () => {
    const [hwo] = emu.readPascalArgs16([2]);
    const device = emu.handles.get<WaveOutDevice>(hwo);
    if (!device) return MMSYSERR_INVALHANDLE;
    for (const n of device.nodes) {
      try { n.source.stop(); } catch { /* already stopped */ }
      const lpwh = farLinear(n.lpwhFar);
      if (lpwh) {
        const flags = emu.memory.readU32(lpwh + 16);
        emu.memory.writeU32(lpwh + 16, flags | WHDR_DONE);
      }
      postWaveOutCallback(device, MM_WOM_DONE, n.lpwhFar);
    }
    device.nodes.length = 0;
    device.scheduledTime = 0;
    return MMSYSERR_NOERROR;
  }, 411);

  // ─── waveOutGetPosition (ord 412) ───────────────────────────────────────────
  mmsystem.register('waveOutGetPosition', 8, () => {
    const [hwo, lpInfoRaw, uSize] = emu.readPascalArgs16([2, 4, 2]);
    const device = emu.handles.get<WaveOutDevice>(hwo);
    const lpInfo = farLinear(lpInfoRaw);
    if (!device || !lpInfo) return MMSYSERR_INVALHANDLE;
    const ctx = ensureAudioContext();
    const elapsed = ctx ? Math.max(0, ctx.currentTime - device.startTime) : 0;
    const bytesPerSec = device.sampleRate * device.channels * (device.bitsPerSample >> 3);
    const bytePos = Math.floor(elapsed * bytesPerSec) >>> 0;
    // MMTIME: wType(2) + union (variable). Write as TIME_BYTES (4).
    emu.memory.writeU16(lpInfo, 4);
    if (uSize >= 6) emu.memory.writeU32(lpInfo + 2, bytePos);
    return MMSYSERR_NOERROR;
  }, 412);

  // ─── timeSetEvent (ord 602) ─────────────────────────────────────────────────
  // (uDelay:word, uResolution:word, lpFunc:segptr, dwUser:long, uFlags:word) — 14 bytes
  let nextTimerId = 1;
  mmsystem.register('timeSetEvent', 14, () => {
    const [uDelay, _uResolution, lpFunc, dwUser, uFlags] =
      emu.readPascalArgs16([2, 2, 4, 4, 2]);
    if (!lpFunc) return 0;
    const id = nextTimerId++;
    emu._mmTimers.set(id, {
      callback: lpFunc, // far ptr seg:off
      dwUser,
      delay: Math.max(uDelay, 1),
      periodic: (uFlags & TIME_PERIODIC) !== 0,
      nextFire: Date.now() + Math.max(uDelay, 1),
    });
    return id;
  }, 602);

  // ─── timeKillEvent (ord 603) ────────────────────────────────────────────────
  mmsystem.register('timeKillEvent', 2, () => {
    const [id] = emu.readPascalArgs16([2]);
    emu._mmTimers.delete(id);
    return TIMERR_NOERROR;
  }, 603);

  // ─── timeBeginPeriod (ord 605) ──────────────────────────────────────────────
  mmsystem.register('timeBeginPeriod', 2, () => TIMERR_NOERROR, 605);

  // ─── timeEndPeriod (ord 606) ────────────────────────────────────────────────
  mmsystem.register('timeEndPeriod', 2, () => TIMERR_NOERROR, 606);

  // ─── timeGetTime (ord 607) ──────────────────────────────────────────────────
  mmsystem.register('timeGetTime', 0, () => {
    const ms = (typeof performance !== 'undefined' && performance.now)
      ? Math.floor(performance.now())
      : Date.now();
    return ms >>> 0;
  }, 607);
}
