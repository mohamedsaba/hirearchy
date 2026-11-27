import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  buildSampleHiringReviewContext,
  DEMO_AI_REVIEW_REPORT,
  DEMO_HIRING_REVIEW_CONTEXT,
  DEMO_PERFORMANCE_FIT_REPORT,
  DEMO_PUBLIC_DOSSIER,
  DEMO_R27_EVIDENCE,
  DEMO_SCENARIO_TITLE,
  DEMO_SESSION_ID,
  normalizeResolvedDossier,
  SAMPLE_CANDIDATE_DRAFT,
} from '../../apps/web/src/demo/sample-session';
import {
  buildDeterministicEvidencePreviewReport,
  computeEvidenceMetricsAndDiffSummary,
} from '../../apps/web/src/r27-evidence/ai-review-contract';
import { buildR27Presentation } from '../../apps/web/src/r27-evidence/presentation';
import { DemoClient } from '../../apps/web/app/demo/demo-client';
import { DossierClient } from '../../apps/web/app/dossier/[shareToken]/dossier-client';
import { CandidateReceiptShare } from '../../apps/web/app/candidate/submissions/[sessionId]/candidate-receipt-share';
import { CandidatePrestart } from '../../apps/web/app/candidate/[token]/candidate-prestart';
import type { CandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';

describe('Interactive Demo, Sample Session & Executive Dossier', () => {
  it('validates DEMO_R27_EVIDENCE diffs, checkpoints, runs, AI logs, and deterministic preview', () => {
    const presentation = buildR27Presentation(DEMO_R27_EVIDENCE);
    const summary = computeEvidenceMetricsAndDiffSummary(DEMO_R27_EVIDENCE);
    const deterministic =
      buildDeterministicEvidencePreviewReport(DEMO_R27_EVIDENCE);

    expect(DEMO_R27_EVIDENCE.sessionId).toBe(DEMO_SESSION_ID);
    expect(DEMO_R27_EVIDENCE.scenario.title).toBe(DEMO_SCENARIO_TITLE);
    expect(presentation.files).toHaveLength(5);
    expect(summary.submittedFilesCount).toBe(5);
    expect(summary.modifiedFilesCount).toBe(3);
    expect(summary.saveEventsCount).toBe(6);
    expect(summary.executionRunsCount).toBe(3);
    expect(summary.passedExecutionRunsCount).toBe(1);
    expect(summary.failedExecutionRunsCount).toBe(2);
    expect(summary.aiInteractionsCount).toBe(2);
    expect(summary.modifiedTestFilesCount).toBe(1);
    expect(deterministic.verdict).toBe('accept');
    expect(deterministic.score).toBeGreaterThanOrEqual(80);
  });

  it('validates DEMO_HIRING_REVIEW_CONTEXT, DEMO_AI_REVIEW_REPORT, and SAMPLE_CANDIDATE_DRAFT contracts', () => {
    expect(DEMO_HIRING_REVIEW_CONTEXT.candidateName).toBe('Maya Lin');
    expect(DEMO_HIRING_REVIEW_CONTEXT.candidateCode).toBe('HRC-DEMO01');
    expect(DEMO_HIRING_REVIEW_CONTEXT.candidateEmail).toBeNull();
    expect(DEMO_HIRING_REVIEW_CONTEXT.initialAiReview).toEqual(
      DEMO_AI_REVIEW_REPORT,
    );
    expect(DEMO_HIRING_REVIEW_CONTEXT.secondOpinions).toHaveLength(1);
    expect(SAMPLE_CANDIDATE_DRAFT.templateId).toBe('reservation-moves-v3');
    expect(SAMPLE_CANDIDATE_DRAFT.starterFiles.length).toBeGreaterThanOrEqual(
      4,
    );

    const orgSample = buildSampleHiringReviewContext({
      organizationId: '11111111-1111-4111-8111-111111111111',
      organizationName: 'Acme Corp',
      currentPrincipalId: '22222222-2222-4222-8222-222222222222',
    });
    expect(orgSample.organizationId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(orgSample.organizationName).toBe('Acme Corp');
    expect(orgSample.currentPrincipalId).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('enforces strict zero-PII invariants on DEMO_PUBLIC_DOSSIER and normalizeResolvedDossier', () => {
    const serializedDemo = JSON.stringify(DEMO_PUBLIC_DOSSIER);
    expect(DEMO_PUBLIC_DOSSIER.visibilityMode).toBe('redacted');
    expect(DEMO_PUBLIC_DOSSIER.candidateDisplay).toBe('Maya L.');
    expect(DEMO_PUBLIC_DOSSIER.candidateCode).toBe('HRC-DEMO01');
    expect(serializedDemo).not.toMatch(/@/);
    expect(serializedDemo).not.toContain('internalNotes');
    expect(serializedDemo).not.toContain('candidateEmail');
    expect(serializedDemo).not.toContain('idDocumentMasked');
    expect(serializedDemo).not.toContain('birthYear');

    const rawFromRpc = {
      shareId: 'share-1',
      visibilityMode: 'redacted',
      includeAiAdvisory: true,
      includeVerificationQuestions: false,
      expiresAt: '2026-12-01T00:00:00.000Z',
      organizationName: 'Northstar',
      scenarioTitle: DEMO_SCENARIO_TITLE,
      targetRole: 'Backend Engineer',
      experienceLevel: 'senior',
      skills: ['Python'],
      candidate: {
        candidateCode: 'HRC-999999',
        displayName: 'Maya L.',
        headlineRole: 'Should Be Stripped In Redacted Mode',
        locationCity: 'Toronto',
        locationCountry: 'CA',
        candidateEmail: 'secret@private.example.com',
        phone: '+15551234567',
        idDocumentMasked: 'PASS-1234',
      },
      decision: {
        decision: 'accepted',
        decidedByName: 'Alex',
        nextStageLabel: 'Final Panel',
        publishedAt: '2026-11-18T12:00:00.000Z',
        candidateStrengths: ['Strong tests'],
        candidateWeaknesses: ['Check scale'],
        candidateFeedbackNote: 'Well structured.',
        internalNotes: 'SECRET INTERNAL NOTE',
      },
      evidenceSummary: {
        durationMinutes: 42,
        filesChanged: 2,
        revisionCount: 5,
        executionRunsPassed: 1,
        executionRunsTotal: 2,
        aiInteractionsCount: 1,
      },
      performanceReport: DEMO_PERFORMANCE_FIT_REPORT,
    };

    const normalized = normalizeResolvedDossier(rawFromRpc);
    expect(normalized).not.toBeNull();
    const normalizedJson = JSON.stringify(normalized);
    expect(normalizedJson).not.toContain('secret@private.example.com');
    expect(normalizedJson).not.toContain('+15551234567');
    expect(normalizedJson).not.toContain('PASS-1234');
    expect(normalizedJson).not.toContain('SECRET INTERNAL NOTE');
    expect(normalizedJson).not.toContain('Should Be Stripped');
    expect(normalized?.locationLabel).toBeNull();
    expect(normalized?.headlineRole).toBeNull();
    expect(
      normalized?.performanceReport?.suggestedNextInterviewQuestions,
    ).toEqual([]);

    const noAi = normalizeResolvedDossier({
      ...rawFromRpc,
      includeAiAdvisory: false,
    });
    expect(noAi?.performanceReport).toBeNull();
  });

  it('renders /demo, /dossier/demo, candidate receipt share, and CandidatePrestart respect promise cleanly', () => {
    const demoHtml = renderToStaticMarkup(
      createElement(DemoClient, {
        ctaHref: '/r23/signup',
        ctaLabel: 'Create free org workspace',
      }),
    );
    expect(demoHtml).toContain('Interactive Sandbox · No Sign-up Required');
    expect(demoHtml).toContain('1. Timeline');
    expect(demoHtml).toContain('2. Code Diff');
    expect(demoHtml).toContain('3. Test Runs &amp; AI Log');
    expect(demoHtml).toContain('4. Human Verdict');
    expect(demoHtml).toContain('Maya Lin');
    expect(demoHtml).toContain('/r23/signup');

    const dossierHtml = renderToStaticMarkup(
      createElement(DossierClient, {
        dossier: DEMO_PUBLIC_DOSSIER,
        demoCtaHref: '/early-access',
      }),
    );
    expect(dossierHtml).toContain('Print / Save PDF');
    expect(dossierHtml).toContain('Redacted Identity · Zero PII');
    expect(dossierHtml).toContain('Maya L.');
    expect(dossierHtml).toContain('HRC-DEMO01');
    expect(dossierHtml).toContain('Evidence-first engineering evaluation');

    const shareHtml = renderToStaticMarkup(
      createElement(CandidateReceiptShare),
    );
    expect(shareHtml).toContain('Hiring engineers on your own team?');
    expect(shareHtml).toContain('/demo?src=candidate_receipt');
    expect(shareHtml).toContain('Copy link for your team');

    const dummySession: CandidateSessionView = {
      id: 'sess_test_1',
      scenario: {
        id: 'reservation-moves',
        title: 'Reservation Moves',
        version: '3',
        durationSeconds: 2700,
        type: 'multi_file',
      },
      status: 'CREATED',
      workingContent: '',
      createdAt: '2026-11-18T10:00:00.000Z',
      activatedAt: null,
      submittedAt: null,
      durationSeconds: 2700,
      deadline: null,
      serverTime: '2026-11-18T10:00:05.000Z',
      closureReason: null,
      scenarioType: 'multi_file',
      terminalEnabled: true,
      aiCapability: { enabled: true },
    };
    const prestartHtml = renderToStaticMarkup(
      createElement(CandidatePrestart, {
        session: dummySession,
        uiMode: 'orientation',
        setUiMode: () => {},
        onStartAssessment: () => {},
        isActivating: false,
        provisioningError: null,
        onRetryProvisioning: () => {},
      }),
    );
    expect(prestartHtml).toContain('Candidate Respect Promise');
    expect(prestartHtml).not.toContain('surveillance');
    expect(prestartHtml).not.toContain('cheating');
  });
});
