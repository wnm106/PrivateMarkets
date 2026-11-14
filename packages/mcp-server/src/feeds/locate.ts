import type { PdfPageFragments } from '@tapestrai/graphql/src/lib/import-intake';
import type { CellLocation } from './types';

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Tighten row-level locations to the cell by finding each value's text on the page.
 *
 * A reader that returns only a box for the table leaves every value in a row
 * with the row's band. When the PDF has a text layer, the text runs on that
 * page say exactly where each value is. Rows read top to bottom, so each row
 * must sit below the one before it, which keeps repeated values ("425" in every
 * row) from landing on the wrong line. A value that cannot be found keeps the
 * row box.
 */
export function refineLocations(
  headers: string[],
  rows: Record<string, string>[],
  locations: (CellLocation | null)[][],
  pages: PdfPageFragments[],
): (CellLocation | null)[][] {
  const refined = locations.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  const used = new Set<string>();
  const byPage = new Map(pages.map((page) => [page.page, page]));
  let currentPage = -1;
  let floor = -Infinity;

  const header = locations[0]?.find(Boolean) || null;
  rows.forEach((row, rowIndex) => {
    const band = locations[rowIndex]?.find(Boolean);
    if (!band) return;
    const page = byPage.get(band.page);
    if (!page) return;
    if (band.page !== currentPage) {
      currentPage = band.page;
      floor = band.y - band.h;
    }
    let anchor: number | null = null;
    headers.forEach((header, columnIndex) => {
      const value = normalize(row[header] ?? '');
      if (!value) return;
      const candidates = page.fragments
        .map((fragment, index) => ({ fragment, key: `${page.page}:${index}` }))
        .filter(({ fragment, key }) => !used.has(key)
          && normalize(fragment.text) === value
          && fragment.x >= band.x - 6
          && fragment.x <= band.x + band.w + 6
          && (anchor === null ? fragment.y > floor : Math.abs(fragment.y - anchor) <= Math.max(fragment.h, 6) * 0.8));
      if (candidates.length === 0) return;
      const best = anchor === null
        ? candidates.sort((left, right) => left.fragment.y - right.fragment.y || left.fragment.x - right.fragment.x)[0]
        : candidates.sort((left, right) => Math.abs(left.fragment.y - (anchor as number)) - Math.abs(right.fragment.y - (anchor as number)))[0];
      used.add(best.key);
      if (anchor === null) anchor = best.fragment.y;
      refined[rowIndex][columnIndex] = {
        page: page.page,
        x: round(best.fragment.x),
        y: round(best.fragment.y),
        w: round(best.fragment.w),
        h: round(best.fragment.h),
        precision: 'cell',
      };
    });
    if (anchor !== null) floor = anchor + 1;
  });
  void header;
  return refined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
