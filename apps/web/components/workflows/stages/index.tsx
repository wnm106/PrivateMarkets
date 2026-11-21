'use client';

import type { ComponentType } from 'react';
import type { CheckProgress } from '@/lib/workflow-checklist';
import type { StageView } from '@/lib/workflow-stages';
import { LoadMapStage } from './LoadMapStage';
import { LoadQualityStage } from './LoadQualityStage';
import { UnderstandStage } from './UnderstandStage';

export interface StageScreenProps {
  stage: StageView;
  /** The stage is being completed, or the run is moving. */
  busy: boolean;
  /** Leaves the stage with one of its outcomes. Rejects with the reason when it is refused. */
  onComplete: (outcome: string, result: Record<string, unknown>) => Promise<void>;
  /**
   * Reports what the person still has to do on this screen, in order, so the
   * run's checklist can show it under this decision. Called whenever it changes.
   */
  onProgress?: (progress: CheckProgress) => void;
}

/**
 * The component behind each screen a Stage step can show, by the screen's
 * code. The codes, their outcomes and their checks are in
 * packages/graphql/src/lib/workflow-screens.ts.
 */
export const STAGE_COMPONENTS: Record<string, ComponentType<StageScreenProps>> = {
  'intake.understand': UnderstandStage,
  'load.map': LoadMapStage,
  'load.quality': LoadQualityStage,
};
