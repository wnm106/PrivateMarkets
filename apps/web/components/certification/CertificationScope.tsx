'use client';

/**
 * Pin a surface to a certification. See docs/CERTIFICATION.md.
 *
 *   const scope = useCertification({ processCode, subjectEntityId, periodEnd });
 *   // scope.dates: the As Of and Knowledge dates every load on the surface uses
 *   <SurfaceDatesProvider value={scope.dates}>...tabs...</SurfaceDatesProvider>
 *   <CertifiedBanner scope={scope} figures={figuresOf(loaded)} />
 *
 * A tab component reads its dates with useSurfaceDates() instead of the
 * global store, so it follows the certification when its surface is pinned
 * and the user's dates everywhere else.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  certificationLabel, certifySubject, figureChanges, loadCertificationVersions, reopenLabel, replacedDependencies,
  revokeCertification, standing, surfaceDates,
  type Certification, type CertificationSubject, type CertificationView, type FigureValue, type Figures, type SurfaceDates,
} from '@/lib/certification';
import { useTemporalStore } from '@/lib/store';

const SurfaceDatesContext = createContext<SurfaceDates | null>(null);

export function SurfaceDatesProvider({ value, children }: { value: SurfaceDates; children: ReactNode }) {
  return <SurfaceDatesContext.Provider value={value}>{children}</SurfaceDatesContext.Provider>;
}

/** The dates this part of the page reads at: its surface's pinned dates, or the user's. */
export function useSurfaceDates(): SurfaceDates {
  const pinned = useContext(SurfaceDatesContext);
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  return pinned ?? { asOfDate, knowledgeDate, pinnedBy: null, asOfKeptBy: null };
}

export interface CertificationScope {
  subject: CertificationSubject;
  /** The certification in force, or null. Undefined while it loads. */
  certification: Certification | null | undefined;
  /** The reopened certification a re-certification would replace, when none is in force. */
  reopened: Certification | null;
  /** Every version for this record and period, newest first. */
  versions: Certification[];
  error: string | null;
  view: CertificationView;
  setView: (view: CertificationView) => void;
  /** The dates the surface reads at. */
  dates: SurfaceDates;
  /** True while the surface shows what was certified. */
  pinned: boolean;
  /** True once the certification has been read, so loads do not start at the wrong dates. */
  ready: boolean;
  /**
   * Certify at the dates the surface reads at. A re-certification keeps the
   * reopened one's As Of date. `subjectEntityId` names the record when it was
   * only just created (a first close record). `dependsOn` names certifications
   * the page was read against, such as the prior period's close.
   */
  certify: (figures: Figures, options?: { note?: string | null; subjectEntityId?: string | null; dependsOn?: string[] }) => Promise<Certification>;
  reopen: (reason: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useCertification(subject: CertificationSubject): CertificationScope {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const knowledgeDate = useTemporalStore((state) => state.knowledgeDate);
  const setPinnedDates = useTemporalStore((state) => state.setPinnedDates);
  const [versions, setVersions] = useState<Certification[] | undefined>(subject.subjectEntityId ? undefined : []);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CertificationView>('certified');
  const { processCode, subjectEntityId, periodEnd } = subject;
  // Only the latest read or write may set the versions, so a slow read that
  // started before a certify or reopen cannot undo it.
  const turn = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++turn.current;
    if (!subjectEntityId) { setVersions([]); return; }
    try {
      const found = await loadCertificationVersions({ processCode, subjectEntityId, periodEnd });
      if (mine !== turn.current) return;
      setVersions(found);
      setError(null);
    } catch (caught) {
      if (mine !== turn.current) return;
      // Without the certification the surface reads at the user's dates and says why.
      setVersions([]);
      setError(caught instanceof Error ? caught.message : 'Could not read the certification');
    }
  }, [processCode, subjectEntityId, periodEnd]);

  useEffect(() => {
    setVersions(subjectEntityId ? undefined : []);
    setView('certified');
    void reload();
  }, [reload, subjectEntityId]);

  const { active, reopened } = useMemo(() => standing(versions || []), [versions]);
  const certification = versions === undefined ? undefined : active;

