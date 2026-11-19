'use client';

import type { EntityResolution } from '@tapestrai/mcp-server/src/feeds/types';

export interface PreviewReject {
  kind: 'record' | 'value' | 'link';
  domainCode: string;
  entityCode: string;
  attributeCode?: string;
  value?: string;
  message: string;
  row?: number;
  column?: string;
}

export interface LoadPreviewResult {
  dryRun?: boolean;
  asOfDate: string;
  domains: { domainCode: string; distinctEntities: number; created: number; matched: number; failed: number; errors: string[] }[];
  attributes: { created: number; updated: number; unchanged: number };
  relationships: { created: number; matched: number; failed: number };
  warnings: string[];
  rejects?: PreviewReject[];
  rejectCount?: number;
  /** Records in the file that match more than one stored record. Nothing can be staged until each is decided. */
  resolutions?: EntityResolution[];
}

const KIND_LABEL: Record<PreviewReject['kind'], string> = {
  record: 'Records refused',
  value: 'Values skipped or off-list',
  link: 'Links that cannot be made',
};

function csvCell(value: string | undefined) {
  const text = value ?? '';
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadRejects(rejects: PreviewReject[]) {
  const lines = ['kind,record_type,code,attribute,value,reason'];
  for (const item of rejects) {
    lines.push([item.kind, item.domainCode, item.entityCode, item.attributeCode, item.value, item.message].map(csvCell).join(','));
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'load-review-issues.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/** The dry-run result: what Load will do, before anything is written. */
export function LoadPreview({
  preview,
  running,
  error,
  stale,
  onRun,
  onShow,
}: {
  preview: LoadPreviewResult | null;
  running: boolean;
  error: string | null;
  stale: boolean;
  onRun: () => void;
  onShow?: (item: PreviewReject) => void;
}) {
  const created = preview?.domains.reduce((sum, domain) => sum + domain.created, 0) ?? 0;
  const matched = preview?.domains.reduce((sum, domain) => sum + domain.matched, 0) ?? 0;
  const failed = preview?.domains.reduce((sum, domain) => sum + domain.failed, 0) ?? 0;
  const rejects = preview?.rejects ?? [];
  const rejectTotal = preview?.rejectCount ?? rejects.length;

  return (
    <section className="load-section" aria-live="polite">
      <div className="load-sh">
        <span className="load-step-n">4</span>
        <div>
          <h2>Review what will happen</h2>
          <p className="load-sub">
            A dry run with the real matching and cleanup. Nothing is written until you load.
          </p>
        </div>
      </div>

      {!preview && !running && (
        <button type="button" className="btn" onClick={onRun}>Run review</button>
      )}
      {running && <p className="load-sub">Checking the file against your existing records…</p>}
      {error && <p className="load-sub" style={{ color: '#b42318' }}>{error}</p>}

      {preview && !running && (
        <>
          {stale && (
            <p className="load-sub" style={{ color: '#b54708' }}>
              The mapping or date changed after this review. <button type="button" className="btn" onClick={onRun}>Run it again</button>
            </p>
          )}
          <table className="load-preview-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>Record type</th><th>New</th><th>Matched existing</th><th>Refused</th>
              </tr>
            </thead>
            <tbody>
              {preview.domains.map((domain) => (
                <tr key={domain.domainCode}>
                  <td>{domain.domainCode}</td>
                  <td>{domain.created}</td>
                  <td>{domain.matched}</td>
                  <td style={domain.failed ? { color: '#b42318' } : undefined}>{domain.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="load-sub" style={{ marginTop: 8 }}>
            <b>{created.toLocaleString()}</b> new and <b>{matched.toLocaleString()}</b> matched records
            {failed > 0 && <>, <b style={{ color: '#b42318' }}>{failed.toLocaleString()}</b> refused</>}.
            Values as of {preview.asOfDate}: <b>{preview.attributes.created.toLocaleString()}</b> to add,{' '}
            <b>{preview.attributes.updated.toLocaleString()}</b> to change, {preview.attributes.unchanged.toLocaleString()} already stored.
            Links: <b>{preview.relationships.created.toLocaleString()}</b> to add, {preview.relationships.matched.toLocaleString()} already there
            {preview.relationships.failed > 0 && <>, <b style={{ color: '#b42318' }}>{preview.relationships.failed.toLocaleString()}</b> cannot be made</>}.
          </p>

          <IssueList rejects={rejects} total={rejectTotal} onShow={onShow} />
        </>
      )}
    </section>
  );
}

/** Issues from a dry run or a finished load, grouped by kind, with a CSV download. */
export function IssueList({ rejects, total, onShow }: { rejects: PreviewReject[]; total: number; onShow?: (item: PreviewReject) => void }) {
  const kinds = (['record', 'value', 'link'] as const).map((kind) => ({ kind, items: rejects.filter((item) => item.kind === kind) })).filter((group) => group.items.length > 0);
  if (total === 0) return <p className="load-sub">No issues found.</p>;
  return (
    <div style={{ marginTop: 8 }}>
      <p className="load-sub">
        <b>{total.toLocaleString()}</b> {total === 1 ? 'issue' : 'issues'}
        {total > rejects.length && ` (first ${rejects.length} shown)`}.{' '}
        <button type="button" className="btn" onClick={() => downloadRejects(rejects)}>Download list</button>
      </p>
      {kinds.map((group) => (
        <details key={group.kind} open={group.kind === 'record'}>
          <summary>{KIND_LABEL[group.kind]} ({group.items.length})</summary>
          <ul style={{ margin: '4px 0 8px 18px' }}>
            {group.items.slice(0, 15).map((item, index) => (
              <li key={`${group.kind}-${index}`}>
                <b>{item.entityCode}</b>
                {item.attributeCode ? ` · ${item.attributeCode}` : ''}
                {item.value ? ` · \u201c${item.value}\u201d` : ''}: {item.message}
                {onShow && item.row !== undefined && (
                  <>{' '}<button type="button" className="btn" onClick={() => onShow(item)}>Show in document</button></>
                )}
              </li>
            ))}
            {group.items.length > 15 && <li>and {group.items.length - 15} more in the download</li>}
          </ul>
        </details>
      ))}
    </div>
  );
}

export type StepState = 'done' | 'current' | 'attention' | 'waiting';

const RIBBON = {
  done: { bg: 'var(--step-done-bg, #d1fadf)', fg: 'var(--step-done-fg, #05603a)' },
  active: { bg: 'var(--step-active-bg, #1d4ed8)', fg: '#ffffff' },
  attention: { bg: 'var(--step-attention-bg, #b54708)', fg: '#ffffff' },
  waiting: { bg: 'var(--step-wait-bg, #eaecf0)', fg: 'var(--step-wait-fg, #667085)' },
} as const;

const POINT = 14;

/**
 * A ribbon of arrows pointing right, one per stage, square on the left.
 * Finished stages are green with a check, the stage the user is on is solid
 * (blue, or amber when it needs a decision), and later stages are grey.
 */
export function LoadStepper({ steps }: { steps: { label: string; state: StepState; note?: string }[] }) {
  const activeIndex = steps.findIndex((step) => step.state !== 'done');
  return (
    <ol
      aria-label="Progress"
      style={{ display: 'flex', listStyle: 'none', padding: 0, margin: '14px 0', overflowX: 'auto' }}
    >
      {steps.map((step, index) => {
        const active = index === activeIndex;
        const kind = step.state === 'done' ? 'done' : active ? (step.state === 'attention' ? 'attention' : 'active') : 'waiting';
        const colors = RIBBON[kind];
        const last = index === steps.length - 1;
        // Square on the left, pointed on the right. The last stage is square on both ends.
        const clip = last
          ? undefined
          : `polygon(0 0, calc(100% - ${POINT}px) 0, 100% 50%, calc(100% - ${POINT}px) 100%, 0 100%)`;
        return (
          <li
            key={step.label}
            aria-current={active ? 'step' : undefined}
            style={{
              flex: '1 1 0',
              minWidth: 120,
              // Each arrow sits over the square end of the next one. The shadow leaves a thin gap between neighbours.
              marginLeft: index === 0 ? 0 : -POINT,
              zIndex: steps.length - index,
              filter: last ? undefined : 'drop-shadow(2px 0 0 Canvas)',
            }}
          >
            <div
              style={{
                padding: `8px ${last ? 12 : POINT + 6}px 8px ${index === 0 ? 14 : POINT + 10}px`,
                background: colors.bg,
                color: colors.fg,
                clipPath: clip,
                fontWeight: active ? 600 : 500,
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 13 }}>
                <span aria-hidden>{kind === 'done' ? '\u2713 ' : kind === 'attention' ? '! ' : ''}</span>
                {index + 1}. {step.label}
              </span>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 400, opacity: 0.9, minHeight: 14 }}>{step.note || '\u00a0'}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
