'use client';

import type { ReportParameter } from '@/lib/reporting';

interface ParameterBarProps {
  parameters: ReportParameter[];
  values: Record<string, any>;
  onChange: (name: string, value: any) => void;
}

/** Renders the user-facing filter inputs declared by a dashboard / narrative. */
export function ParameterBar({ parameters, values, onChange }: ParameterBarProps) {
  if (!parameters || parameters.length === 0) return null;

  return (
    <div className="filter-bar" style={{ flexWrap: 'wrap', gap: '12px' }}>
      <div className="filter-label">Filters</div>
      {parameters.map((p) => {
        const label = p.label || p.name;
        const value = values[p.name] ?? '';
        const common = { style: { padding: '5px 10px', fontSize: '12px', border: '1px solid var(--line)', background: 'white' } as const };
        return (
          <label key={p.name} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--ink-3)' }}>
            {label}
            {p.type === 'select' ? (
              <select
                className="select"
                style={{ padding: '5px 30px 5px 11px', fontSize: '11px' }}
                value={value}
                onChange={(e) => onChange(p.name, e.target.value)}
              >
                <option value="">All</option>
                {(p.options || []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : p.type === 'boolean' ? (
              <input type="checkbox" checked={value === true || value === 'true'} onChange={(e) => onChange(p.name, e.target.checked)} />
            ) : (
              <input
                {...common}
                type={p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text'}
                value={value}
                onChange={(e) => onChange(p.name, p.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
