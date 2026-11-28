import Link from 'next/link';
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
import type {
  PerformanceFitReport,
  SessionHiringReviewContext,
} from '../../../../src/hiring/types';
import type { EvidenceFilter } from './evidence-workbench';
import type { HiringDecisionDraft } from './hiring-decision-panel';
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
  hiringReviewContext?: SessionHiringReviewContext | null;
  initialTab?: 'Summary' | 'Evidence' | 'Review';
  initialPeerReviewId?: string | null;
  demoMode?: boolean;
  isSample?: boolean;
  controlledTab?: 'Summary' | 'Evidence' | 'Review';
  onTabChange?: (
    tab: 'Summary' | 'Evidence' | 'Review',
    source?: 'restore',
  ) => void;
  controlledFilter?: EvidenceFilter;
  onFilterChange?: (filter: EvidenceFilter) => void;
  onSimulatedPublish?: (
    draft: HiringDecisionDraft,
    report: PerformanceFitReport | null,
  ) => void;
}>;

type EvaluatorExperienceProps =
  LegacyEvaluatorExperienceProps | R27EvaluatorExperienceProps;

export const EvaluatorExperience = (props: EvaluatorExperienceProps) => {
  if (props.readOnly) {
    const sampleOrgId = props.hiringReviewContext?.organizationId;
    return (
      <div
        className="evaluator-v2-container evaluator-evidence-product"
        style={{ gap: 0 }}
      >
        <a className="software-skip-link" href="#evidence-workbench-panel">
          Skip to review workspace
        </a>
        {props.demoMode ? null : (
          <SoftwareProductHeader
            active="reviews"
            stagingReview={{
              organizationId: props.r27Evidence.organizationId,
              sessionId: props.sessionId,
              compact: Boolean(props.hiringReviewContext),
            }}
          />
        )}
        {props.isSample ? (
          <div
            className="hiring-banner hiring-banner-warning"
            role="status"
            data-testid="sample-review-banner"
            style={{
              margin: '0.75rem clamp(1rem, 3vw, 2rem) 0',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
            }}
          >
            <div>
              <strong>
                Sample Evaluated Candidate (Maya Lin · HRC-DEMO01)
              </strong>
              <span>
                {' '}
                — Interactive walkthrough using pre-seeded evidence. Zero
                candidate credits used.
              </span>
            </div>
            {sampleOrgId ? (
              <div className="hiring-header-actions">
                <Link
                  className="hiring-btn hiring-btn-sm hiring-btn-primary"
                  href={`/r23/organizations/${encodeURIComponent(sampleOrgId)}/builder?mode=new`}
                >
                  Create your first assessment →
                </Link>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="evaluator-review-page-content">
          <EvaluatorReviewWorkspace
            key={props.sessionId}
            sessionId={props.sessionId}
            readOnly
            r27Evidence={props.r27Evidence}
            hiringReviewContext={props.hiringReviewContext}
            initialTab={props.initialTab}
            initialPeerReviewId={props.initialPeerReviewId}
            demoMode={props.demoMode}
            isSample={props.isSample}
            controlledTab={props.controlledTab}
            onTabChange={props.onTabChange}
            controlledFilter={props.controlledFilter}
            onFilterChange={props.onFilterChange}
            onSimulatedPublish={props.onSimulatedPublish}
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
