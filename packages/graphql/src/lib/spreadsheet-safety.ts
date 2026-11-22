/**
 * Whether a spreadsheet is safe to unpack.
 *
 * An .xlsx file is a zip. The parser inflates every part in memory, so a 25 MB
 * upload whose parts claim gigabytes once inflated (a zip bomb) would take the
 * process down before any size check on the upload itself. The zip's central
 * directory states each part's unpacked size without unpacking anything, so it
 * is read first and the file is refused when it would grow too far.
 *
 * Only zip files are checked. Old .xls files (OLE) and text formats are not
 * compressed, so their size on disk is their size in memory.
 */

/** At most this many bytes once every part is inflated. */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
/** At most this many parts. A workbook has tens. */
export const MAX_PARTS = 10_000;
/** At most this much larger than the file once inflated. Real workbooks are well under 100. */
export const MAX_RATIO = 250;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Why the file should not be unpacked, or null when it may be. */
export function spreadsheetProblem(input: Uint8Array | ArrayBuffer): string | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isZip(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record is in the last 22 bytes plus a comment of up to 64 KB.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return 'The workbook is damaged: its contents list is missing.';

  const parts = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryAt = view.getUint32(eocd + 16, true);
  // 0xFFFF and 0xFFFFFFFF mean a ZIP64 archive, which no workbook of a size we accept needs.
  if (parts === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) {
    return 'The workbook is too large to read.';
  }
  if (parts > MAX_PARTS) return 'The workbook has too many parts to read.';
  if (directoryAt + directorySize > bytes.length) return 'The workbook is damaged: its contents list is cut off.';

  let unpacked = 0;
  let at = directoryAt;
  for (let index = 0; index < parts; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) {
      return 'The workbook is damaged: its contents list cannot be read.';
    }
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return 'The workbook is too large to read.';
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) {
      return `The workbook would take more than ${Math.round(MAX_UNPACKED_BYTES / 1024 / 1024)} MB once opened, which is more than is read.`;
    }
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  if (unpacked > Math.max(bytes.length, 1) * MAX_RATIO && unpacked > 10 * 1024 * 1024) {
    return 'The workbook expands far more than a real spreadsheet does, so it is not opened.';
  }
  return null;
}

/** Throws with the reason when a spreadsheet should not be unpacked. Call before XLSX.read. */
export function assertSafeSpreadsheet(input: Uint8Array | ArrayBuffer): void {
  const problem = spreadsheetProblem(input);
  if (problem) throw new Error(problem);
}
