'use client';

import { REC_GUIDE, type RecGuideKey } from '@/lib/rec-guide';

/**
 * "How this step works": what the step establishes, what its terms mean, what it
 * holds, and what to do when it does not tie. Closed until asked for, and it
 * stays open from tab to tab once it is.
 */
export function StepGuide({ tab, open, onToggle }: { tab: RecGuideKey; open: boolean; onToggle: (open: boolean) => void }) {
  const guide = REC_GUIDE[tab];
  return (
    <details className="da-guide" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>How this step works</summary>
      <p>{guide.summary}</p>
      <dl>
        {guide.points.map(([term, text]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
