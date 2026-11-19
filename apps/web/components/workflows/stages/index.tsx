'use client';

import type { ComponentType } from 'react';
import type { StageView } from '@/lib/workflow-stages';
import { LoadMapStage } from './LoadMapStage';
import { LoadQualityStage } from './LoadQualityStage';

export interface StageScreenProps {
  stage: StageView;
  /** The stage is being completed, or the run is moving. */
  busy: boolean;
  /** Leaves the stage with one of its outcomes. Rejects with the reason when it is refused. */
  onComplete: (outcome: string, result: Record<string, unknown>) => Promise<void>;
}

/**
 * The component behind each screen a Stage step can show, by the screen's
 * code. The codes, their outcomes and their checks are in
 * packages/graphql/src/lib/workflow-screens.ts.
 */
export const STAGE_COMPONENTS: Record<string, ComponentType<StageScreenProps>> = {
  'load.map': LoadMapStage,
  'load.quality': LoadQualityStage,
};
