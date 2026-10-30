// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EvaluatorExperience } from '../../apps/web/app/evaluator/sessions/[sessionId]/evaluator-experience';
import { RecordedActivity } from '../../apps/web/app/evaluator/sessions/[sessionId]/recorded-activity';
import { buildEvaluatorBriefing } from '../../apps/web/src/evaluator/build-evaluator-briefing';
import {
  briefingDepthProfiles,
  projectBriefing,
  resolveBriefingDepthProfile,
  type BriefingDefaultDepth,
} from '../../apps/web/src/evaluator/project-evaluator-briefing';
import {
  buildEvaluatorReviewPresentation,
  formatEvaluatorClosureReason,
} from '../../apps/web/src/evaluator/evaluator-review-presentation';
import {
  commandEvents,
  noReconstruction,
  testEvidence,
} from '../support/briefing-test-evidence';

const expectedDepth: Record<string, BriefingDefaultDepth> = {
  GENERALIST_RECRUITER: {
    structuredEvidence: false,
    technicalRecord: false,
    scenarioReference: false,
    technicalFootprint: false,
    verificationChronology: false,
    conciseSubmissionScope: true,
    evidenceLimitations: true,
    artifactAvailability: false,
    reviewGuidance: true,
    directEvidenceLinks: false,
    aiSummary: true,
    aiConfiguredModel: false,
    aiTokenTelemetry: false,
  },
  TECHNICAL_RECRUITER: {
    structuredEvidence: true,
    technicalRecord: false,
    scenarioReference: true,
    technicalFootprint: true,
    verificationChronology: true,
    conciseSubmissionScope: false,
    evidenceLimitations: false,
    artifactAvailability: false,
    reviewGuidance: true,
    directEvidenceLinks: true,
    aiSummary: true,
    aiConfiguredModel: true,
    aiTokenTelemetry: false,
  },
  ENGINEER: {
    structuredEvidence: true,
    technicalRecord: true,
    scenarioReference: true,
    technicalFootprint: true,
    verificationChronology: true,
    conciseSubmissionScope: false,
    evidenceLimitations: true,
    artifactAvailability: true,
    reviewGuidance: true,
    directEvidenceLinks: true,
    aiSummary: true,
    aiConfiguredModel: true,
    aiTokenTelemetry: true,
  },
  ENGINEERING_MANAGER: {
    structuredEvidence: false,
    technicalRecord: false,
    scenarioReference: false,
    technicalFootprint: false,
    verificationChronology: false,
    conciseSubmissionScope: true,
    evidenceLimitations: true,
    artifactAvailability: true,
    reviewGuidance: true,
    directEvidenceLinks: true,
    aiSummary: true,
    aiConfiguredModel: true,
    aiTokenTelemetry: false,
  },
};

const evidence = {
  ...testEvidence(
    commandEvents('pytest', {
      stdoutPreview: '===== 3 passed in 0.1s =====',
    }),
  ),
  closureReason: 'candidate_submission' as const,
};
const briefing = buildEvaluatorBriefing(evidence, noReconstruction);
const review = buildEvaluatorReviewPresentation(evidence, noReconstruction);

