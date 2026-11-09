// Windows reports a process killed from outside as the unsigned 32-bit value 0xFFFFFFFF; elsewhere that is -1.
export function normalizeExitCode(code: number | null): number | null {
  if (code === null || !Number.isInteger(code) || code <= 0x7fff_ffff || code > 0xffff_ffff) return code;
  return code - 0x1_0000_0000;
}
