import type { CSSProperties, ReactNode } from 'react';
import { statusLabel, statusStyle } from '@/lib/surfaces';

export function StatusBadge({ status }: { status: string }) {
  const tone = statusStyle(status);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.02em',
        background: tone.background,
        color: tone.color,
        whiteSpace: 'nowrap',
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  fontSize: '13px',
};

const headStyle: CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  background: 'var(--bg)',
  borderBottom: '1px solid var(--line)',
};

const cellStyle: CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
  color: 'var(--ink)',
  lineHeight: 1.45,
};

export function QualificationTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} style={headStyle}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={cellStyle}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
