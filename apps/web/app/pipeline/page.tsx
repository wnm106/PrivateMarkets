'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { graphqlMutation, graphqlQuery, UPDATE_ENTITY_MUTATION } from '@/lib/graphql';
import { useTemporalStore } from '@/lib/store';
import { attributeText, RECORD_EXPERIENCES_QUERY, type RecordExperience } from '@/lib/experience';

interface DealCard {
  id: string;
  entityCode: string;
  entityName: string;
  attributes: Record<string, unknown>;
}

function cardValue(code: string, raw: unknown) {
  const text = attributeText(raw);
  if (!text) return '';
  if (code.includes('VALUE') || code === 'AUM' || code === 'NAV') {
    const amount = Number(text);
    if (Number.isFinite(amount)) {
      return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    }
  }
  return text;
}

export default function DealPipelinePage() {
  const asOfDate = useTemporalStore((state) => state.asOfDate);
  const [experience, setExperience] = useState<RecordExperience | null>(null);
  const [deals, setDeals] = useState<DealCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [experiences, entities] = await Promise.all([
      graphqlQuery<{ recordExperiences: RecordExperience[] }, { anchorDomainCode: string; isActive: boolean }>(
        RECORD_EXPERIENCES_QUERY,
        { anchorDomainCode: 'DEAL', isActive: true },
        'network-only',
      ),
      graphqlQuery<{ entities: { edges: Array<{ node: DealCard }> } }, Record<string, never>>(
        `query PipelineDeals {
          entities(filter: { domainCode: "DEAL", isActive: true }, pagination: { first: 200 }) {
            edges { node { id entityCode entityName attributes } }
          }
        }`,
        {},
        'network-only',
      ),
    ]);
    const message = experiences.error?.message || entities.error?.message;
    if (message) {
      setError(message);
      setLoading(false);
      return;
    }
    const match = (experiences.data?.recordExperiences || []).find((item) => item.pipeline) || null;
    setExperience(match);
    setDeals((entities.data?.entities?.edges || []).map((edge) => edge.node));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const move = async (deal: DealCard, stage: string) => {
    const pipeline = experience?.pipeline;
    if (!pipeline) return;
    const previous = deals;
    setDeals((current) => current.map((row) => (
      row.id === deal.id
        ? { ...row, attributes: { ...row.attributes, [pipeline.stageAttribute]: { value: stage } } }
        : row
    )));
    const result = await graphqlMutation<
      { updateEntity: { errors: Array<{ message: string }> } },
      { input: { id: string; attributes: Record<string, string> } }
    >(UPDATE_ENTITY_MUTATION, { input: { id: deal.id, attributes: { [pipeline.stageAttribute]: stage }, asOfDate } });
    const message = result.error?.message || result.data?.updateEntity?.errors?.[0]?.message;
    if (message) {
      setDeals(previous);
      setError(message);
    }
  };

  const pipeline = experience?.pipeline;
  const stages = pipeline?.stages || [];
  const known = new Set(stages.map((stage) => stage.code));
  const unassigned = deals.filter((deal) => !known.has(attributeText(deal.attributes?.[pipeline?.stageAttribute || ''])));

  return (
    <div className="view-fade">
      <div className="crumbs">
        <Link href="/" className="crumb-link">Home</Link>
        <span className="sep">›</span>
        <span className="crumb-current">Deal Pipeline</span>
      </div>
      <div className="page-header">
        <div className="page-title-block">
          <div style={{ width: '4px', height: '48px', background: '#047857' }} />
          <div>
            <div className="page-title">Deal Pipeline</div>
            <div className="page-meta">
              {experience ? `${experience.experienceName} · ${deals.length} deals` : 'Working view for deals'}
            </div>
          </div>
        </div>
        <div className="page-actions">
          <Link href="/deals" className="btn">All deals</Link>
        </div>
      </div>

      {loading && <div className="xp-empty">Loading pipeline…</div>}
      {error && <div className="xp-error">{error}</div>}
      {!loading && !pipeline && (
        <div className="xp-empty">No deal experience has a pipeline yet. Add one under record experiences.</div>
      )}
      {pipeline && experience && (
        <div className="xp-board">
          {stages.map((stage) => {
            const cards = deals.filter((deal) => attributeText(deal.attributes?.[pipeline.stageAttribute]) === stage.code);
            return (
              <section key={stage.code} className="xp-column">
                <header className="xp-column-head">
                  <span>{stage.label}</span>
                  <span className="xp-count">{cards.length}</span>
                </header>
                {cards.map((deal) => (
                  <article key={deal.id} className="xp-deal">
                    <Link href={`/experiences/${experience.experienceCode}/${deal.id}`} className="xp-deal-name">
                      {deal.entityName}
                    </Link>
                    <div className="xp-code">{deal.entityCode}</div>
                    <div className="xp-deal-facts">
                      {pipeline.cardAttributes.map((code) => {
                        const text = cardValue(code, deal.attributes?.[code]);
                        return text ? <span key={code}>{text}</span> : null;
                      })}
                    </div>
                    <label className="xp-stage">
                      <span>Stage</span>
                      <select
                        value={stage.code}
                        aria-label={`Stage for ${deal.entityName}`}
                        onChange={(event) => { void move(deal, event.target.value); }}
                      >
                        {stages.map((option) => (
                          <option key={option.code} value={option.code}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </article>
                ))}
              </section>
            );
          })}
          {unassigned.length > 0 && (
            <section className="xp-column">
              <header className="xp-column-head">
                <span>Unstaged</span>
                <span className="xp-count">{unassigned.length}</span>
              </header>
              {unassigned.map((deal) => (
                <article key={deal.id} className="xp-deal">
                  <Link href={`/experiences/${experience.experienceCode}/${deal.id}`} className="xp-deal-name">
                    {deal.entityName}
                  </Link>
                  <div className="xp-code">{deal.entityCode}</div>
                  <label className="xp-stage">
                    <span>Stage</span>
                    <select
                      value=""
                      aria-label={`Stage for ${deal.entityName}`}
                      onChange={(event) => { void move(deal, event.target.value); }}
                    >
                      <option value="">Choose</option>
                      {stages.map((option) => (
                        <option key={option.code} value={option.code}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </article>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
