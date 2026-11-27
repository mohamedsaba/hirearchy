'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  IconArrowRight,
  IconCheck,
  IconCode,
  IconExternalLink,
  IconGavel,
  IconHistory,
  IconTerminal2,
  IconX,
} from '@tabler/icons-react';

import {
  DEMO_HIRING_REVIEW_CONTEXT,
  DEMO_R27_EVIDENCE,
  DEMO_SESSION_ID,
} from '../../src/demo/sample-session';
import type { PerformanceFitReport } from '../../src/hiring/types';
import {
  flushClientTelemetry,
  trackClientEvent,
} from '../../src/telemetry/client';
import { ThemeToggle } from '../_components/theme-toggle';
import { EvaluatorExperience } from '../evaluator/sessions/[sessionId]/evaluator-experience';
import type { EvidenceFilter } from '../evaluator/sessions/[sessionId]/evidence-workbench';
import type { HiringDecisionDraft } from '../evaluator/sessions/[sessionId]/hiring-decision-panel';

export interface DemoClientProps {
  readonly ctaHref: string;
  readonly ctaLabel: string;
}

type WorkbenchTab = 'Summary' | 'Evidence' | 'Review';

interface SimulatedPublishState {
  readonly decision: 'accepted' | 'rejected';
  readonly nextStageLabel: string;
  readonly feedbackNote: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly report: PerformanceFitReport | null;
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function DemoClient({ ctaHref, ctaLabel }: DemoClientProps) {
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('Summary');
  const [evidenceFilter, setEvidenceFilter] =
    useState<EvidenceFilter>('Code changes');
  const [simulatedModal, setSimulatedModal] =
    useState<SimulatedPublishState | null>(null);

  useEffect(() => {
    const params =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search)
        : null;
    const src = params?.get('src')?.slice(0, 64) ?? 'direct';
    trackClientEvent({
      eventName: 'demo.opened',
      category: 'acquisition',
      actorType: 'visitor',
      route: '/demo',
      properties: { src },
    });
  }, []);

