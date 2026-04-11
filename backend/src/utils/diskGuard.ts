import fs from "node:fs";
import path from "node:path";

export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export function getDataDirPath() {
  return path.resolve(process.cwd(), "data");
}

export function readFreeBytesBestEffort(dirPath: string): number | null {
  try {
    const stat = fs.statfsSync(dirPath);
    const bsize = Number((stat as any).bsize);
    const bavail = Number((stat as any).bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail)) return null;
    return Math.max(0, Math.floor(bsize * bavail));
  } catch {
    return null;
  }
}

export function isLowDiskBestEffort(dirPath: string) {
  const freeBytes = readFreeBytesBestEffort(dirPath);
  return {
    freeBytes,
    lowDisk: freeBytes != null && freeBytes < MIN_FREE_BYTES,
  };
}
