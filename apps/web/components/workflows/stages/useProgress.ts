'use client';

import { useEffect } from 'react';
import type { CheckProgress } from '@/lib/workflow-checklist';

/** Reports a screen's progress to the run's checklist, once each time it changes. */
export function useReportProgress(onProgress: ((progress: CheckProgress) => void) | undefined, progress: CheckProgress | null) {
  const key = progress ? JSON.stringify(progress) : '';
  useEffect(() => {
    if (onProgress && key) onProgress(JSON.parse(key) as CheckProgress);
  }, [onProgress, key]);
}