  useEffect(() => {
    if (!simulatedModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSimulatedModal(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [simulatedModal]);

  const jumpTo = (
    tab: WorkbenchTab,
    milestone: string,
    nextFilter?: EvidenceFilter,
  ) => {
    setActiveTab(tab);
    if (nextFilter) {
      setEvidenceFilter(nextFilter);
    }
    trackClientEvent({
      eventName: 'demo.tab.viewed',
      category: 'acquisition',
      actorType: 'visitor',
      route: '/demo',
      properties: {
        tab: tab.toLowerCase(),
        milestone,
      },
    });
  };

  const handleCtaClick = (source: string) => {
    trackClientEvent({
      eventName: 'demo.cta.clicked',
      category: 'acquisition',
      actorType: 'visitor',
      route: '/demo',
      properties: { target: ctaHref, source },
    });
    flushClientTelemetry();
  };

  const handleSimulatedPublish = (
    draft: HiringDecisionDraft,
    report: PerformanceFitReport | null,
  ) => {
    if (draft.decision !== 'accepted' && draft.decision !== 'rejected') return;
    trackClientEvent({
      eventName: 'demo.decision.simulated',
      category: 'acquisition',
      actorType: 'visitor',
      route: '/demo',
      properties: {
        decision: draft.decision,
        nextStage: draft.nextStageLabel.slice(0, 64),
      },
    });
    flushClientTelemetry();
    setSimulatedModal({
      decision: draft.decision,
      nextStageLabel: draft.nextStageLabel,
      feedbackNote: draft.feedbackNote,
      strengths: splitLines(draft.strengthsText),
      weaknesses: splitLines(draft.weaknessesText),
      report,
    });
  };

  const isMilestoneActive = (id: 'timeline' | 'diff' | 'runs' | 'verdict') => {
    if (id === 'timeline') return activeTab === 'Summary';
    if (id === 'verdict') return activeTab === 'Review';
    if (id === 'diff') {
      return activeTab === 'Evidence' && evidenceFilter === 'Code changes';
    }
    return (
      activeTab === 'Evidence' &&
      (evidenceFilter === 'Execution runs' ||
        evidenceFilter === 'AI conversations')
    );
  };

  const activeStepNumber = isMilestoneActive('verdict')
    ? 4
    : isMilestoneActive('runs')
      ? 3
      : isMilestoneActive('diff')
        ? 2
        : 1;

  return (
    <div
      className="software-product evaluator-review-shell"
      style={{ width: '100%', maxWidth: 'none', margin: 0, padding: 0 }}
    >
      <header
        className="software-product-header demo-sticky-topbar"
        data-testid="demo-sticky-topbar"
      >
        <div className="demo-topbar-brand">
          <Link
            className="software-wordmark"
            href="/products/software"
            aria-label="Hirearchy Software product overview"
          >
            <span>Hirearchy</span>
            <span className="software-product-capsule">Software</span>
          </Link>
          <span className="hiring-pill hiring-pill-plum demo-sandbox-pill">
            Interactive Sandbox · No Sign-up Required
          </span>
        </div>

        <div className="software-header-controls demo-topbar-actions">
          <ThemeToggle variant="header" />
          <Link
            href={ctaHref}
            className="hiring-btn hiring-btn-sm hiring-btn-mint"
            onClick={() => handleCtaClick('topbar')}
          >
            {ctaLabel} <IconArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <main>
        <h1 className="visually-hidden">
          Hirearchy Software Interactive Evaluator Demo
        </h1>
        <section
          className="demo-walkthrough-banner"
          aria-label="Guided evaluator tour"
        >
          <div className="demo-walkthrough-meta">
            <span className="demo-walkthrough-kicker">
              Guided Tour · Step {activeStepNumber} of 4
            </span>
            <div className="demo-walkthrough-track" aria-hidden="true">
              <span
                className="demo-walkthrough-track-fill"
                style={{ width: `${(activeStepNumber / 4) * 100}%` }}
              />
            </div>
          </div>
          <nav
            className="demo-walkthrough-stepper"
            aria-label="Guided demo milestones"
          >
            <button
              type="button"
              className="demo-step-pill"
              aria-current={isMilestoneActive('timeline') ? 'step' : undefined}
              data-completed={activeStepNumber > 1 ? 'true' : undefined}
              onClick={() => jumpTo('Summary', 'timeline')}
            >
              <IconHistory size={14} aria-hidden="true" />
              <span>1. Timeline</span>
            </button>
            <button
              type="button"
              className="demo-step-pill"
              aria-current={isMilestoneActive('diff') ? 'step' : undefined}
              data-completed={activeStepNumber > 2 ? 'true' : undefined}
              onClick={() => jumpTo('Evidence', 'code_diff', 'Code changes')}
            >
              <IconCode size={14} aria-hidden="true" />
              <span>2. Code Diff</span>
            </button>
            <button
              type="button"
              className="demo-step-pill"
              aria-current={isMilestoneActive('runs') ? 'step' : undefined}
              data-completed={activeStepNumber > 3 ? 'true' : undefined}
              onClick={() => {
                const nextFilter =
                  activeTab === 'Evidence' &&
                  evidenceFilter === 'Execution runs'
                    ? 'AI conversations'
                    : 'Execution runs';
                jumpTo(
                  'Evidence',
                  nextFilter === 'AI conversations' ? 'ai_log' : 'test_runs',
                  nextFilter,
                );
              }}
            >
              <IconTerminal2 size={14} aria-hidden="true" />
              <span>3. Test Runs &amp; AI Log</span>
            </button>
            <button
              type="button"
              className="demo-step-pill"
              aria-current={isMilestoneActive('verdict') ? 'step' : undefined}
              onClick={() => jumpTo('Review', 'human_verdict')}
            >
              <IconGavel size={14} aria-hidden="true" />
              <span>4. Human Verdict</span>
            </button>
          </nav>
        </section>
        <EvaluatorExperience
          sessionId={DEMO_SESSION_ID}
          readOnly
          demoMode
          r27Evidence={DEMO_R27_EVIDENCE}
          hiringReviewContext={DEMO_HIRING_REVIEW_CONTEXT}
          controlledTab={activeTab}
          onTabChange={(next) => {
            setActiveTab(next);
            trackClientEvent({
              eventName: 'demo.tab.viewed',
              category: 'acquisition',
              actorType: 'visitor',
              route: '/demo',
              properties: { tab: next.toLowerCase(), milestone: 'tab_bar' },
            });
          }}
          controlledFilter={evidenceFilter}
          onFilterChange={setEvidenceFilter}
          onSimulatedPublish={handleSimulatedPublish}
        />
      </main>

      {simulatedModal ? (
        <div
          className="r210-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="demo-simulated-modal-title"
          data-testid="demo-simulated-decision-modal"
        >
          <div
            className="r210-modal-dialog hiring-stack-sm"
            style={{ maxWidth: '580px' }}
          >
            <div className="hiring-preview-header">
              <div className="hiring-chip-group">
                <span
                  className={`hiring-pill ${simulatedModal.decision === 'accepted' ? 'hiring-pill-success' : 'hiring-pill-danger'}`}
                  style={{ marginBlockStart: 0 }}
                >
                  <IconCheck size={14} aria-hidden="true" />
                  {simulatedModal.decision === 'accepted'
                    ? `Simulated Advance · ${simulatedModal.nextStageLabel || 'Next Stage'}`
                    : 'Simulated Hold / Do Not Advance'}
                </span>
              </div>
              <button
                type="button"
                className="hiring-btn hiring-btn-sm"
                aria-label="Close simulated handoff preview"
                onClick={() => setSimulatedModal(null)}
              >
                <IconX size={15} aria-hidden="true" /> Close
              </button>
            </div>

            <h2 id="demo-simulated-modal-title" style={{ margin: 0 }}>
              Executive Dossier Preview Ready
            </h2>
            <p className="hiring-muted-copy">
              In a live organization workspace, publishing a human verdict
              generates a shareable, redacted executive dossier for your CTO or
              hiring panel—with zero leaked PII or private scratchpad notes.
            </p>

            {simulatedModal.strengths.length > 0 ||
            simulatedModal.feedbackNote ? (
              <div className="hiring-card-subtle hiring-stack-xs">
                <strong>What the executive brief captures</strong>
                {simulatedModal.strengths.length > 0 ? (
                  <ul className="hiring-bullet-list">
                    {simulatedModal.strengths.slice(0, 3).map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {simulatedModal.feedbackNote ? (
                  <p className="hiring-muted-copy">
                    {simulatedModal.feedbackNote}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="hiring-header-actions">
              <Link
                href="/dossier/demo"
                className="hiring-btn"
                onClick={() => handleCtaClick('simulated_modal_dossier')}
              >
                <IconExternalLink size={15} aria-hidden="true" />
                Preview /dossier/demo
              </Link>
              <Link
                href={ctaHref}
                className="hiring-btn hiring-btn-primary"
                onClick={() => handleCtaClick('simulated_modal_cta')}
              >
                {ctaLabel} <IconArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
