'use client';

import { useEffect, useState } from 'react';
import { useTemporalStore } from '@/lib/store';

export function AsOfDatePicker() {
  const { asOfDate, setAsOfDate } = useTemporalStore();

  // `today` must not be computed during render: the server renders this
  // component too, so doing so produced HTML that disagreed with the client
  // (historical date + Reset button on one side only) and broke hydration.
  // Leaving it null until mount keeps the server and first client render equal.
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => {
    setToday(new Date().toISOString().split('T')[0]);
  }, []);

  const isNotToday = today !== null && asOfDate !== today;

  return (
    <div className={`as-of-date-picker ${isNotToday ? 'as-of-date-picker--historical' : ''}`}>
      <label htmlFor="as-of-date">As Of:</label>
      <input
        id="as-of-date"
        type="date"
        value={asOfDate}
        onChange={(e) => setAsOfDate(e.target.value)}
      />
      {isNotToday && (
        <button
          onClick={() => setAsOfDate(today)}
          className="reset-date-btn"
          title="Reset to today"
        >
          Reset
        </button>
      )}
    </div>
  );
}
