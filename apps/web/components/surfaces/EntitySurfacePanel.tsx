'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  loadEntitySurface,
  optionalityLabel,
  type SurfaceResolution,
} from '@/lib/surfaces';
import { QualificationTable, StatusBadge } from './QualificationTable';

interface EntitySurfacePanelProps {
  entityId: string;
  entityCode: string;
}

export function EntitySurfacePanel({ entityId, entityCode }: EntitySurfacePanelProps) {
  const [resolution, setResolution] = useState<SurfaceResolution | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHeldBack, setShowHeldBack] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResolution(null);
    setMissing(false);
    setError(null);
    (async () => {
      const result = await loadEntitySurface(entityId);
      if (cancelled) return;
      if (result.error) {
        setError(result.error.message || 'Surface qualification is unavailable.');
        return;
      }
      if (!result.data?.entitySurface) {
        setMissing(true);
        return;
      }
      setResolution(result.data.entitySurface);
    })();
    return () => { cancelled = true; };
  }, [entityId]);

  if (missing) return null;
  if (error) {
    return (
      <section style={{ marginTop: '28px', color: 'var(--ink-3)', fontSize: '13px' }}>
        Surface qualification is unavailable.
      </section>
    );
  }
  if (!resolution) return null;

  const rendered = resolution.pages.filter((page) => page.status === 'RENDERED');
  const components = showHeldBack
    ? resolution.components
    : resolution.components.filter((component) => component.status === 'QUALIFIED');
  const heldBack = resolution.components.length - resolution.components.filter((component) => component.status === 'QUALIFIED').length;

  return (
    <section style={{ marginTop: '28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'baseline', marginBottom: '10px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0 }}>Qualified experience</h2>
          <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '4px' }}>
            {resolution.surfaceName}
            {resolution.templateCode ? ` · template ${resolution.templateCode}` : ''}
            {` · ${rendered.length} pages · ${resolution.components.filter((component) => component.status === 'QUALIFIED').length} components`}
          </div>
        </div>
        <Link
          href={`/admin/surfaces?surface=${encodeURIComponent(resolution.surfaceCode)}&entity=${encodeURIComponent(entityCode)}`}
          className="crumb-link"
        >
          Open qualification logic
        </Link>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        {rendered.map((page) => (
          <span key={page.slotCode} style={{ border: '1px solid var(--line)', background: 'var(--surface)', padding: '6px 10px', fontSize: '12px' }}>
            <strong>{page.slotName}</strong>
            <span style={{ color: 'var(--ink-3)' }}> · {page.variantName}</span>
          </span>
        ))}
      </div>

      <QualificationTable
        headers={['Component', 'Page', 'Status', 'Supporting logic']}
        rows={components.map((component) => [
          component.componentName,
          component.pageName,
          <StatusBadge key={component.componentCode} status={component.status} />,
          component.ruleTrace,
        ])}
      />

      {heldBack > 0 && (
        <button
          type="button"
          className="btn"
          style={{ marginTop: '10px' }}
          onClick={() => setShowHeldBack((current) => !current)}
        >
          {showHeldBack ? 'Hide components that did not qualify' : `Show ${heldBack} components that did not qualify`}
        </button>
      )}

      {resolution.pages.some((page) => page.status === 'HIDDEN') && showHeldBack && (
        <div style={{ marginTop: '14px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink-3)', marginBottom: '8px' }}>HIDDEN PAGES</div>
          <QualificationTable
            headers={['Page', 'Optionality', 'Why it is hidden']}
            rows={resolution.pages.filter((page) => page.status === 'HIDDEN').map((page) => [
              page.slotName,
              optionalityLabel(page.optionality),
              page.decision,
            ])}
          />
        </div>
      )}
    </section>
  );
}
