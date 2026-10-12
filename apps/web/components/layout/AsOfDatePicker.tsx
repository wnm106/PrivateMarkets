'use client';

import { useTemporalStore } from '@/lib/store';

export function AsOfDatePicker() {
  const { asOfDate, setAsOfDate } = useTemporalStore();
  
  const today = new Date().toISOString().split('T')[0];
  const isNotToday = asOfDate !== today;

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
