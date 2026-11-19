'use client';

import { SourcePane, type SourceTarget } from '@/components/feeds/SourcePane';

export type { SourceTarget } from '@/components/feeds/SourcePane';

/** The source pane in a drawer over the page, for screens that have no room to keep it beside the work. */
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
  return (
    <aside
      role="dialog"
      aria-label={`Original file ${fileName}`}
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 688, maxWidth: '100vw', zIndex: 60,
        background: 'Canvas', color: 'CanvasText', borderLeft: '1px solid #d0d5dd', boxShadow: '-8px 0 24px rgba(16,24,40,0.12)',
        display: 'flex', flexDirection: 'column', padding: 12, gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Close</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SourcePane instanceId={instanceId} fileName={fileName} target={target} height="100%" />
      </div>
    </aside>
  );
}
