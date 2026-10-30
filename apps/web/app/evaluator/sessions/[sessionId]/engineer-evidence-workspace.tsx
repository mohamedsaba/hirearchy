'use client';

import { useState } from 'react';
import { IconFileDescription } from '@tabler/icons-react';
import type {
  ObservedStatement,
  BriefingAiSummary,
  RecordedVerification,
  SubmittedStateSummary,
} from '../../../../src/evaluator/evaluator-briefing';
import type { EvaluatorReviewPresentation } from '../../../../src/evaluator/evaluator-review-presentation';
import type { EvidenceCatalogEntry } from '../../../../src/reconstruction/evidence-reference-catalog';
import { EvidenceItemCard } from './evidence-item-card';
import { RecordedActivity } from './recorded-activity';
import { SubmittedWork } from './submitted-work';
import { TechnicalRecord } from './technical-record';

type InspectionPanel = 'evidence' | 'submittedChanges' | 'technicalRecord';

type EngineerEvidenceWorkspaceProps = Readonly<{
  activities: readonly ObservedStatement[];
  verification: RecordedVerification;
  evidenceEntries: readonly EvidenceCatalogEntry[];
  review: EvaluatorReviewPresentation;
  submittedState: SubmittedStateSummary;
  activatedAt: string | null;
  aiSummary: BriefingAiSummary;
  initialSelectedEvidenceRef?: string | null;
  focusEvidenceRef?: string | null;
  showDetailedTechnical?: boolean;
  showConfiguredModel?: boolean;
  showTokenTelemetry?: boolean;
  showTechnicalViews?: boolean;
}>;

export const EngineerEvidenceWorkspace = ({
  activities,
  verification,
  evidenceEntries,
  review,
  submittedState,
  activatedAt,
  aiSummary,
  initialSelectedEvidenceRef = null,
  focusEvidenceRef = null,
  showDetailedTechnical = true,
  showConfiguredModel = true,
  showTokenTelemetry = true,
  showTechnicalViews = true,
}: EngineerEvidenceWorkspaceProps) => {
  const initialEvidenceRef = evidenceEntries.some(
    (entry) => entry.evidenceRef === initialSelectedEvidenceRef,
  )
    ? initialSelectedEvidenceRef
    : null;
  const [selectedEvidenceRef, setSelectedEvidenceRef] = useState<string | null>(
    initialEvidenceRef,
  );
  const [selectedPanel, setSelectedPanel] = useState<InspectionPanel>(
    initialEvidenceRef || !showTechnicalViews ? 'evidence' : 'submittedChanges',
  );
  const selectedEntry = evidenceEntries.find(
    (entry) => entry.evidenceRef === selectedEvidenceRef,
  );

  const selectEvidence = (evidenceRef: string) => {
    setSelectedEvidenceRef(evidenceRef);
    setSelectedPanel('evidence');
  };

  const returnToChronology = () => {
    if (!selectedEvidenceRef) return;
    const activity = Array.from(
      document.querySelectorAll<HTMLElement>('[data-evidence-refs]'),
    ).find((element) =>
      element.dataset.evidenceRefs?.split(' ').includes(selectedEvidenceRef),
    );
    const control = activity?.querySelector<HTMLButtonElement>(
      '[data-evidence-control]',
    );
    if (control) {
      control.scrollIntoView?.({ block: 'center' });
      control.focus();
      return;
    }
    activity?.scrollIntoView?.({ block: 'center' });
    activity?.focus();
  };

  return (
    <section
      className="engineer-evidence-workspace"
      aria-label="Engineer evidence workspace"
    >
      <div className="engineer-chronology-context">
        <RecordedActivity
          activities={activities}
          verification={verification}
          evidenceEntries={evidenceEntries}
          showDetailedTechnical={showDetailedTechnical}
          showStructuredEvidence
          showDirectEvidenceLinks
          showVerificationChronology
          aiSummary={aiSummary}
          showConfiguredModel={showConfiguredModel}
          showTokenTelemetry={showTokenTelemetry}
          activatedAt={activatedAt}
          selectedEvidenceRef={selectedEvidenceRef}
          focusEvidenceRef={focusEvidenceRef}
          onSelectEvidence={selectEvidence}
        />
      </div>

      <aside
        className="engineer-inspection-panel"
        id="engineer-inspection"
        aria-labelledby="engineer-inspection-title"
      >
        <header className="review-section-heading engineer-inspection-heading">
          <span className="evaluator-review-title-icon" aria-hidden="true">
            <IconFileDescription size={22} stroke={1.8} />
          </span>
          <div>
            <p className="section-kicker">Technical inspection</p>
            <h2 id="engineer-inspection-title">Event details</h2>
            <p>
              Chronology remains visible while inspecting recorded details. The
              source record is not an evaluator conclusion.
            </p>
          </div>
        </header>

        {selectedEvidenceRef ? (
          <button
            type="button"
            className="evaluator-return-to-chronology"
            aria-controls="reconstruction"
            onClick={returnToChronology}
          >
            ← Back to chronology
          </button>
        ) : null}

        {showTechnicalViews ? (
          <div
            className="engineer-inspection-actions"
            role="group"
            aria-label="Inspection views"
          >
            <button
              type="button"
              className="evidence-toggle-button"
              aria-pressed={selectedPanel === 'submittedChanges'}
              onClick={() => setSelectedPanel('submittedChanges')}
            >
              Final submitted state
            </button>
            <button
              type="button"
              className="evidence-toggle-button"
              aria-pressed={selectedPanel === 'technicalRecord'}
              onClick={() => setSelectedPanel('technicalRecord')}
            >
              Technical record
            </button>
          </div>
        ) : null}

        {selectedPanel === 'submittedChanges' ? (
          <SubmittedWork
            submittedState={submittedState}
            diff={review.submittedDiff}
          />
        ) : null}

        {selectedPanel === 'technicalRecord' ? (
          <TechnicalRecord review={review} activatedAt={activatedAt} />
        ) : null}

        {selectedPanel === 'evidence' && selectedEntry ? (
          <section
            className="engineer-selected-evidence"
            aria-labelledby="selected-evidence-title"
          >
            <h3 id="selected-evidence-title">Selected source evidence</h3>
            {showDetailedTechnical ? (
              <dl className="engineer-evidence-provenance">
                <div>
                  <dt>Evidence reference</dt>
                  <dd>
                    <code>{selectedEntry.evidenceRef}</code>
                  </dd>
                </div>
                <div>
                  <dt>Record kind</dt>
                  <dd>{selectedEntry.kind}</dd>
                </div>
                <div>
                  <dt>Evidence role</dt>
                  <dd>{selectedEntry.role}</dd>
                </div>
              </dl>
            ) : null}
            {selectedEntry.item ? (
              <EvidenceItemCard
                item={selectedEntry.item}
                showConfiguredModel={showConfiguredModel}
                showTokenTelemetry={showTokenTelemetry}
                showTechnicalDetails={showDetailedTechnical}
              />
            ) : (
              <p className="empty-evidence-copy">
                Source evidence reference: {selectedEntry.evidenceRef}.
              </p>
            )}
          </section>
        ) : null}

        {selectedPanel === 'evidence' && !selectedEntry ? (
          <p className="empty-evidence-copy">
            Select evidence from the chronology to inspect its recorded details.
          </p>
        ) : null}
      </aside>
    </section>
  );
};
