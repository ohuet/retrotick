import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleInt09, handleInt16 } from './keyboard';
import { handleInt10 } from './video';
import { handleInt21 } from './int21';
import { handleInt15, handleInt1A, handleInt20, handleInt2F, handleInt79, handleInt7F, handleUcdosInt3 } from './misc';
import { handleInt33 } from './mouse';
import { handleXms, XMS_INT } from './xms';
import { handleInt67 } from './ems';
import { handleDpmiEntry, handleInt31, handleDpmiSwitch, handleDpmiCallback, DPMI_INT, DPMI_SWITCH_INT, DPMI_REFLECTOR_INT } from './dpmi';
import { handleVcpiPM, VCPI_PM_INT } from './ems';

export { handleInt21 } from './int21';
export { syncVideoMemory } from './video';

const EAX = 0;

function isFromSyntheticBiosStub(cpu: CPU, biosDefault: number): boolean {
  const seg = (biosDefault >>> 16) & 0xFFFF;
  const off = biosDefault & 0xFFFF;
  if (cpu.cs !== seg) return false;
  const ip16 = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
  // INT imm8 handler runs with IP already advanced past opcode+imm (2 bytes).
  return ip16 === ((off + 2) & 0xFFFF) || ip16 === ((off + 3) & 0xFFFF);
}