  const dates = useMemo(
    () => surfaceDates({ asOfDate, knowledgeDate }, certification, view, reopened),
    [asOfDate, knowledgeDate, certification, view, reopened],
  );
  const pinned = Boolean(dates.pinnedBy);

  // While pinned, the assistant reads at the same dates as the page.
  useEffect(() => {
    if (!pinned || !dates.pinnedBy) return;
    setPinnedDates({ asOfDate: dates.asOfDate, knowledgeDate: dates.knowledgeDate, label: dates.pinnedBy });
    return () => setPinnedDates(null);
  }, [pinned, dates.asOfDate, dates.knowledgeDate, dates.pinnedBy, setPinnedDates]);

  const certify = useCallback<CertificationScope['certify']>(async (figures, options = {}) => {
    const mine = ++turn.current;
    // A re-certification leaves the As Of date to the database, which keeps the reopened one's.
    const made = await certifySubject(
      { processCode, subjectEntityId: options.subjectEntityId || subjectEntityId, periodEnd },
      reopened ? null : dates.asOfDate,
      figures,
      options.note,
      options.dependsOn,
    );
    if (mine === turn.current) setVersions((current) => [made, ...(current || []).filter((item) => item.id !== made.id)]);
    setError(null);
    setView('certified');
    return made;
  }, [processCode, subjectEntityId, periodEnd, reopened, dates.asOfDate]);

  const reopen = useCallback(async (reason: string) => {
    if (!certification) return;
    const mine = ++turn.current;
    const revoked = await revokeCertification(certification.id, reason);
    if (mine === turn.current) setVersions((current) => (current || []).map((item) => (item.id === revoked.id ? { ...item, ...revoked } : item)));
    setView('certified');
  }, [certification]);

  return {
    subject,
    certification,
    reopened,
    versions: versions || [],
    error,
    view,
    setView,
    dates,
    pinned,
    ready: versions !== undefined,
    certify,
    reopen,
    reload,
  };
}

function shown(value: FigureValue): string {
  if (value == null) return '—';
  if (typeof value === 'number') return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value;
}

function instant(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : `${parsed.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' })} UTC`;
}

/**
 * A Reopen button that asks why first. The reason is kept with the
 * certification it reopens and shown in its history.
 */
