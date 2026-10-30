import { getApplicationDatabasePath } from '../database/database-path';
import { getAiInteractionService } from '../ai/ai-interaction-service';
import {
  getNvidiaApiKey,
  getOpenRouterApiKey,
} from '../ai/server-ai-configuration';
import {
  NvidiaNimTaskAssessmentScoringProvider,
  OpenRouterTaskAssessmentScoringProvider,
} from './openrouter-task-assessment-scoring-provider';
import { TaskAssessmentScoringService } from './task-assessment-scoring';
import { SqliteTaskAssessmentScoreStore } from './task-assessment-score-store';

export const createTaskAssessmentScoringService = () => {
  const resolvedPath = getApplicationDatabasePath();
  const provider = getNvidiaApiKey()
    ? new NvidiaNimTaskAssessmentScoringProvider()
    : getOpenRouterApiKey()
      ? new OpenRouterTaskAssessmentScoringProvider()
      : null;
  return new TaskAssessmentScoringService(
    new SqliteTaskAssessmentScoreStore(resolvedPath),
    provider,
    (sessionId) =>
      getAiInteractionService(resolvedPath).getInteractionsForSession(
        sessionId,
      ),
  );
};
