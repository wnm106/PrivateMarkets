'use client';

import { useEffect, useState } from 'react';
import { CommittedDateInput } from '@/components/forms/CommittedDateInput';
import { useTemporalStore } from '@/lib/store';

export function AsOfDatePicker() {
  const { asOfDate, setAsOfDate, knowledgeDate, setKnowledgeDate } = useTemporalStore();

  // `today` must not be computed during render: the server renders this
  // component too, so doing so produced HTML that disagreed with the client
  // (historical date + Reset button on one side only) and broke hydration.
  // Leaving it null until mount keeps the server and first client render equal.
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    setToday(new Date().toISOString().split('T')[0]);
  }, []);

  const isNotToday = today !== null && asOfDate !== today;
  const knowledgeIsCurrent = today === null || knowledgeDate === today || (
    knowledgeDate.length > 10
      ? new Date(knowledgeDate).getTime() >= Date.now() - 1000
      : today !== null && knowledgeDate >= today
  );
  const knowledgeValue = knowledgeDate.length > 10
    ? knowledgeDate.slice(0, 16)
    : today !== null && knowledgeDate < today
      ? `${knowledgeDate}T23:59`
      : '';

  return (
    <div className={`as-of-date-picker ${isNotToday || !knowledgeIsCurrent ? 'as-of-date-picker--historical' : ''}`}>
      <label htmlFor="as-of-date">As Of:</label>
      <CommittedDateInput
        id="as-of-date"
        value={asOfDate}
        title="Choosing a day applies it when the calendar closes. Press Enter or click away after stepping the fields."
        onCommit={(value) => {
          if (/^\d{4}-\d{2}-\d{2}$/.test(value)) setAsOfDate(value);
        }}
      />
      <label htmlFor="knowledge-date">Known:</label>
      <CommittedDateInput
        id="knowledge-date"
        type="datetime-local"
        value={knowledgeValue}
        title="Blank means what we know now. Choosing a time applies it when the calendar closes."
        onCommit={(value) => setKnowledgeDate(value || (today ?? knowledgeDate))}
      />
      {(isNotToday || !knowledgeIsCurrent) && today && (
        <button
          onClick={() => {
            setAsOfDate(today);
            setKnowledgeDate(today);
          }}
          className="reset-date-btn"
          title="Reset to today"
        >
          Reset
        </button>
      )}
    </div>
  );
}