/** Handle DOS/BIOS interrupts. Returns true if handled, false if not. */
export function handleDosInt(cpu: CPU, intNum: number, emu: Emulator): boolean {
  if (emu.traceApi && intNum !== 0x08) {
    console.log(`[DOS] INT ${intNum.toString(16).padStart(2, '0')}h AH=${((cpu.getReg16(EAX) >>> 8) & 0xFF).toString(16).padStart(2, '0')}`);
  }
  // When UCDOS is active and no custom INT 3 handler installed,
  // handle INT 3 in JS as UCDOS runtime API.
  if (intNum === 3 && emu._dosUcdosStubSeg) {
    const ivtSeg3 = cpu.mem.readU16(3 * 4 + 2);
    const ivtOff3 = cpu.mem.readU16(3 * 4);
    const bd3 = emu._dosBiosDefaultVectors.get(3) ?? ((0xF000 << 16) | (3 * 5));
    const ivt3 = (ivtSeg3 << 16) | ivtOff3;
    // If IVT still points to BIOS default, handle in JS
    if (ivt3 === bd3 || ivtSeg3 === 0xF000) {
      return handleUcdosInt3(cpu, emu);
    }
    // Otherwise let IVT dispatch run the program's own handler
  }
  if (cpu.realMode) {
    const biosDefault = emu._dosBiosDefaultVectors.get(intNum) ?? ((0xF000 << 16) | (intNum * 5));
    const fromSyntheticStub = isFromSyntheticBiosStub(cpu, biosDefault);
    // Check both _dosIntVectors (set via INT 21h/AH=25h) and IVT memory
    // (written directly by programs like PoP's sound driver).
    const ivtOff = cpu.mem.readU16(intNum * 4);
    const ivtSeg = cpu.mem.readU16(intNum * 4 + 2);
    const ivtVec = (ivtSeg << 16) | ivtOff;
    let vec: number;
    if (ivtVec !== biosDefault && ivtSeg !== 0xF000) {
      vec = ivtVec;
    } else {
      vec = emu._dosIntVectors.get(intNum) ?? biosDefault;
    }
    if (vec !== biosDefault && !fromSyntheticStub) {
      const seg = (vec >>> 16) & 0xFFFF;
      const off = vec & 0xFFFF;
      const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
      cpu.push16(cpu.getFlags() & 0xFFFF);
      cpu.push16(cpu.cs);
      cpu.push16(returnIP);
      cpu.setFlags(cpu.getFlags() & ~0x0300); // clear IF+TF on interrupt entry
      cpu.cs = seg;
      cpu.eip = cpu.segBase(seg) + off;
      return true;
    }
  }

  switch (intNum) {
    case 0x03: // INT 3 — NOP if no UCDOS (UCDOS case handled above)
      return true;
    case 0x08: { // Timer tick (IRQ0) — update BIOS tick counter at 0x46C
      emu.memory.writeU32(0x46C, (emu.memory.readU32(0x46C) + 1) >>> 0);
      // Chain to INT 1Ch (user timer tick hook) like real BIOS.
      // Programs like QBasic install INT 1Ch handlers for time-based processing.
      const bios1C = emu._dosBiosDefaultVectors.get(0x1C) ?? ((0xF000 << 16) | (0x1C * 5));
      // Check IVT memory first — programs may write INT 1Ch directly
      const ivt1COff = cpu.mem.readU16(0x1C * 4);
      const ivt1CSeg = cpu.mem.readU16(0x1C * 4 + 2);
      const ivt1CVec = (ivt1CSeg << 16) | ivt1COff;
      const vec1C = (ivt1CVec !== bios1C && ivt1CSeg !== 0xF000)
        ? ivt1CVec
        : (emu._dosIntVectors.get(0x1C) ?? bios1C);
      if (vec1C && vec1C !== bios1C) {
        const seg = (vec1C >>> 16) & 0xFFFF;
        const off = vec1C & 0xFFFF;
        const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
        // Real BIOS INT 08h handler does STI before chaining to INT 1Ch,
        // so FLAGS pushed for INT 1Ch have IF=1. This allows INT 1Ch handlers
        // to IRET back to an IF=1 context, enabling nested interrupts.
        cpu.push16((cpu.getFlags() | 0x0200) & 0xFFFF);
        cpu.push16(cpu.cs);
        cpu.push16(returnIP);
        cpu.setFlags(cpu.getFlags() & ~0x0300);
        cpu.cs = seg;
        cpu.eip = cpu.segBase(seg) + off;
      }
      return true;
    }
    case 0x09: return handleInt09(cpu, emu);
    case 0x12: // Get conventional memory size → AX = KB (640)
      cpu.setReg16(EAX, 640);
      return true;
    case 0x18: // ROM BASIC — used by 256-byte intros as a cheap exit
    case 0x19: // Bootstrap loader (reboot) — also used by intros as a 2-byte exit
      emu.halted = true;
      cpu.halted = true;
      if (emu.onReboot) {
        emu.onReboot();
      }
      return true;
    case 0x10: return handleInt10(cpu, emu);
    case 0x16: return handleInt16(cpu, emu, cpu.cs === 0xF000);
    case 0x20: return handleInt20(cpu, emu);
    case 0x21: return handleInt21(cpu, emu);
    case 0x15: return handleInt15(cpu, emu);
    case 0x33: return handleInt33(cpu, emu);
    case 0x2A: // Network — not installed
      cpu.setReg8(EAX, 0); // AL=0 means not installed
      return true;
    case 0x1A: return handleInt1A(cpu, emu);
    case 0x2F: return handleInt2F(cpu, emu);
    case 0x25: { // Absolute Disk Read (fake — returns synthetic boot sector)
      // Some programs (KeyMaker 3.0) read the boot sector just to sniff drive
      // geometry or stash copy-protection keys. We don't have a real disk, so
      // hand them a plausible-looking FAT16 BPB and hope they're satisfied.
      // INT 25h/26h leave an extra copy of flags on the stack
      cpu.push16(cpu.getFlags() & 0xFFFF);
      const sectorCount = cpu.getReg16(1); // CX
      const startSector = cpu.getReg16(2); // DX
      const bufOff = cpu.getReg16(3); // BX
      const bufAddr = cpu.ds * 16 + bufOff;
      if (startSector === 0 && sectorCount >= 1) {
        // Return a minimal FAT16 boot sector (BPB)
        const bpb = new Uint8Array(512);
        bpb[0] = 0xEB; bpb[1] = 0x3C; bpb[2] = 0x90; // JMP short + NOP
        // OEM name
        const oem = 'MSDOS5.0';
        for (let i = 0; i < 8; i++) bpb[3 + i] = oem.charCodeAt(i);
        // BPB fields
        bpb[11] = 0x00; bpb[12] = 0x02; // bytes per sector = 512
        bpb[13] = 0x08;                  // sectors per cluster = 8
        bpb[14] = 0x01; bpb[15] = 0x00; // reserved sectors = 1
        bpb[16] = 0x02;                  // number of FATs = 2
        bpb[17] = 0x00; bpb[18] = 0x02; // root dir entries = 512
        // total sectors (small) = 0 (use large)
        bpb[19] = 0x00; bpb[20] = 0x00;
        bpb[21] = 0xF8;                  // media descriptor = hard disk
        bpb[22] = 0x00; bpb[23] = 0x01; // sectors per FAT = 256
        bpb[24] = 0x3F; bpb[25] = 0x00; // sectors per track = 63
        bpb[26] = 0xFF; bpb[27] = 0x00; // number of heads = 255
        // hidden sectors = 0
        // total sectors (large) = 1048576 (~512MB)
        bpb[32] = 0x00; bpb[33] = 0x00; bpb[34] = 0x10; bpb[35] = 0x00;
        bpb[510] = 0x55; bpb[511] = 0xAA; // boot signature
        for (let i = 0; i < 512; i++) cpu.mem.writeU8(bufAddr + i, bpb[i]);
      }
      cpu.setFlag(0x001, false); // CF=0 success
      return true;
    }
    case 0x26: { // Absolute Disk Write — return error
      cpu.push16(cpu.getFlags() & 0xFFFF);
      cpu.setFlag(0x001, true); // CF
      cpu.setReg16(EAX, 0x0002);
      return true;
    }
    case 0x31: return handleInt31(cpu, emu);  // DPMI services
    case 0x67: return handleInt67(cpu, emu); // EMS (Expanded Memory)
    case 0x79: return handleInt79(cpu, emu);
    case 0x7F: return handleInt7F(cpu, emu);
    case XMS_INT: return handleXms(cpu, emu);
    case DPMI_INT: return handleDpmiEntry(cpu, emu); // DPMI mode switch
    case DPMI_SWITCH_INT: return handleDpmiSwitch(cpu, emu); // Raw mode switch
    case 0xFB: return handleDpmiCallback(cpu, emu); // RM callback trap
    case VCPI_PM_INT: return handleVcpiPM(cpu, emu); // VCPI PM services
    case DPMI_REFLECTOR_INT: {
      // PM reflector: the stub set AL = original INT number before trapping here.
      // Forward to the JS/BIOS handler for that interrupt.
      const origInt = cpu.getReg8(EAX); // AL = interrupt number
      return handleDosInt(cpu, origInt, emu);
    }
    default:
      if (cpu.realMode) {
        // No custom handler — just IRET
        return true;
      }
      return false;
  }
}
