'use client';

import type { CandidateEphemeralUiMode } from '../../../src/candidate/candidate-experience-state';
import type { CandidateSessionView } from '../../../src/sessions/candidate-session-view';
import type { TaskRubricSnapshot } from '../../../src/assessments/task-rubric';

type CandidatePrestartProps = Readonly<{
  session: CandidateSessionView;
  uiMode: CandidateEphemeralUiMode;
  setUiMode: (mode: CandidateEphemeralUiMode) => void;
  onStartAssessment: () => void;
  isActivating: boolean;
  provisioningError: string | null;
  onRetryProvisioning: () => void;
}>;

const formatDurationDescription = (
  durationSeconds: number | null | undefined,
): string => {
  if (!durationSeconds || durationSeconds <= 0) {
    return 'Untimed';
  }
  const minutes = Math.round(durationSeconds / 60);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours > 1 ? 's' : ''} (${minutes} minutes)`;
  }
  return `${minutes} minutes`;
};

export const CandidatePrestart = ({
  session,
  uiMode,
  setUiMode,
  onStartAssessment,
  isActivating,
  provisioningError,
  onRetryProvisioning,
}: CandidatePrestartProps) => {
  const durationText = formatDurationDescription(session.durationSeconds);
  const aiEnabled = session.aiCapability?.enabled ?? false;
  const rubricSession = session as CandidateSessionView & {
    taskRubric?: TaskRubricSnapshot | null;
  };
  const taskRubric = rubricSession.taskRubric ?? null;
  const hasTaskRubricProjection = 'taskRubric' in session;

  // 1. Provisioning Failure State (Platform Failure)
  if (provisioningError) {
    return (
      <main
        className="candidate-workspace software-product workspace-shell"
        aria-labelledby="prestart-title"
      >
        <header className="workspace-header">
          <div>
            <div className="candidate-brand">
              <strong>Hirearchy</strong>
              <span>Software</span>
            </div>
            <p className="session-reference">Session {session.id}</p>
          </div>
          <span className="status status-danger" role="status">
            Setup paused
          </span>
        </header>

        <div className="prestart-card" role="alert" aria-live="polite">
          <p className="eyebrow">Platform Notice</p>
          <h1 id="prestart-title">Environment Setup Incomplete</h1>
          <p className="summary">
            The assessment environment could not be prepared at this time. Your
            assessment timer has not started.
          </p>

          <div className="prestart-box error-box">
            <p className="box-title">System Status</p>
            <p className="box-detail">{provisioningError}</p>
          </div>

          <div className="button-row">
            <button
              type="button"
              className="button button-primary"
              onClick={onRetryProvisioning}
              disabled={isActivating}
            >
              {isActivating ? 'Retrying preparation…' : 'Retry preparation'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setUiMode('ready_to_start')}
              disabled={isActivating}
            >
              Back to start confirmation
            </button>
          </div>
        </div>
      </main>
    );
  }

  // 2. Provisioning in Progress
  if (uiMode === 'provisioning') {
    return (
      <main
        className="candidate-workspace software-product workspace-shell"
        aria-labelledby="prestart-title"
      >
        <header className="workspace-header">
          <div>
            <div className="candidate-brand">
              <strong>Hirearchy</strong>
              <span>Software</span>
            </div>
            <p className="session-reference">Session {session.id}</p>
          </div>
          <span className="status" role="status">
            Provisioning
          </span>
        </header>

        <div className="prestart-card" role="status" aria-live="polite">
          <p className="eyebrow">Workspace Initialization</p>
          <h1 id="prestart-title">Preparing your assessment environment…</h1>
          <p className="summary">
            Setting up your isolated workspace, configuring tool access, and
            verifying readiness.
          </p>

          <div className="prestart-box info-box">
            <p className="box-title">Timing Status</p>
            <p className="box-detail">
              Your assessment timer has not started. Timing will begin only when
              your workspace is verified and ready.
            </p>
          </div>
        </div>
      </main>
    );
  }

  // 3. Ready to Start Confirmation
  if (uiMode === 'ready_to_start') {
    return (
      <main
        className="candidate-workspace software-product workspace-shell"
        aria-labelledby="prestart-title"
      >
        <header className="workspace-header">
          <div>
            <div className="candidate-brand">
              <strong>Hirearchy</strong>
              <span>Software</span>
            </div>
            <p className="session-reference">Session {session.id}</p>
          </div>
          <span className="status">Ready</span>
        </header>

        <div className="prestart-card">
          <p className="eyebrow">Step 2 of 2 · Confirmation</p>
          <h1 id="prestart-title">Ready to Begin Assessment</h1>
          <p className="summary">
            You are about to start your assessment. You will have {durationText}{' '}
            once your workspace is prepared.
          </p>

          <div className="prestart-box highlight-box">
            <p className="box-title">Timing Notice</p>
            <p className="box-detail">
              Your assessment clock begins only when the workspace has been
              successfully prepared and verified. Setup time is not deducted
              from your assessment duration.
            </p>
          </div>

          <div className="button-row">
            <button
              type="button"
              className="button button-primary"
              onClick={onStartAssessment}
              disabled={isActivating}
            >
              {isActivating ? 'Preparing environment…' : 'Start Assessment'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setUiMode('orientation')}
              disabled={isActivating}
            >
              Back to orientation
            </button>
          </div>
        </div>
      </main>
    );
  }

  // 4. Orientation View
  if (uiMode === 'orientation') {
    return (
      <main
        className="candidate-workspace software-product workspace-shell"
        aria-labelledby="prestart-title"
      >
        <header className="workspace-header">
          <div>
            <div className="candidate-brand">
              <strong>Hirearchy</strong>
              <span>Software</span>
            </div>
            <p className="session-reference">Session {session.id}</p>
          </div>
          <span className="status">Orientation</span>
        </header>

        <div className="prestart-card">
          <p className="eyebrow">Step 1 of 2 · Environment Orientation</p>
          <h1 id="prestart-title">Assessment Guidelines & Environment</h1>
          <p className="summary">
            Review how your assessment workspace functions before you begin.
          </p>

          <div className="orientation-grid">
            <section
              className="orientation-section"
              aria-labelledby="heading-duration"
            >
              <h2 id="heading-duration" className="section-title">
                Assessment Duration
              </h2>
              <p className="section-body">
                You will have <strong>{durationText}</strong> once the
                assessment begins. Your timer will start only when your
                environment is fully prepared.
              </p>
            </section>

            <section
              className="orientation-section"
              aria-labelledby="heading-tools"
            >
              <h2 id="heading-tools" className="section-title">
                Available Tools
              </h2>
              <ul className="orientation-list">
                <li>
                  <strong>File Editor:</strong> Inspect and edit source code in
                  the workspace.
                </li>
                <li>
                  <strong>Commands:</strong>{' '}
                  {session.terminalEnabled
                    ? 'Run commands and tests inside the assessment environment.'
                    : 'Not enabled for this assessment.'}
                </li>
                <li>
                  <strong>Integrated AI Assistant:</strong>{' '}
                  {aiEnabled
                    ? 'Permitted and integrated into your workspace panel.'
                    : 'Not enabled for this scenario.'}
                </li>
                <li>
                  <strong>Scenario Brief:</strong> Problem requirements and
                  guidelines.
                </li>
              </ul>
            </section>

            <section
              className="orientation-section"
              aria-labelledby="heading-ai"
            >
              <h2 id="heading-ai" className="section-title">
                AI Policy
              </h2>
              <p className="section-body">
                The integrated AI assistant is{' '}
                {aiEnabled ? 'available' : 'not available'} for this assessment.
                Interactions through it are recorded; this does not establish
                how submitted code was written. You remain responsible for the
                accuracy, design, and quality of your submitted work.
              </p>
            </section>

            <section
              className="orientation-section"
              aria-labelledby="heading-recording"
            >
              <h2 id="heading-recording" className="section-title">
                Observable Activity
              </h2>
              <p className="section-body">
                Work performed inside the assessment environment is recorded as
                part of the technical assessment.
              </p>
            </section>

            {taskRubric?.criteria.length ? (
              <section
                className="orientation-section candidate-task-rubric"
                aria-labelledby="candidate-rubric-title"
              >
                <h2 id="candidate-rubric-title" className="section-title">
                  Task criteria
                </h2>
                <p className="section-body">
                  After submission, recorded evidence about your work is
                  analyzed against these task-specific criteria. They describe
                  this work sample, not general suitability. A human evaluator
                  owns every hiring decision.
                </p>
                <ol className="candidate-rubric-list">
                  {taskRubric.criteria.map((criterion) => (
                    <li key={criterion.id}>
                      <div>
                        <strong>{criterion.label}</strong>
                        <span>{criterion.description}</span>
                        {criterion.applicability.kind !== 'always' ? (
                          <small>{criterion.applicability.rule}</small>
                        ) : null}
                      </div>
                      <span>{criterion.weight}%</span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : (
              <section
                className="orientation-section"
                aria-labelledby="candidate-rubric-title"
              >
                <h2 id="candidate-rubric-title" className="section-title">
                  Task criteria
                </h2>
                <p className="section-body">
                  {hasTaskRubricProjection
                    ? 'This session has no saved task rubric, so a scored task report will not be available.'
                    : 'Task-specific criteria are not available for this session yet. Review the task instructions before you begin.'}
                </p>
              </section>
            )}

            <section
              className="orientation-section"
              aria-labelledby="heading-persistence"
            >
              <h2 id="heading-persistence" className="section-title">
                Workspace Persistence
              </h2>
              <p className="section-body">
                File modifications persist in the workspace when saved. Save
                failures are reported immediately.
              </p>
            </section>

            <section
              className="orientation-section"
              aria-labelledby="heading-submission"
            >
              <h2 id="heading-submission" className="section-title">
                Submission & Expiry
              </h2>
              <p className="section-body">
                You can submit your assessment before time ends. You’ll review
                your submission before final confirmation. If time expires,
                modifications stop automatically and the assessment finalizes.
              </p>
            </section>
          </div>

          <div className="button-row">
            <button
              type="button"
              className="button button-primary"
              onClick={() => setUiMode('ready_to_start')}
            >
              Continue to start
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setUiMode('entry')}
            >
              Back to overview
            </button>
          </div>
        </div>
      </main>
    );
  }

  // 5. Default ENTRY View
  return (
    <main
      className="candidate-workspace software-product workspace-shell"
      aria-labelledby="prestart-title"
    >
      <header className="workspace-header">
        <div>
          <div className="candidate-brand">
            <strong>Hirearchy</strong>
            <span>Software</span>
          </div>
          <p className="session-reference">Session {session.id}</p>
        </div>
        <span className="status">Pre-start</span>
      </header>

      <div className="prestart-card">
        <p className="eyebrow">Technical Evaluation</p>
        <h1 id="prestart-title">
          {session.scenario?.title || 'Engineering Assessment'}
        </h1>
        <p className="summary">
          You will complete an engineering task in a dedicated assessment
          workspace. The tools available for this assessment are listed in the
          orientation.
        </p>

        <div className="prestart-box highlight-box">
          <p className="box-title">Expected Duration</p>
          <p className="box-detail">
            You will have {durationText} once the assessment begins. Your time
            limit will not start until you review the orientation and complete
            environment setup.
          </p>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setUiMode('orientation')}
          >
            Continue to orientation
          </button>
        </div>
      </div>
    </main>
  );
};
