import type {
  BriefingDepthProfile,
  ProjectedBriefing,
} from '../../../../src/evaluator/project-evaluator-briefing';
import type {
  EvaluatorReviewEvidence,
  EvaluatorReviewPresentation,
} from '../../../../src/evaluator/evaluator-review-presentation';
import type { EvaluatorAiConversation } from '../../../../src/evaluator/evaluator-ai-conversations';
import type { R27Evidence } from '../../../../../../database/postgres/r27/contract.mjs';
import { EvaluatorReviewWorkspace } from './evaluator-review-workspace';
import { SoftwareProductHeader } from '../../software-product-header';
import '../../evaluator-product.css';

type LegacyEvaluatorExperienceProps = Readonly<{
  sessionId: string;
  evidence: EvaluatorReviewEvidence;
  review: EvaluatorReviewPresentation;
  projection: ProjectedBriefing;
  activeRole: BriefingDepthProfile;
  aiConversations?: readonly EvaluatorAiConversation[];
  readOnly?: false;
}>;

type R27EvaluatorExperienceProps = Readonly<{
  sessionId: string;
  readOnly: true;
  r27Evidence: R27Evidence;
}>;

type EvaluatorExperienceProps =
  LegacyEvaluatorExperienceProps | R27EvaluatorExperienceProps;

export const EvaluatorExperience = (props: EvaluatorExperienceProps) => {
  if (props.readOnly) {
    return (
      <div className="evaluator-v2-container" style={{ gap: 0 }}>
        <SoftwareProductHeader active="reviews" />
        <div className="evaluator-review-page-content">
          <EvaluatorReviewWorkspace
            key={props.sessionId}
            sessionId={props.sessionId}
            readOnly
            r27Evidence={props.r27Evidence}
          />
        </div>
      </div>
    );
  }

  const {
    sessionId,
    evidence,
    review,
    projection,
    activeRole,
    aiConversations = [],
  } = props;
  return (
    <div
      className="evaluator-v2-container"
      data-role-lens={activeRole}
      style={{ gap: 0 }}
    >
      <SoftwareProductHeader active="reviews" />
      <div className="evaluator-review-page-content">
        <EvaluatorReviewWorkspace
          sessionId={sessionId}
          evidence={evidence}
          review={review}
          projection={projection}
          activeRole={activeRole}
          aiConversations={aiConversations}
        />
      </div>
    </div>
  );
};
