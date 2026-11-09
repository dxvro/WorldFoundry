// Checks around the native libsql library (pure logic + small file accesses).
import { open } from 'node:fs/promises';

// Reads the file format and processor architecture from the header of an executable file (PE or ELF).
export function readMachine(header) {
  if (header.length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    const littleEndian = header[5] === 1;
    return { format: 'elf', value: littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18) };
  }
  if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 <= header.length && header.readUInt32LE(peOffset) === 0x00004550) {
      return { format: 'pe', value: header.readUInt16LE(peOffset + 4) };
    }
  }
  return null;
}

export async function readMachineFromFile(file) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return readMachine(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function machineMatches(found, expected) {
  return found !== null && found.format === expected.format && found.value === expected.value;
}