export function ReopenButton({
  disabled,
  label = 'Reopen',
  onReopen,
}: {
  disabled?: boolean;
  label?: string;
  onReopen: (reason: string) => Promise<void> | void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  if (!asking) {
    return <button type="button" className="btn" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  }
  const submit = async () => {
    const text = reason.trim();
    if (!text) return;
    await onReopen(text);
    setAsking(false);
    setReason('');
  };
  return (
    <form className="cert-reopen" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>
        Why reopen?
        <input
          type="text"
          value={reason}
          autoFocus
          maxLength={500}
          placeholder="e.g. September NAV restated by the administrator"
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={disabled || !reason.trim()}>{label}</button>
      <button type="button" className="btn btn-sm" onClick={() => { setAsking(false); setReason(''); }}>Cancel</button>
    </form>
  );
}

function History({ versions }: { versions: Certification[] }) {
  if (versions.length < 2 && !versions.some((item) => item.revokedAt)) return null;
  return (
    <details className="cert-history">
      <summary>{versions.length === 1 ? '1 version' : `${versions.length} versions`}</summary>
      <ol>
        {versions.map((item) => (
          <li key={item.id}>
            <strong>Version {item.version}</strong> · As Of {item.asOfDate}, as known at {instant(item.knowledgeAt)}
            {item.certifiedBy ? ` · certified by ${item.certifiedBy}` : ''}
            {item.revokedAt
              ? <small>{reopenLabel(item)}</small>
              : <small>In force</small>}
            {item.note && <small>“{item.note}”</small>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * Says the surface is certified, what it reads at, and lets the person switch
 * between what was certified and what is known now. `figures` are the key
 * figures of what the surface loaded, built the same way as at certification:
 * in the certified view any difference means the replay no longer matches; in
 * the current view the differences are what changed since. After a reopen it
 * says the page reads the same As Of date as known now, ready to re-certify.
 */
export function CertifiedBanner({ scope, figures }: { scope: CertificationScope; figures: Figures | null }) {
  const { certification, reopened, view, setView, versions } = scope;
  if (scope.error) return <div className="cert-banner cert-warn"><strong>Certification not read.</strong> <span>{scope.error} Showing your As Of and Knowledge dates.</span></div>;

  if (!certification && reopened) {
    return (
      <div className="cert-banner cert-current" role="status">
        <div>
          <strong>Reopened.</strong>{' '}
          <span>{reopenLabel(reopened)}. Showing As Of {reopened.asOfDate}, the date version {reopened.version} was certified at, as known now. Re-certifying keeps that As Of date and rolls knowledge forward.</span>
        </div>
        {figures && (() => {
          const changes = figureChanges(reopened.figures, figures);
          return changes.length ? <Changes changes={changes} heading={`${changes.length} figure${changes.length === 1 ? '' : 's'} differ from version ${reopened.version}:`} current="Now" /> : <p className="cert-ok">Every figure still matches version {reopened.version}.</p>;
        })()}
        <History versions={versions} />
      </div>
    );
  }
  if (!certification) return null;

  const changes = figureChanges(certification.figures, figures);
  const replaced = replacedDependencies(certification);
  const certifiedView = view === 'certified';
  return (
    <div className={`cert-banner${!certifiedView ? ' cert-current' : ''}${(certifiedView && changes.length) || replaced.length ? ' cert-warn' : ''}`} role="status">
      <div className="cert-banner-head">
        <div>
          <strong>{certificationLabel(certification)}.</strong>{' '}
          {certifiedView
            ? <span>Showing what was certified: As Of {certification.asOfDate}, as known at {instant(certification.knowledgeAt)}. Later changes are kept but not shown here.</span>
            : <span>Showing what is known now. The certified figures are unchanged.</span>}
          {certification.note && <small className="cert-note">“{certification.note}”</small>}
        </div>
        <div className="cert-toggle" role="group" aria-label="Which data to show">
          <button type="button" className={`btn btn-sm${certifiedView ? ' btn-primary' : ''}`} aria-pressed={certifiedView} onClick={() => setView('certified')}>Certified</button>
          <button type="button" className={`btn btn-sm${!certifiedView ? ' btn-primary' : ''}`} aria-pressed={!certifiedView} onClick={() => setView('current')}>Current data</button>
        </div>
      </div>
      {replaced.length > 0 && (
        <p className="cert-replaced">
          {replaced.map((item) => `The ${item.periodEnd ? `${item.periodEnd} ` : ''}certification this was compared with (version ${item.version}) was reopened${item.revokeReason ? `: ${item.revokeReason}` : ''}.`).join(' ')}{' '}
          This certification stands as certified. Carry the change into the next open period as a prior-period adjustment, or reopen this one to re-certify it.
        </p>
      )}
      {figures && (changes.length > 0 ? (
        <Changes
          changes={changes}
          heading={certifiedView
            ? 'This read no longer matches the certified figures. Something the page reads changed in place (outside the dated history), or its calculation changed:'
            : `${changes.length} certified figure${changes.length === 1 ? '' : 's'} read differently now:`}
          current={certifiedView ? 'This read' : 'Now'}
        />
      ) : (
        <p className="cert-ok">{certifiedView ? 'This read matches the certified figures.' : 'Nothing certified has changed since.'}</p>
      ))}
      <History versions={versions} />
    </div>
  );
}

function Changes({ changes, heading, current }: { changes: ReturnType<typeof figureChanges>; heading: string; current: string }) {
  return (
    <div className="cert-changes">
      <p>{heading}</p>
      <table>
        <thead><tr><th>Figure</th><th>Certified</th><th>{current}</th></tr></thead>
        <tbody>{changes.map((change) => (
          <tr key={change.key}><td>{change.label}</td><td>{shown(change.certified)}</td><td>{shown(change.current)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}
