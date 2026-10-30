import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { evaluatorCookieName } from '../../../../src/access/evaluator-access';
import {
  EvaluatorAccessError,
  getAuthorizedEvidence,
} from '../../../../src/access/evaluator-evidence';
import { buildEvaluatorReviewPresentation } from '../../../../src/evaluator/evaluator-review-presentation';
import { getAuthorizedReconstruction } from '../../../../src/reconstruction/evidence-reconstruction-runtime';
import { SessionError } from '../../../../src/sessions/session';
import { buildEvaluatorBriefing } from '../../../../src/evaluator/build-evaluator-briefing';
import { buildEvaluatorAiConversations } from '../../../../src/evaluator/evaluator-ai-conversations';
import { getAiInteractionService } from '../../../../src/ai/ai-interaction-service';
import {
  projectBriefing,
  resolveBriefingDepthProfile,
  type BriefingDepthProfile,
} from '../../../../src/evaluator/project-evaluator-briefing';
import { EvaluatorExperience } from './evaluator-experience';

export const dynamic = 'force-dynamic';

type EvidencePageProps = Readonly<{
  params: Promise<{ sessionId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>;

const EvidencePage = async ({ params, searchParams }: EvidencePageProps) => {
  const [{ sessionId }, cookieStore, resolvedSearchParams] = await Promise.all([
    params,
    cookies(),
    searchParams
      ? searchParams
      : Promise.resolve({} as Record<string, string | string[] | undefined>),
  ]);

  const evaluatorCookie = cookieStore.get(evaluatorCookieName)?.value;
  let evidence: ReturnType<typeof getAuthorizedEvidence> | null = null;

  try {
    evidence = getAuthorizedEvidence(sessionId, evaluatorCookie);
  } catch (error) {
    if (error instanceof EvaluatorAccessError) redirect('/evaluator');
    if (error instanceof SessionError && error.code === 'SESSION_NOT_FOUND') {
      notFound();
    }
    if (error instanceof SessionError && error.code === 'EVIDENCE_NOT_READY') {
      evidence = null;
    } else {
      throw error;
    }
  }

  if (!evidence) {
    return (
      <main className="access-shell">
        <section className="access-card" aria-labelledby="not-ready-title">
          <p className="eyebrow">Evidence review</p>
          <h1 id="not-ready-title">Submission not available.</h1>
          <p className="brief-copy">
            The session remains unavailable until the submitted workspace has
            been frozen.
          </p>
          <Link className="text-link" href="/evaluator">
            Review another session
          </Link>
        </section>
      </main>
    );
  }

  const reconstruction = getAuthorizedReconstruction(
    sessionId,
    evaluatorCookie,
  );
  const briefing = buildEvaluatorBriefing(evidence, reconstruction);
  const review = buildEvaluatorReviewPresentation(evidence, reconstruction);

  const rawRole = resolvedSearchParams?.depth || resolvedSearchParams?.role;
  const requestedRole = Array.isArray(rawRole) ? rawRole[0] : rawRole;
  const activeRole: BriefingDepthProfile =
    resolveBriefingDepthProfile(requestedRole);

  const projection = projectBriefing(briefing, activeRole);
  const hasAiEvidence = review.chronology.some((item) =>
    item.kind.startsWith('AI_'),
  );
  const aiConversations = buildEvaluatorAiConversations(
    review.chronology,
    review.evidenceEntries,
    hasAiEvidence
      ? getAiInteractionService().getInteractionsForSession(sessionId)
      : [],
    evidence.activatedAt,
  );

  return (
    <main
      className="software-product evaluator-review-shell"
      style={{ width: '100%', maxWidth: 'none', margin: 0, padding: 0 }}
    >
      <h1 className="visually-hidden">Evaluator review</h1>
      <EvaluatorExperience
        sessionId={sessionId}
        evidence={evidence}
        review={review}
        projection={projection}
        activeRole={activeRole}
        aiConversations={aiConversations}
      />
    </main>
  );
};

export default EvidencePage;
