/**
 * Defensive size cap on CSV uploads to PositionMonitor.
 *
 * The parser reads the entire file into a single string via `file.text()`
 * before parsing. Without a guard, a multi-hundred-MB CSV blocks the UI
 * thread for seconds before `parseStatement` throws. 5MB is well above
 * any legitimate thinkorswim end-of-day statement and keeps the read
 * latency under ~50ms on commodity hardware.
 */

export const MAX_CSV_UPLOAD_BYTES = 5 * 1024 * 1024;

export function validateUploadFile(file: File): string | null {
  if (file.size > MAX_CSV_UPLOAD_BYTES) {
    const maxMb = MAX_CSV_UPLOAD_BYTES / 1024 / 1024;
    return `File too large. Maximum ${String(maxMb)} MB.`;
  }
  return null;
}
