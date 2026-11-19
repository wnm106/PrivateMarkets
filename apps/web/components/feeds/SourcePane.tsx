'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface Location {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  precision: 'cell' | 'row' | 'table';
}

interface LocationsResponse {
  tableId: string | null;
  headers: string[];
  pages: { page: number; width: number; height: number }[];
  locations: (Location | null)[][];
}

interface RowsResponse {
  headers: string[];
  from: number;
  rowCount: number;
  rows: Record<string, string>[];
}

/** What to point at: one cell (row and column), a whole column, or a whole row. Nothing shows the file as it is. */
export interface SourceTarget {
  row?: number;
  column?: string;
  label?: string;
}

const PRECISION_NOTE: Record<Location['precision'], string> = {
  cell: 'The highlighted box is the value itself.',
  row: 'The reader boxed the row, not the value. The highlight covers the row.',
  table: 'The reader boxed only the table. The highlight covers the table.',
};

const WINDOW = 40;
const HIGHLIGHT = 'rgba(250, 204, 21, 0.35)';
const OUTLINE = '#ca8a04';

function isPdf(name: string) {
  return name.toLowerCase().endsWith('.pdf');
}

function isImage(name: string) {
  return /\.(png|jpe?g)$/i.test(name);
}

const cellStyle: CSSProperties = { padding: '3px 8px', borderBottom: '1px solid #eaecf0', fontSize: 12, whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.5 };

/**
 * A stored file with the place a value was read from marked on it.
 *
 * A PDF or a picture is drawn as its page, with a box where the reader found
 * the value. Any other file (a spreadsheet, a CSV) is shown as the table that
 * was read, with the cell, column or row marked. The pane fills the width it is
 * given, so it can sit beside the work or in a drawer.
 */