describe('E3 evaluator role-depth contract', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it('resolves the default, all supported profiles, legacy role values, and unknown values deterministically', () => {
    expect(resolveBriefingDepthProfile(undefined)).toBe('GENERALIST_RECRUITER');
    expect(resolveBriefingDepthProfile('unknown')).toBe('GENERALIST_RECRUITER');
    for (const profile of briefingDepthProfiles) {
      expect(resolveBriefingDepthProfile(profile)).toBe(profile);
    }
    expect(resolveBriefingDepthProfile('ENGINEER')).toBe('ENGINEER');
  });

  it.each(briefingDepthProfiles)(
    '%s has a complete deterministic capability contract and preserves factual source references',
    (profile) => {
      const projection = projectBriefing(briefing, profile);

      expect(projection.defaultDepth).toEqual(expectedDepth[profile]);
      expect(Object.keys(projection.defaultDepth)).toHaveLength(13);
      expect(
        projection.briefing.evidenceIndex.map((entry) => entry.evidenceRef),
      ).toEqual(briefing.evidenceIndex.map((entry) => entry.evidenceRef));
      expect(projection.briefing.recordedVerification).toEqual(
        briefing.recordedVerification,
      );
      expect(review.chronology).toEqual(
        buildEvaluatorReviewPresentation(evidence, noReconstruction).chronology,
      );
    },
  );

  it('keeps Summary concise while exposing three workspace modes and review controls', () => {
    const html = renderToStaticMarkup(
      <EvaluatorExperience
        sessionId={evidence.sessionId}
        activeRole="ENGINEER"
        projection={projectBriefing(briefing, 'ENGINEER')}
        review={review}
        evidence={evidence}
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="workbench-mode-summary"');
    expect(html).toContain('id="workbench-mode-evidence"');
    expect(html).toContain('id="workbench-mode-review"');
    expect(html.match(/data-workbench-mode-tab=/g)).toHaveLength(3);
    expect(html).toContain('id="open-quick-note"');
    expect(html).toContain('id="reviewer-note-body"');
    expect(html).toContain(
      '<h3 id="scenario-context-title">What this task was about</h3>',
    );
  });

  it.each(briefingDepthProfiles)(
    '%s renders only its configured depth surfaces without a candidate verdict',
    (profile) => {
      const projection = projectBriefing(briefing, profile);
      const html = renderToStaticMarkup(
        <EvaluatorExperience
          sessionId={evidence.sessionId}
          activeRole={profile}
          projection={projection}
          review={review}
          evidence={evidence}
        />,
      );
      const depth = projection.defaultDepth;

      expect(html.includes('View evidence')).toBe(false);
      expect(html.includes('Open submitted diff')).toBe(true);
      expect(html.includes('engineer-evidence-workspace')).toBe(false);
      expect(html.includes('Artifact availability')).toBe(
        depth.artifactAvailability,
      );
      expect(html.includes('Relevant system context')).toBe(
        depth.scenarioReference,
      );
      expect(html.includes('Review guidance')).toBe(depth.reviewGuidance);
      expect(html.includes('Candidate rank:')).toBe(false);
      expect(html.includes('Performance score:')).toBe(false);
    },
  );

  it.each([
    ['GENERALIST_RECRUITER', false, false],
    ['TECHNICAL_RECRUITER', true, true],
    ['ENGINEER', true, true],
    ['ENGINEERING_MANAGER', true, false],
  ] as const)(
    '%s applies direct links and structured records independently',
    async (profile, directEvidenceLinks, structuredEvidence) => {
      const depth = projectBriefing(briefing, profile).defaultDepth;
      await act(async () => {
        root?.render(
          <RecordedActivity
            activities={briefing.observedActivity}
            verification={briefing.recordedVerification}
            evidenceEntries={review.evidenceEntries}
            showDetailedTechnical={depth.technicalFootprint}
            showStructuredEvidence={depth.structuredEvidence}
            showDirectEvidenceLinks={depth.directEvidenceLinks}
            showVerificationChronology={depth.verificationChronology}
          />,
        );
      });

      const button = Array.from(
        container!.querySelectorAll<HTMLButtonElement>('button'),
      ).find((item) => item.textContent?.includes('View evidence'));
      expect(Boolean(button)).toBe(directEvidenceLinks);
      if (!button) return;

      await act(async () => button.click());
      expect(
        container!.textContent?.includes('Source evidence reference'),
      ).toBe(!structuredEvidence);
      expect(container!.textContent?.includes('Terminal activity')).toBe(
        structuredEvidence,
      );
    },
  );

  it('uses minimum-safe evidence defaults without explicit capability props', () => {
    const html = renderToStaticMarkup(
      <RecordedActivity
        activities={briefing.observedActivity}
        verification={briefing.recordedVerification}
        evidenceEntries={review.evidenceEntries}
      />,
    );

    expect(html).not.toContain('View evidence');
    expect(html).not.toContain('Terminal activity');
  });

  it('renders factual later-workspace context only when verification chronology is enabled', () => {
    const verification = {
      ...briefing.recordedVerification,
      runs: briefing.recordedVerification.runs.map((run, index) =>
        index === 0
          ? { ...run, laterWorkspaceEdits: true, laterCaptureGaps: true }
          : run,
      ),
    };
    const enabled = renderToStaticMarkup(
      <RecordedActivity
        activities={briefing.observedActivity}
        verification={verification}
        evidenceEntries={review.evidenceEntries}
        showVerificationChronology
      />,
    );
    const disabled = renderToStaticMarkup(
      <RecordedActivity
        activities={briefing.observedActivity}
        verification={verification}
        evidenceEntries={review.evidenceEntries}
        showVerificationChronology={false}
      />,
    );

    expect(enabled).toContain('Later workspace changes were recorded.');
    expect(enabled).toContain('Later workspace capture gaps were recorded.');
    expect(enabled).not.toContain('because');
    expect(enabled).not.toContain('caused');
    expect(disabled).not.toContain('Later workspace changes were recorded.');
    expect(disabled).not.toContain(
      'Later workspace capture gaps were recorded.',
    );
  });

  it('uses factual, exhaustive closure-reason labels', () => {
    expect(formatEvaluatorClosureReason('candidate_submission')).toBe(
      'Submitted by candidate',
    );
    expect(formatEvaluatorClosureReason('timeout')).toBe(
      'Assessment time ended',
    );
  });
});
