'use client';

import { useEffect, useRef, useState } from 'react';

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

const VIEW_WIDTH = 640;

function isPdf(name: string) {
  return name.toLowerCase().endsWith('.pdf');
}

function isImage(name: string) {
  return /\.(png|jpe?g)$/i.test(name);
}

/** The original document with the spot a value was read from drawn on it. */
export function SourceViewer({
  instanceId,
  fileName,
  target,
  onClose,
}: {
  instanceId: string;
  fileName: string;
  target: SourceTarget | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [locations, setLocations] = useState<LocationsResponse | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const viewable = isPdf(fileName) || isImage(fileName);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loc, file] = await Promise.all([
          fetch(`/api/feeds/position-file/${instanceId}/locations`).then((response) => response.json()),
          fetch(`/api/feeds/position-file/${instanceId}/file`).then(async (response) => {
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The file could not be opened');
            return response.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        setLocations(loc.error ? null : loc);
        setBytes(file);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'The file could not be opened');
      }
    })();
    return () => { cancelled = true; };
  }, [instanceId]);

  const location: Location | null = (() => {
    if (!locations || !target || target.row === undefined) return null;
    const row = locations.locations[target.row];
    if (!row) return null;
    const columnIndex = target.column ? locations.headers.indexOf(target.column) : -1;
    return (columnIndex >= 0 ? row[columnIndex] : null) || row.find(Boolean) || null;
  })();

  useEffect(() => {
    if (location) setPageNumber(location.page);
  }, [location?.page, location?.x, location?.y]);

  // Draw the page. A PDF is rendered on a canvas with pdf.js. A picture is drawn as it is.
  useEffect(() => {
    if (!bytes || !viewable) return;
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
          const scale = VIEW_WIDTH / natural.width;
          const viewport = page.getViewport({ scale });
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext('2d');
          if (!context) return;
          await page.render({ canvasContext: context, viewport } as any).promise;
          if (!cancelled) setSize({ width: natural.width, height: natural.height });
        } else {
          const blob = new Blob([bytes]);
          const bitmap = await createImageBitmap(blob);
          if (cancelled) return;
          const scale = VIEW_WIDTH / bitmap.width;
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = VIEW_WIDTH;
          canvas.height = Math.round(bitmap.height * scale);
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const reported = locations?.pages.find((item) => item.page === 1);
          setSize(reported ? { width: reported.width, height: reported.height } : { width: bitmap.width, height: bitmap.height });
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'The page could not be drawn');
      }
    })();
    return () => { cancelled = true; };
  }, [bytes, pageNumber, fileName, viewable]);

  const pageSize = locations?.pages.find((item) => item.page === pageNumber) || size;
  const scale = pageSize ? VIEW_WIDTH / pageSize.width : 1;
  const showBox = location && location.page === pageNumber && pageSize;

  useEffect(() => {
    if (showBox) boxRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [showBox, location?.x, location?.y, size]);

  return (
    <aside
      role="dialog"
      aria-label={`Original file ${fileName}`}
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: VIEW_WIDTH + 48, maxWidth: '100vw', zIndex: 60,
        background: 'Canvas', color: 'CanvasText', borderLeft: '1px solid #d0d5dd', boxShadow: '-8px 0 24px rgba(16,24,40,0.12)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #eaecf0' }}>
        <b style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</b>
        {pageCount > 1 && (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button type="button" className="btn" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="Previous page">‹</button>
            <span>Page {pageNumber} of {pageCount}</span>
            <button type="button" className="btn" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="Next page">›</button>
          </span>
        )}
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </header>
      <div style={{ padding: '8px 16px', fontSize: 13 }}>
        {target?.label && <div><b>{target.label}</b></div>}
        {location
          ? <span>{PRECISION_NOTE[location.precision]}</span>
          : target?.row !== undefined
            ? <span>The reader did not report where this value is. The page is shown without a highlight.</span>
            : <span>The original file.</span>}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {error && <p style={{ color: '#b42318' }}>{error}</p>}
        {!bytes && !error && <p>Opening the file…</p>}
        {bytes && !viewable && <p>This kind of file cannot be shown here. <a href={`/api/feeds/position-file/${instanceId}/file`}>Download it</a>.</p>}
        {bytes && viewable && (
          <div style={{ position: 'relative', width: VIEW_WIDTH, lineHeight: 0 }}>
            <canvas ref={canvasRef} style={{ width: VIEW_WIDTH, border: '1px solid #eaecf0' }} />
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
                  background: 'rgba(250, 204, 21, 0.35)',
                  outline: '2px solid #ca8a04',
                  borderRadius: 2,
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
