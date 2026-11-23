'use client';

import { useEffect, useRef, useState } from 'react';
import { tapFormulaForValue } from '@tapestrai/graphql/src/lib/tap-formula';
import { graphqlQuery } from '@/lib/graphql';

const ENTITY_IDENTITY_QUERY = `
  query EntityIdentity($entityId: ID!) {
    entityIdentity(entityId: $entityId) { entityId entityCode }
  }
`;

/** Today as the page's dates count it (the temporal store's default). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The older copy route, for browsers or frames that refuse the clipboard API. */
function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  }
  area.remove();
  return done;
}

/**
 * Copies the Excel =TAP formula for one value, such as =TAP("NAV", "FUND-1").
 *
 * The record is named by its code. Pass entityCode when the caller has it;
 * otherwise the code is read once from entityId.
 */
export function CopyTapFormula({
  entityId,
  entityCode,
  attributeCode,
  asOfDate,
  knowledgeDate,
  className,
}: {
  entityId?: string | null;
  entityCode?: string | null;
  attributeCode: string;
  asOfDate?: string | null;
  knowledgeDate?: string | null;
  className?: string;
}) {
  const [resolvedCode, setResolvedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const timer = useRef<number | null>(null);
  const code = entityCode || resolvedCode;

  useEffect(() => {
    if (entityCode || !entityId) return;
    let cancelled = false;
    void graphqlQuery<{ entityIdentity: { entityCode: string } | null }, { entityId: string }>(
      ENTITY_IDENTITY_QUERY, { entityId }, 'cache-first',
    ).then((result) => {
      if (!cancelled) setResolvedCode(result.data?.entityIdentity?.entityCode || null);
    });
    return () => { cancelled = true; };
  }, [entityCode, entityId]);

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  if (!attributeCode || (!code && !entityId)) return null;

  const formula = code ? tapFormulaForValue({ attributeCode, entityCode: code, asOfDate }, today()) : '';
  // TAP reads what is known now. A value read at an earlier knowledge date may differ.
  const pastKnowledge = Boolean(knowledgeDate && knowledgeDate.slice(0, 10) < today());
  const title = !code
    ? 'Copy =TAP formula'
    : `Copy ${formula}${pastKnowledge ? `\nExcel reads what is known now, not as known on ${knowledgeDate!.slice(0, 10)}.` : ''}`;

  const copy = async () => {
    if (!formula) return;
    let done = false;
    try {
      await navigator.clipboard.writeText(formula);
      done = true;
    } catch {
      done = copyWithSelection(formula);
    }
    setCopied(done ? 'ok' : 'failed');
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1500);
  };

  return (
    <button
      type="button"
      className={`tap-copy${copied ? ` ${copied}` : ''}${className ? ` ${className}` : ''}`}
      title={copied === 'ok' ? `Copied ${formula}` : copied === 'failed' ? 'Could not copy. Your browser blocked the clipboard.' : title}
      aria-label={copied === 'ok' ? 'Copied =TAP formula' : 'Copy =TAP formula'}
      disabled={!code}
      onClick={(event) => { event.stopPropagation(); void copy(); }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {copied === 'ok' ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="tap-copy-glyph" aria-hidden="true"><i>f</i>x</span>
      )}
    </button>
  );
}