export function SourcePane({
  instanceId,
  fileName,
  target,
  height = 520,
  /** Bump to make the pane read the file again, after another table is chosen. */
  revision = 0,
}: {
  instanceId: string;
  fileName: string;
  target: SourceTarget | null;
  height?: number | string;
  revision?: number;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLTableCellElement>(null);
  // pdf.js refuses to draw on a canvas it is still drawing on, so one draw is finished or cancelled before the next.
  const drawing = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);
  const [locations, setLocations] = useState<LocationsResponse | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [grid, setGrid] = useState<RowsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [viewWidth, setViewWidth] = useState(560);
  const [asTable, setAsTable] = useState(false);

  const viewable = isPdf(fileName) || isImage(fileName);
  const located = Boolean(locations && locations.locations.length > 0);
  // A page is shown when the file is one and the reader said where its values are, or when nothing is pointed at.
  const showPage = viewable && !asTable;

  // The pane takes the width of whatever holds it.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setViewWidth(Math.max(240, Math.floor(frame.clientWidth) - 2));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const loc = await fetch(`/api/feeds/position-file/${instanceId}/locations`).then((response) => response.json());
        if (cancelled) return;
        setLocations(loc.error ? null : loc);
        if (viewable) {
          const response = await fetch(`/api/feeds/position-file/${instanceId}/file`);
          if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The file could not be opened');
          const file = await response.arrayBuffer();
          if (!cancelled) setBytes(file);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'The file could not be opened');
      }
    })();
    return () => { cancelled = true; };
  }, [instanceId, viewable, revision]);

  // The rows around the one pointed at, for a file that is shown as its table.
  const wantedRow = target?.row;
  const windowStart = wantedRow === undefined ? 0 : Math.max(0, wantedRow - Math.floor(WINDOW / 3));
  useEffect(() => {
    if (showPage) return;
    let cancelled = false;
    fetch(`/api/feeds/position-file/${instanceId}/rows?from=${windowStart}&count=${WINDOW}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'The rows could not be read');
        if (!cancelled) setGrid(body);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [instanceId, showPage, windowStart, revision]);

  const location: Location | null = (() => {
    if (!locations || !target) return null;
    const columnIndex = target.column ? locations.headers.indexOf(target.column) : -1;
    if (target.row !== undefined) {
      const row = locations.locations[target.row];
      if (!row) return null;
      return (columnIndex >= 0 ? row[columnIndex] : null) || row.find(Boolean) || null;
    }
    // A column with no row: the first place the reader found a value in that column.
    if (columnIndex < 0) return null;
    for (const row of locations.locations) {
      if (row?.[columnIndex]) return row[columnIndex];
    }
    return null;
  })();

  useEffect(() => {
    if (location) setPageNumber(location.page);
  }, [location?.page, location?.x, location?.y]);

  // Draw the page. A PDF is rendered on a canvas with pdf.js. A picture is drawn as it is.
  useEffect(() => {
    if (!bytes || !showPage) return;
    let cancelled = false;
    (async () => {
      try {
        if (isPdf(fileName)) {
          const { getDocumentProxy } = await import('unpdf');
          const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
          if (cancelled) return;
          setPageCount(pdf.numPages);
          const page = await pdf.getPage(Math.min(Math.max(pageNumber, 1), pdf.numPages));
          const natural = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: viewWidth / natural.width });
          const canvas = canvasRef.current;
          if (!canvas) return;
          const context = canvas.getContext('2d');
          if (!context) return;
          const earlier = drawing.current;
          if (earlier) {
            earlier.cancel();
            await earlier.promise.catch(() => undefined);
          }
          if (cancelled) return;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const task = page.render({ canvasContext: context, viewport } as any);
          drawing.current = task;
          try {
            await task.promise;
          } catch (err: any) {
            // A draw that was cancelled for a newer one is not a failure.
            if (err?.name === 'RenderingCancelledException') return;
            throw err;
          } finally {
            if (drawing.current === task) drawing.current = null;
          }
          if (!cancelled) {
            setSize({ width: natural.width, height: natural.height });
            setError(null);
          }
        } else {
          const bitmap = await createImageBitmap(new Blob([bytes]));
          if (cancelled) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = viewWidth;
          canvas.height = Math.round(bitmap.height * (viewWidth / bitmap.width));
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const reported = locations?.pages.find((item) => item.page === 1);
          setSize(reported ? { width: reported.width, height: reported.height } : { width: bitmap.width, height: bitmap.height });
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'The page could not be drawn');
      }
    })();
    return () => {
      cancelled = true;
      drawing.current?.cancel();
    };
  }, [bytes, pageNumber, fileName, showPage, viewWidth, locations]);

  const pageSize = locations?.pages.find((item) => item.page === pageNumber) || size;
  const scale = pageSize ? viewWidth / pageSize.width : 1;
  const showBox = showPage && location && location.page === pageNumber && pageSize;

  useEffect(() => {
    if (showBox) boxRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [showBox, location?.x, location?.y, size]);

  useEffect(() => {
    if (!showPage) markRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [showPage, grid, target?.row, target?.column]);

  const pointing = Boolean(target && (target.row !== undefined || target.column));
  const note = !pointing
    ? showPage ? 'The original file.' : 'The table read from the file.'
    : showPage
      ? location ? (target?.row === undefined ? 'The box marks the first value read for this column.' : PRECISION_NOTE[location.precision]) : 'The reader did not report where this value is, so the page is shown without a highlight. Show the table to see the value as it was read.'
      : target?.row !== undefined && target.column ? 'The highlighted cell is the value as it was read.'
        : target?.column ? 'The highlighted column is where this field is read from.' : 'The highlighted row is the record as it was read.';

  let markPlaced = false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, height, border: '1px solid var(--line, #eaecf0)', borderRadius: 8, background: 'Canvas', color: 'CanvasText', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #eaecf0', flexWrap: 'wrap' }}>
        <b style={{ flex: 1, minWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{fileName}</b>
        {showPage && pageCount > 1 && (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
            <button type="button" className="btn" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="Previous page">‹</button>
            <span>Page {pageNumber} of {pageCount}</span>
            <button type="button" className="btn" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="Next page">›</button>
          </span>
        )}
        {viewable && (
          <button type="button" className="btn" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
            {asTable ? 'Show the page' : 'Show the table'}
          </button>
        )}
      </header>
      <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--ink-3, #475467)', borderBottom: '1px solid #eaecf0' }}>
        {target?.label && <b style={{ color: 'CanvasText' }}>{target.label}. </b>}
        {note}
        {showPage && pointing && !located && ' This file was read without positions.'}
      </div>
      <div ref={frameRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {error && <p role="alert" style={{ color: '#b42318', padding: 12, margin: 0 }}>{error}</p>}
        {showPage && !bytes && !error && <p style={{ padding: 12, margin: 0 }}>Opening the file…</p>}
        {showPage && bytes && (
          <div style={{ position: 'relative', width: viewWidth, lineHeight: 0 }}>
            <canvas ref={canvasRef} style={{ width: viewWidth }} />
            {showBox && location && (
              <div
                ref={boxRef}
                aria-label="Where this value was read"
                style={{
                  position: 'absolute',
                  left: location.x * scale - 2,
                  top: location.y * scale - 2,
                  width: location.w * scale + 4,
                  height: location.h * scale + 4,
                  background: HIGHLIGHT,
                  outline: `2px solid ${OUTLINE}`,
                  borderRadius: 2,
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        )}
        {!showPage && !grid && !error && <p style={{ padding: 12, margin: 0 }}>Reading the rows…</p>}
        {!showPage && grid && (
          grid.headers.length === 0 ? (
            <p style={{ padding: 12, margin: 0 }}>Nothing was read from this file.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...cellStyle, position: 'sticky', top: 0, left: 0, zIndex: 2, background: '#f9fafb', color: '#667085', fontWeight: 500, textAlign: 'right' }}>Row</th>
                  {grid.headers.map((header) => {
                    const on = target?.column === header;
                    return (
                      <th key={header} title={header} style={{ ...cellStyle, position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', fontWeight: 600, background: on ? '#fef08a' : '#f9fafb', boxShadow: on ? `inset 0 -2px 0 ${OUTLINE}` : undefined }}>
                        {header}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row, index) => {
                  const number = grid.from + index;
                  const rowOn = target?.row === number;
                  return (
                    <tr key={number}>
                      <td style={{ ...cellStyle, position: 'sticky', left: 0, background: rowOn ? '#fef08a' : '#f9fafb', color: '#667085', textAlign: 'right' }}>{number + 1}</td>
                      {grid.headers.map((header) => {
                        const columnOn = target?.column === header;
                        const cellOn = target?.row !== undefined ? rowOn && (columnOn || !target?.column) : columnOn;
                        const exact = rowOn && columnOn;
                        // Scroll to the cell itself, or to the first cell of a marked column or row.
                        const first = cellOn && !markPlaced && (exact || target?.row === undefined || !target?.column);
                        if (first) markPlaced = true;
                        return (
                          <td
                            key={header}
                            ref={first ? markRef : undefined}
                            title={row[header]}
                            aria-label={exact ? 'Where this value was read' : undefined}
                            style={{ ...cellStyle, background: cellOn ? HIGHLIGHT : undefined, outline: exact ? `2px solid ${OUTLINE}` : undefined, outlineOffset: exact ? -2 : undefined }}
                          >
                            {row[header]}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
        {!showPage && grid && grid.rowCount > grid.rows.length && (
          <p style={{ padding: '6px 12px', margin: 0, fontSize: 12, color: '#667085' }}>
            Rows {grid.from + 1} to {grid.from + grid.rows.length} of {grid.rowCount.toLocaleString()}.
          </p>
        )}
      </div>
    </div>
  );
}
