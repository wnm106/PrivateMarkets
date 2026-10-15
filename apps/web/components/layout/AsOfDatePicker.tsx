'use client';

import { useEffect, useState } from 'react';
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
      <input
        id="as-of-date"
        type="date"
        value={asOfDate}
        onChange={(e) => setAsOfDate(e.target.value)}
      />
      <label htmlFor="knowledge-date">Known:</label>
      <input
        id="knowledge-date"
        type="datetime-local"
        value={knowledgeValue}
        title="Blank means what we know now. Set a past time to see values that have since been deleted."
        onChange={(e) => setKnowledgeDate(e.target.value || (today ?? knowledgeDate))}
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
