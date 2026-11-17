'use client';

import { useState } from 'react';
import type { EntityResolution, EntityResolutionDecision } from '@tapestrai/mcp-server/src/feeds/types';
import { domainLabel } from '@/lib/feeds/suggest';

function choiceKey(item: EntityResolution) {
  return `${item.domainCode}|${item.fileCode}`;
}

function formatLongDate(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function viaLabel(via: EntityResolution['via']) {
  if (via === 'code') return 'the record code';
  if (via === 'name') return 'the name';
  return 'an identifier';
}

export function EntityResolutionStep({
  resolutions,
  applying,
  onApply,
}: {
  resolutions: EntityResolution[];
  applying: boolean;
  onApply: (decisions: EntityResolutionDecision[]) => void;
}) {
  const [choices, setChoices] = useState<Record<string, EntityResolutionDecision>>({});
  if (resolutions.length === 0) return null;
  const ready = resolutions.every((item) => choices[choiceKey(item)]);

  function choose(item: EntityResolution, decision: EntityResolutionDecision) {
    setChoices((current) => ({ ...current, [choiceKey(item)]: decision }));
  }

  return (
    <section className="load-section">
      <div className="load-sh">
        <span className="load-step-n">!</span>
        <div>
          <h2>Some rows match more than one record</h2>
          <p className="load-sub">Nothing was written. For each row, use an existing record, create a new one, or skip it.</p>
        </div>
      </div>
      {resolutions.map((item) => {
        const key = choiceKey(item);
        const choice = choices[key];
        const group = `resolution-${key}`;
        return (
          <div key={key} className="load-attn">
            <span className="load-tag">Needs your decision</span>
            <h2 className="load-ask">{item.fileName || item.fileCode}</h2>
            <p className="load-sub">
              {domainLabel(item.domainCode)} · {item.fileCode} · matched by {viaLabel(item.via)} as of {formatLongDate(item.asOf)}.
              {item.identifiers.length > 0 && (
                <> Shared identifiers: {item.identifiers.map((identifier) => `${identifier.attributeCode} ${identifier.value}`).join(', ')}.</>
              )}
            </p>
            <div className="load-opts">
              {item.candidates.map((candidate) => (
                <label key={candidate.id} className="load-opt">
                  <input
                    type="radio"
                    name={group}
                    checked={choice?.action === 'map' && choice.entityId === candidate.id}
                    onChange={() => choose(item, { domainCode: item.domainCode, fileCode: item.fileCode, action: 'map', entityId: candidate.id })}
                  />
                  <span>
                    <b>Use {candidate.name || candidate.code}</b>
                    <small>{candidate.code}</small>
                  </span>
                </label>
              ))}
              <label className="load-opt">
                <input
                  type="radio"
                  name={group}
                  checked={choice?.action === 'create'}
                  onChange={() => choose(item, { domainCode: item.domainCode, fileCode: item.fileCode, action: 'create' })}
                />
                <span>
                  <b>Create a new record</b>
                  <small>
                    {item.identifiers.length > 0
                      ? `The shared identifiers are closed on the records above as of ${formatLongDate(item.asOf)}.`
                      : 'This row starts a new record.'}
                  </small>
                </span>
              </label>
              <label className="load-opt">
                <input
                  type="radio"
                  name={group}
                  checked={choice?.action === 'ignore'}
                  onChange={() => choose(item, { domainCode: item.domainCode, fileCode: item.fileCode, action: 'ignore' })}
                />
                <span>
                  <b>Skip this row</b>
                  <small>Nothing is written for this row.</small>
                </span>
              </label>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!ready || applying}
        onClick={() => onApply(resolutions.map((item) => choices[choiceKey(item)]))}
      >
        {applying ? 'Applying…' : 'Apply decisions'}
      </button>
    </section>
  );
}
