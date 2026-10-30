'use client';

import Link from 'next/link';
import { useState } from 'react';
import type {
  R211AssessmentDraft,
  R211StarterFile,
  R211RubricCriterion,
  R211ValidationIssue,
  R211ValidatedVersion,
} from '../../../../../src/r211-builder/contract';
import {
  formatDigestBadge,
  formatFullDigest,
  EXECUTION_VALIDATION_NOTICE,
  CONCURRENCY_CONFLICT_BANNER,
  DRAFT_SAVED_MESSAGE,
  VALIDATION_FAILED_MESSAGE,
} from '../../../../../src/r211-builder/presentation';

import '../../../../evaluator/assessments/new/assessment-builder.css';
import '../../../../evaluator/assessments/new/assessment-choice.css';

export interface AssessmentBuilderClientProps {
  organizationId: string;
  csrfToken: string;
  initialDraft: R211AssessmentDraft | null;
}

type BuilderStage = 'define' | 'validate' | 'issue';

const defaultStarterFiles: R211StarterFile[] = [
  {
    path: 'booking.py',
    content: '# Primary booking implementation\ndef book():\n    pass\n',
  },
  {
    path: 'README.md',
    content: '# Challenge Instructions\nFollow candidate brief.\n',
  },
  {
    path: 'tests/test_booking.py',
    content:
      'import unittest\n\nclass TestBooking(unittest.TestCase):\n    pass\n',
  },
];

const defaultRubric: R211RubricCriterion[] = [
  {
    id: 'correctness',
    label: 'Correctness',
    description: 'Handles retries and error conditions correctly.',
    weight: 60,
    applicability: {
      kind: 'always',
      rule: 'Applies to all candidate submissions',
    },
  },
  {
    id: 'code-quality',
    label: 'Code Quality',
    description: 'Clean, idiomatic code and error logging.',
    weight: 40,
    applicability: {
      kind: 'always',
      rule: 'Applies to all candidate submissions',
    },
  },
];

export function AssessmentBuilderClient({
  organizationId,
  csrfToken,
  initialDraft,
}: AssessmentBuilderClientProps) {
  const [stage, setStage] = useState<BuilderStage>('define');

  // Draft state
  const [definitionId, setDefinitionId] = useState<string | undefined>(
    initialDraft?.definitionId,
  );
  const [draftVersion, setDraftVersion] = useState<number>(
    initialDraft?.version ?? 1,
  );
  const [templateId, setTemplateId] = useState<
    'custom' | 'reservation-moves-v3'
  >(initialDraft?.templateId ?? 'custom');
  const [title, setTitle] = useState(
    initialDraft?.title ?? 'Booking Notification Retry Logic',
  );
  const [brief, setBrief] = useState(
    initialDraft?.brief ??
      'Implement retry logic with exponential backoff for the notification dispatch service.',
  );
  const [expectedBehavior, setExpectedBehavior] = useState<string[]>(
    initialDraft?.expectedBehavior && initialDraft.expectedBehavior.length > 0
      ? [...initialDraft.expectedBehavior]
      : [
          'Retries transient connection errors up to 3 times',
          'Logs retry attempt with sequence and delay',
        ],
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>(
    initialDraft?.acceptanceCriteria &&
      initialDraft.acceptanceCriteria.length > 0
      ? [...initialDraft.acceptanceCriteria]
      : [
          'All tests in tests/test_booking.py pass cleanly',
          'No unhandled connection timeout exceptions raised',
        ],
  );
  const [primaryFilePath, setPrimaryFilePath] = useState(
    initialDraft?.primaryFilePath ?? 'booking.py',
  );
  const [starterFiles, setStarterFiles] = useState<R211StarterFile[]>(
    initialDraft?.starterFiles && initialDraft.starterFiles.length > 0
      ? [...initialDraft.starterFiles]
      : defaultStarterFiles,
  );
  const [durationMinutes, setDurationMinutes] = useState<number>(
    initialDraft?.durationMinutes ?? 45,
  );
  const [terminalEnabled, setTerminalEnabled] = useState<boolean>(
    initialDraft?.terminalEnabled ?? true,
  );
  const [integratedAi, setIntegratedAi] = useState<boolean>(
    initialDraft?.integratedAi ?? false,
  );
  const [rubric, setRubric] = useState<R211RubricCriterion[]>(
    initialDraft?.rubric && initialDraft.rubric.length > 0
      ? [...initialDraft.rubric]
      : defaultRubric,
  );

  // Status & communication states
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saved' | 'conflict' | 'error'
  >('idle');
  const [saveErrorMessage, setSaveErrorMessage] = useState<string | null>(null);

  // Validation state
  const [isValidating, setIsValidating] = useState(false);
  const [validationIssues, setValidationIssues] = useState<
    R211ValidationIssue[]
  >([]);
  const [validationErrorMessage, setValidationErrorMessage] = useState<
    string | null
  >(null);
  const [validatedVersion, setValidatedVersion] =
    useState<R211ValidatedVersion | null>(null);

  // Issuance state
  const [isIssuing, setIsIssuing] = useState(false);
  const [issuedSession, setIssuedSession] = useState<{
    sessionId: string;
    candidatePath: string;
  } | null>(null);
  const [issuanceError, setIssuanceError] = useState<string | null>(null);

  const [idempotencyKey] = useState(
    () => `r211-issue-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  // Rubric weights sum
  const rubricTotalWeight = rubric.reduce(
    (sum, crit) => sum + (Number.isInteger(crit.weight) ? crit.weight : 0),
    0,
  );

  // Helper to get issue for specific field
  const getFieldIssue = (fieldName: string) => {
    return validationIssues.find((issue) => issue.field === fieldName)?.message;
  };

  // Save Draft Action
  const handleSaveDraft = async () => {
    setIsSaving(true);
    setSaveStatus('idle');
    setSaveErrorMessage(null);

    const payload = {
      templateId,
      definitionId,
      title,
      brief,
      expectedBehavior,
      acceptanceCriteria,
      primaryFilePath,
      starterFiles,
      durationMinutes,
      terminalEnabled,
      integratedAi,
      rubric,
      expectedVersion: draftVersion,
      csrf: csrfToken,
    };

    try {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/assessments/draft`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: window.location.origin,
          },
          body: JSON.stringify(payload),
        },
      );

      if (response.status === 409) {
        setSaveStatus('conflict');
        setSaveErrorMessage(CONCURRENCY_CONFLICT_BANNER);
        return;
      }

      if (!response.ok) {
        const errJson = await response.json().catch(() => null);
        setSaveStatus('error');
        setSaveErrorMessage(
          errJson?.error?.message ??
            `Failed to save draft (${response.status})`,
        );
        return;
      }

      const data = await response.json();
      if (data?.draft) {
        setDefinitionId(data.draft.definitionId);
        setDraftVersion(data.draft.version);
      }
      setSaveStatus('saved');
    } catch (err: unknown) {
      setSaveStatus('error');
      setSaveErrorMessage(
        err instanceof Error
          ? err.message
          : 'Network error while saving draft.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Validate Action
  const handleValidate = async () => {
    setIsValidating(true);
    setValidationIssues([]);
    setValidationErrorMessage(null);

    const payload = {
      templateId,
      definitionId,
      title,
      brief,
      expectedBehavior,
      acceptanceCriteria,
      primaryFilePath,
      starterFiles,
      durationMinutes,
      terminalEnabled,
      integratedAi,
      rubric,
      expectedDraftVersion: draftVersion,
      csrf: csrfToken,
    };

    try {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/assessments/validate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: window.location.origin,
          },
          body: JSON.stringify(payload),
        },
      );

      const data = await response.json().catch(() => null);

      if (response.status === 422 || data?.valid === false) {
        setValidationIssues(data?.issues ?? []);
        setValidationErrorMessage(
          data?.issues?.[0]?.message ?? VALIDATION_FAILED_MESSAGE,
        );
        return;
      }

      if (!response.ok || !data?.version) {
        setValidationErrorMessage(
          data?.error?.message ??
            `Validation failed with status ${response.status}`,
        );
        return;
      }

      // Validated successfully
      setValidatedVersion(data.version);
      if (data?.draft) {
        setDefinitionId(data.draft.definitionId);
        setDraftVersion(data.draft.version);
      }
      setSaveStatus('idle');
      setValidationIssues([]);
      setValidationErrorMessage(null);
    } catch (err: unknown) {
      setValidationErrorMessage(
        err instanceof Error
          ? err.message
          : 'Network error validating assessment.',
      );
    } finally {
      setIsValidating(false);
    }
  };

  // Issue Action
  const handleIssue = async () => {
    if (!validatedVersion) return;
    setIsIssuing(true);
    setIssuanceError(null);

    try {
      const response = await fetch(
        `/r23/api/organizations/${encodeURIComponent(organizationId)}/sessions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: window.location.origin,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            validatedVersionId: validatedVersion.id,
            scenarioId: validatedVersion.scenarioId || validatedVersion.id,
            durationMinutes: Math.round(validatedVersion.durationSeconds / 60),
            terminalEnabled: validatedVersion.terminalEnabled,
            integratedAi: validatedVersion.integratedAi,
            idempotencyKey,
            csrf: csrfToken,
          }),
        },
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setIssuanceError(
          data?.error?.message ??
            `Failed to issue assessment (${response.status})`,
        );
        return;
      }

      setIssuedSession({
        sessionId: data.sessionId,
        candidatePath: data.candidatePath ?? `/r26/candidate/${data.sessionId}`,
      });
    } catch (err: unknown) {
      setIssuanceError(
        err instanceof Error
          ? err.message
          : 'Network error issuing assessment.',
      );
    } finally {
      setIsIssuing(false);
    }
  };

  // Manage starter files
  const updateStarterFile = (
    index: number,
    field: 'path' | 'content',
    value: string,
  ) => {
    const updated = [...starterFiles];
    updated[index] = { ...updated[index], [field]: value };
    setStarterFiles(updated);
  };

  const addStarterFile = () => {
    setStarterFiles([...starterFiles, { path: 'new_file.py', content: '' }]);
  };

  const removeStarterFile = (index: number) => {
    if (starterFiles.length <= 1) return;
    setStarterFiles(starterFiles.filter((_, idx) => idx !== index));
  };

  // Manage rubric criteria
  const updateRubricCriterion = (
    index: number,
    field: 'label' | 'description' | 'weight',
    value: string | number,
  ) => {
    const updated = [...rubric];
    updated[index] = { ...updated[index], [field]: value };
    setRubric(updated);
  };

  const addRubricCriterion = () => {
    const newId = `criterion-${rubric.length + 1}`;
    setRubric([
      ...rubric,
      {
        id: newId,
        label: `Criterion ${rubric.length + 1}`,
        description: 'Evaluation criteria description',
        weight: 10,
        applicability: {
          kind: 'always',
          rule: 'Applies to all candidate submissions',
        },
      },
    ]);
  };

  const removeRubricCriterion = (index: number) => {
    if (rubric.length <= 1) return;
    setRubric(rubric.filter((_, idx) => idx !== index));
  };

  const updateExpectedBehavior = (index: number, val: string) => {
    const updated = [...expectedBehavior];
    updated[index] = val;
    setExpectedBehavior(updated);
  };

  const addExpectedBehavior = () => {
    setExpectedBehavior([...expectedBehavior, '']);
  };

  const removeExpectedBehavior = (index: number) => {
    if (expectedBehavior.length <= 1) return;
    setExpectedBehavior(expectedBehavior.filter((_, idx) => idx !== index));
  };

  const updateAcceptanceCriterion = (index: number, val: string) => {
    const updated = [...acceptanceCriteria];
    updated[index] = val;
    setAcceptanceCriteria(updated);
  };

  const addAcceptanceCriterion = () => {
    setAcceptanceCriteria([...acceptanceCriteria, '']);
  };

  const removeAcceptanceCriterion = (index: number) => {
    if (acceptanceCriteria.length <= 1) return;
    setAcceptanceCriteria(acceptanceCriteria.filter((_, idx) => idx !== index));
  };

  return (
    <div className="assessment-builder-page">
      <main className="assessment-builder-shell">
        <div className="assessment-builder-container">
          <header className="assessment-builder-hero">
            <p className="assessment-eyebrow">
              Hirearchy <span>/</span> Authoring Lane
            </p>
            <h1>PostgreSQL Assessment Builder</h1>
            <p>
              Author structured assessment challenges, validate scenario
              integrity, and issue tamper-evident candidate sessions with
              immutable content snapshots.
            </p>
          </header>

          {/* Stepper Navigation */}
          <nav className="assessment-stage-nav" aria-label="Assessment stages">
            <ol>
              <li>
                <button
                  type="button"
                  aria-current={stage === 'define' ? 'step' : undefined}
                  aria-label="Go to Define stage"
                  className="assessment-stage-button"
                  onClick={() => setStage('define')}
                >
                  <span className="assessment-stage-number">01</span>
                  <span className="assessment-stage-label">Define</span>
                  <span className="assessment-stage-caption">
                    {saveStatus === 'saved'
                      ? 'Draft saved'
                      : 'Author challenge'}
                  </span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  aria-current={stage === 'validate' ? 'step' : undefined}
                  aria-label="Go to Validate stage"
                  className="assessment-stage-button"
                  onClick={() => {
                    setStage('validate');
                    if (!validatedVersion) {
                      void handleValidate();
                    }
                  }}
                >
                  <span className="assessment-stage-number">02</span>
                  <span className="assessment-stage-label">Validate</span>
                  <span className="assessment-stage-caption">
                    {validatedVersion ? 'Validated' : 'Verify structure'}
                  </span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  aria-current={stage === 'issue' ? 'step' : undefined}
                  aria-label="Go to Issue stage"
                  className="assessment-stage-button"
                  onClick={() => setStage('issue')}
                >
                  <span className="assessment-stage-number">03</span>
                  <span className="assessment-stage-label">Issue</span>
                  <span className="assessment-stage-caption">
                    {issuedSession ? 'Session issued' : 'Issue to candidate'}
                  </span>
                </button>
              </li>
            </ol>
          </nav>

          {/* Stepper Content Panels */}
          <section
            className="assessment-stage-panel"
            aria-labelledby="assessment-stage-title"
            data-stage={stage}
          >
            <header className="assessment-stage-heading">
              <span className="assessment-stage-index">
                {stage === 'define' ? '01' : stage === 'validate' ? '02' : '03'}{' '}
                <span aria-hidden="true">/ 03</span>
              </span>
              <div>
                <h2 id="assessment-stage-title">
                  {stage === 'define'
                    ? 'Define Assessment'
                    : stage === 'validate'
                      ? 'Validate Structure & Integrity'
                      : 'Issue Assessment'}
                </h2>
                <p>
                  {stage === 'define'
                    ? 'Specify title, instructions, workspace files, duration, and evaluation rubric.'
                    : stage === 'validate'
                      ? 'Run static validation checks and generate immutable content-integrity digest.'
                      : 'Issue validated assessment version and receive unique candidate workspace link.'}
                </p>
              </div>
            </header>

            {/* STAGE 1: DEFINE */}
            {stage === 'define' && (
              <div
                className="assessment-stage-content"
                style={{ padding: '24px' }}
              >
                {/* Save Feedback Alerts */}
                {saveStatus === 'saved' && (
                  <div
                    className="assessment-feedback"
                    role="status"
                    data-testid="draft-status"
                    style={{
                      borderColor: 'var(--software-mint-border, #10b981)',
                      background: 'var(--software-mint, #ecfdf5)',
                      color: 'var(--software-ink, #064e3b)',
                      marginBottom: '16px',
                    }}
                  >
                    <span>
                      {DRAFT_SAVED_MESSAGE} (Version {draftVersion})
                    </span>
                  </div>
                )}
                {saveStatus === 'conflict' && (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    data-testid="draft-status"
                    style={{ marginBottom: '16px' }}
                  >
                    <span>{saveErrorMessage}</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    data-testid="draft-status"
                    style={{ marginBottom: '16px' }}
                  >
                    <span>{saveErrorMessage}</span>
                  </div>
                )}

                <div style={{ marginBottom: '20px' }}>
                  <label htmlFor="assessment-template">
                    Assessment template
                  </label>
                  <select
                    id="assessment-template"
                    value={templateId}
                    disabled={Boolean(issuedSession)}
                    onChange={(event) => {
                      setTemplateId(
                        event.target.value as 'custom' | 'reservation-moves-v3',
                      );
                      setValidatedVersion(null);
                    }}
                  >
                    <option value="custom">Custom authored assessment</option>
                    <option value="reservation-moves-v3">
                      Reservation Moves v3
                    </option>
                  </select>
                </div>
                {templateId === 'reservation-moves-v3' ? (
                  <p>
                    The Reservation Moves brief, starter workspace, rubric, and
                    pytest recipe are fixed by the reviewed template. Duration
                    and AI settings remain configurable.
                  </p>
                ) : (
                  <>
                    {/* Title */}
                    <div style={{ marginBottom: '20px' }}>
                      <label
                        htmlFor="assessment-title"
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        Assessment Title
                      </label>
                      <input
                        id="assessment-title"
                        name="title"
                        type="text"
                        data-testid="assessment-title-input"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 'var(--software-radius-control, 6px)',
                          border: '1px solid var(--software-border, #ccc)',
                          background: 'var(--software-surface, #fff)',
                          color: 'var(--software-ink, #000)',
                        }}
                      />
                      {getFieldIssue('title') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('title')}
                        </p>
                      )}
                    </div>

                    {/* Candidate Brief */}
                    <div style={{ marginBottom: '20px' }}>
                      <label
                        htmlFor="assessment-brief"
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        Candidate instructions / brief
                      </label>
                      <textarea
                        id="assessment-brief"
                        name="brief"
                        rows={5}
                        data-testid="assessment-brief-input"
                        value={brief}
                        onChange={(e) => setBrief(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 'var(--software-radius-control, 6px)',
                          border: '1px solid var(--software-border, #ccc)',
                          background: 'var(--software-surface, #fff)',
                          color: 'var(--software-ink, #000)',
                        }}
                      />
                      {getFieldIssue('brief') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('brief')}
                        </p>
                      )}
                    </div>

                    {/* Expected Behavior */}
                    <div style={{ marginBottom: '20px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '8px',
                        }}
                      >
                        <label style={{ fontWeight: 600 }}>
                          Expected Behavior Verification Targets
                        </label>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={addExpectedBehavior}
                          style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        >
                          + Add target
                        </button>
                      </div>
                      {expectedBehavior.map((item, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            type="text"
                            aria-label={`Expected behavior ${idx + 1}`}
                            value={item}
                            onChange={(e) =>
                              updateExpectedBehavior(idx, e.target.value)
                            }
                            style={{
                              flex: 1,
                              padding: '8px 10px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                            }}
                          />
                          <button
                            type="button"
                            disabled={expectedBehavior.length <= 1}
                            onClick={() => removeExpectedBehavior(idx)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                              background: '#fff',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      {getFieldIssue('expectedBehavior') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('expectedBehavior')}
                        </p>
                      )}
                    </div>

                    {/* Acceptance Criteria */}
                    <div style={{ marginBottom: '20px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '8px',
                        }}
                      >
                        <label style={{ fontWeight: 600 }}>
                          Acceptance Criteria
                        </label>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={addAcceptanceCriterion}
                          style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        >
                          + Add criterion
                        </button>
                      </div>
                      {acceptanceCriteria.map((item, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            type="text"
                            aria-label={`Acceptance criterion ${idx + 1}`}
                            value={item}
                            onChange={(e) =>
                              updateAcceptanceCriterion(idx, e.target.value)
                            }
                            style={{
                              flex: 1,
                              padding: '8px 10px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                            }}
                          />
                          <button
                            type="button"
                            disabled={acceptanceCriteria.length <= 1}
                            onClick={() => removeAcceptanceCriterion(idx)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                              background: '#fff',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      {getFieldIssue('acceptanceCriteria') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('acceptanceCriteria')}
                        </p>
                      )}
                    </div>

                    {/* Primary File Path */}
                    <div style={{ marginBottom: '20px' }}>
                      <label
                        htmlFor="primary-file-path"
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        Primary file path (.py)
                      </label>
                      <input
                        id="primary-file-path"
                        name="primaryFilePath"
                        type="text"
                        data-testid="primary-file-path-input"
                        value={primaryFilePath}
                        onChange={(e) => setPrimaryFilePath(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 'var(--software-radius-control, 6px)',
                          border: '1px solid var(--software-border, #ccc)',
                          background: 'var(--software-surface, #fff)',
                          color: 'var(--software-ink, #000)',
                        }}
                      />
                      {getFieldIssue('primaryFilePath') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('primaryFilePath')}
                        </p>
                      )}
                    </div>

                    {/* Starter Workspace Files */}
                    <div style={{ marginBottom: '24px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '10px',
                        }}
                      >
                        <label style={{ fontWeight: 600 }}>
                          Starter Workspace Files
                        </label>
                        <button
                          type="button"
                          data-testid="add-file-button"
                          className="button button-secondary"
                          onClick={addStarterFile}
                          style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        >
                          + Add file
                        </button>
                      </div>
                      {starterFiles.map((file, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: '12px',
                            border: '1px solid var(--software-border, #e5e7eb)',
                            borderRadius: 'var(--software-radius-control, 6px)',
                            marginBottom: '12px',
                            background: 'var(--software-canvas, #f9fafb)',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              gap: '8px',
                              marginBottom: '8px',
                            }}
                          >
                            <input
                              type="text"
                              aria-label={`Starter file ${idx + 1} path`}
                              placeholder="file path (e.g. app.py)"
                              data-testid={`file-path-input-${idx}`}
                              value={file.path}
                              onChange={(e) =>
                                updateStarterFile(idx, 'path', e.target.value)
                              }
                              style={{
                                flex: 1,
                                padding: '6px 10px',
                                borderRadius: '4px',
                                border:
                                  '1px solid var(--software-border, #ccc)',
                              }}
                            />
                            <button
                              type="button"
                              data-testid={`remove-file-button-${idx}`}
                              disabled={starterFiles.length <= 1}
                              onClick={() => removeStarterFile(idx)}
                              style={{
                                padding: '4px 8px',
                                borderRadius: '4px',
                                border:
                                  '1px solid var(--software-border, #ccc)',
                                background: '#fff',
                                cursor:
                                  starterFiles.length <= 1
                                    ? 'not-allowed'
                                    : 'pointer',
                              }}
                            >
                              Remove
                            </button>
                          </div>
                          <textarea
                            rows={4}
                            aria-label={`Starter file ${idx + 1} content`}
                            placeholder="file content..."
                            data-testid={`file-content-input-${idx}`}
                            value={file.content}
                            onChange={(e) =>
                              updateStarterFile(idx, 'content', e.target.value)
                            }
                            style={{
                              width: '100%',
                              fontFamily: 'monospace',
                              fontSize: '0.85rem',
                              padding: '8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                            }}
                          />
                        </div>
                      ))}
                      {getFieldIssue('starterFiles') && (
                        <p
                          style={{
                            color: 'var(--software-status-danger, #dc2626)',
                            fontSize: '0.8rem',
                            marginTop: '4px',
                          }}
                        >
                          {getFieldIssue('starterFiles')}
                        </p>
                      )}
                    </div>
                  </>
                )}
                {/* Duration and Capabilities */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '20px',
                    marginBottom: '24px',
                  }}
                >
                  <div>
                    <label
                      htmlFor="duration-minutes"
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        marginBottom: '6px',
                      }}
                    >
                      Duration
                    </label>
                    <select
                      id="duration-minutes"
                      name="durationMinutes"
                      value={durationMinutes}
                      onChange={(e) =>
                        setDurationMinutes(Number(e.target.value))
                      }
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: 'var(--software-radius-control, 6px)',
                        border: '1px solid var(--software-border, #ccc)',
                        background: 'var(--software-surface, #fff)',
                      }}
                    >
                      <option value={30}>30 minutes</option>
                      <option value={45}>45 minutes</option>
                      <option value={60}>60 minutes</option>
                      <option value={90}>90 minutes</option>
                    </select>
                  </div>

                  <div>
                    <span
                      style={{
                        display: 'block',
                        fontWeight: 600,
                        marginBottom: '6px',
                      }}
                    >
                      Capabilities
                    </span>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '8px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        id="terminal-enabled"
                        name="terminalEnabled"
                        checked={terminalEnabled}
                        onChange={(e) => setTerminalEnabled(e.target.checked)}
                      />
                      <span>Terminal verification enabled (required)</span>
                    </label>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        id="integrated-ai"
                        name="integratedAi"
                        checked={integratedAi}
                        onChange={(e) => setIntegratedAi(e.target.checked)}
                      />
                      <span>Integrated AI enabled (synthetic test lane)</span>
                    </label>
                    {getFieldIssue('terminalEnabled') && (
                      <p
                        style={{
                          color: 'var(--software-status-danger, #dc2626)',
                          fontSize: '0.8rem',
                          marginTop: '4px',
                        }}
                      >
                        {getFieldIssue('terminalEnabled')}
                      </p>
                    )}
                    {getFieldIssue('integratedAi') && (
                      <p
                        style={{
                          color: 'var(--software-status-danger, #dc2626)',
                          fontSize: '0.8rem',
                          marginTop: '4px',
                        }}
                      >
                        {getFieldIssue('integratedAi')}
                      </p>
                    )}
                  </div>
                </div>

                {templateId === 'custom' && (
                  /* Rubric Criteria */
                  <div style={{ marginBottom: '28px' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '10px',
                      }}
                    >
                      <div>
                        <span style={{ fontWeight: 600, display: 'block' }}>
                          Rubric Criteria & Weights
                        </span>
                        <span
                          data-testid="rubric-total-weight"
                          style={{
                            fontSize: '0.82rem',
                            color:
                              rubricTotalWeight === 100
                                ? 'var(--software-muted)'
                                : 'var(--software-status-danger, #dc2626)',
                            fontWeight: rubricTotalWeight === 100 ? 500 : 700,
                          }}
                        >
                          Total Weight: {rubricTotalWeight}% (must equal 100%)
                        </span>
                      </div>
                      <button
                        type="button"
                        data-testid="add-rubric-button"
                        className="button button-secondary"
                        onClick={addRubricCriterion}
                        style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                      >
                        + Add criterion
                      </button>
                    </div>
                    {rubric.map((crit, idx) => (
                      <div
                        key={crit.id}
                        style={{
                          padding: '12px',
                          border: '1px solid var(--software-border, #e5e7eb)',
                          borderRadius: 'var(--software-radius-control, 6px)',
                          marginBottom: '10px',
                          background: 'var(--software-surface, #fff)',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            gap: '8px',
                            marginBottom: '8px',
                          }}
                        >
                          <input
                            type="text"
                            aria-label={`Criterion ${idx + 1} label`}
                            placeholder="Criterion label"
                            value={crit.label}
                            onChange={(e) =>
                              updateRubricCriterion(
                                idx,
                                'label',
                                e.target.value,
                              )
                            }
                            style={{
                              flex: 2,
                              padding: '6px 10px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                            }}
                          />
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <input
                              type="number"
                              aria-label={`Criterion ${idx + 1} weight`}
                              value={crit.weight}
                              onChange={(e) =>
                                updateRubricCriterion(
                                  idx,
                                  'weight',
                                  Number(e.target.value),
                                )
                              }
                              style={{
                                width: '70px',
                                padding: '6px 10px',
                                borderRadius: '4px',
                                border:
                                  '1px solid var(--software-border, #ccc)',
                              }}
                            />
                            <span style={{ fontSize: '0.85rem' }}>%</span>
                          </div>
                          <button
                            type="button"
                            disabled={rubric.length <= 1}
                            onClick={() => removeRubricCriterion(idx)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '4px',
                              border: '1px solid var(--software-border, #ccc)',
                              background: '#fff',
                              cursor:
                                rubric.length <= 1 ? 'not-allowed' : 'pointer',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        <input
                          type="text"
                          aria-label={`Criterion ${idx + 1} description`}
                          placeholder="Criterion description"
                          value={crit.description}
                          onChange={(e) =>
                            updateRubricCriterion(
                              idx,
                              'description',
                              e.target.value,
                            )
                          }
                          style={{
                            width: '100%',
                            padding: '6px 10px',
                            borderRadius: '4px',
                            border: '1px solid var(--software-border, #ccc)',
                          }}
                        />
                      </div>
                    ))}
                    {getFieldIssue('rubric') && (
                      <p
                        style={{
                          color: 'var(--software-status-danger, #dc2626)',
                          fontSize: '0.8rem',
                          marginTop: '4px',
                        }}
                      >
                        {getFieldIssue('rubric')}
                      </p>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--software-border, #e5e7eb)',
                  }}
                >
                  <button
                    type="button"
                    data-testid="save-draft-button"
                    className="button button-secondary"
                    disabled={isSaving}
                    onClick={handleSaveDraft}
                  >
                    {isSaving ? 'Saving...' : 'Save draft'}
                  </button>

                  <button
                    type="button"
                    data-testid="continue-to-validate-button"
                    className="button button-primary"
                    onClick={() => {
                      setStage('validate');
                      void handleValidate();
                    }}
                  >
                    Continue to Validate →
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 2: VALIDATE */}
            {stage === 'validate' && (
              <div
                className="assessment-stage-content"
                style={{ padding: '24px' }}
              >
                {isValidating && (
                  <div
                    className="assessment-preparation-status"
                    style={{ marginBottom: '16px' }}
                  >
                    <span className="assessment-status-mark">⌛</span>
                    <div>
                      <strong>Validating Assessment Definition</strong>
                      <p>
                        Running structural checks, file path verification, and
                        rubric integrity audits...
                      </p>
                    </div>
                  </div>
                )}

                {/* Validation Error Banner */}
                {validationErrorMessage && (
                  <div
                    className="assessment-feedback assessment-feedback-error"
                    role="alert"
                    data-testid="validation-error-banner"
                    style={{ marginBottom: '20px' }}
                  >
                    <div>
                      <strong style={{ display: 'block', marginBottom: '4px' }}>
                        Validation Failed
                      </strong>
                      <span>{validationErrorMessage}</span>
                      {validationIssues.length > 0 && (
                        <ul style={{ margin: '8px 0 0', paddingLeft: '20px' }}>
                          {validationIssues.map((issue, idx) => (
                            <li key={idx}>
                              <code>{issue.field}</code>: {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setStage('define')}
                      style={{ flexShrink: 0, marginLeft: '12px' }}
                    >
                      Fix in Define
                    </button>
                  </div>
                )}

                {/* Validation Success */}
                {validatedVersion && !validationErrorMessage && (
                  <div style={{ marginBottom: '24px' }}>
                    <div
                      data-testid="validated-version-display"
                      style={{
                        padding: '16px',
                        borderRadius: 'var(--software-radius-control, 6px)',
                        border: '1px solid var(--software-border, #10b981)',
                        background: 'var(--software-mint, #ecfdf5)',
                        marginBottom: '16px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '8px',
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '1.1rem',
                            color: '#064e3b',
                          }}
                        >
                          Version {validatedVersion.versionNumber} Validated
                        </span>
                        <span
                          data-testid="content-digest-badge"
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '0.85rem',
                            padding: '4px 8px',
                            borderRadius: '999px',
                            background: '#047857',
                            color: '#fff',
                            fontWeight: 600,
                          }}
                        >
                          {formatDigestBadge(validatedVersion.contentDigest)}
                        </span>
                      </div>
                      <p
                        style={{
                          margin: '0 0 8px',
                          color: '#065f46',
                          fontSize: '0.9rem',
                        }}
                      >
                        Title: <strong>{validatedVersion.scenarioTitle}</strong>
                      </p>
                      <p
                        data-testid="execution-notice"
                        style={{
                          margin: 0,
                          fontSize: '0.82rem',
                          color: '#047857',
                          fontStyle: 'italic',
                        }}
                      >
                        {EXECUTION_VALIDATION_NOTICE}
                      </p>
                    </div>

                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--software-border, #e5e7eb)',
                        borderRadius: '6px',
                        background: 'var(--software-surface, #fff)',
                      }}
                    >
                      <h4 style={{ margin: '0 0 10px', fontSize: '0.95rem' }}>
                        Snapshot Summary
                      </h4>
                      <dl
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '140px 1fr',
                          gap: '6px',
                          fontSize: '0.85rem',
                          margin: 0,
                        }}
                      >
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Full Digest
                        </dt>
                        <dd
                          style={{
                            fontFamily: 'monospace',
                            wordBreak: 'break-all',
                          }}
                        >
                          {formatFullDigest(validatedVersion.contentDigest)}
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Scenario ID
                        </dt>
                        <dd>
                          <code>{validatedVersion.scenarioId}</code>
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Duration
                        </dt>
                        <dd>
                          {Math.round(validatedVersion.durationSeconds / 60)}{' '}
                          minutes
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Workspace Files
                        </dt>
                        <dd>
                          {
                            Object.keys(
                              validatedVersion.scenarioSnapshot
                                ?.workspaceFiles ?? {},
                            ).length
                          }{' '}
                          files included
                        </dd>
                      </dl>
                    </div>
                  </div>
                )}

                {/* Validate Stage Actions */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--software-border, #e5e7eb)',
                  }}
                >
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setStage('define')}
                  >
                    ← Back to Define
                  </button>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      type="button"
                      data-testid="validate-assessment-button"
                      className="button button-secondary"
                      disabled={isValidating}
                      onClick={handleValidate}
                    >
                      {isValidating ? 'Validating...' : 'Re-run Validation'}
                    </button>

                    <button
                      type="button"
                      data-testid="continue-to-issue-button"
                      className="button button-primary"
                      disabled={
                        !validatedVersion || Boolean(validationErrorMessage)
                      }
                      onClick={() => setStage('issue')}
                    >
                      Continue to Issue →
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* STAGE 3: ISSUE */}
            {stage === 'issue' && (
              <div
                className="assessment-stage-content"
                style={{ padding: '24px' }}
              >
                {!validatedVersion && (
                  <div
                    className="assessment-feedback assessment-feedback-warning"
                    style={{ marginBottom: '20px' }}
                  >
                    <span>
                      You must validate an assessment version before issuing
                      sessions.
                    </span>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setStage('validate')}
                    >
                      Go to Validate
                    </button>
                  </div>
                )}

                {validatedVersion && !issuedSession && (
                  <div>
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--software-border, #e5e7eb)',
                        borderRadius: '6px',
                        marginBottom: '20px',
                        background: 'var(--software-surface, #fff)',
                      }}
                    >
                      <h3 style={{ margin: '0 0 12px', fontSize: '1.1rem' }}>
                        Ready to Issue Assessment
                      </h3>
                      <p
                        style={{
                          margin: '0 0 12px',
                          fontSize: '0.88rem',
                          color: 'var(--software-muted)',
                        }}
                      >
                        You are about to issue a candidate session backed by
                        immutable validated version{' '}
                        {validatedVersion.versionNumber}.
                      </p>
                      <dl
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '160px 1fr',
                          gap: '6px',
                          fontSize: '0.85rem',
                          margin: 0,
                        }}
                      >
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Assessment Title
                        </dt>
                        <dd>
                          <strong>{validatedVersion.scenarioTitle}</strong>
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Validated Version
                        </dt>
                        <dd>Version {validatedVersion.versionNumber}</dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Content Digest
                        </dt>
                        <dd style={{ fontFamily: 'monospace' }}>
                          {formatDigestBadge(validatedVersion.contentDigest)}
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Time Limit
                        </dt>
                        <dd>
                          {Math.round(validatedVersion.durationSeconds / 60)}{' '}
                          minutes
                        </dd>
                        <dt style={{ color: 'var(--software-muted)' }}>
                          Idempotency Key
                        </dt>
                        <dd>
                          <code>{idempotencyKey}</code>
                        </dd>
                      </dl>
                    </div>

                    {issuanceError && (
                      <div
                        className="assessment-feedback assessment-feedback-error"
                        role="alert"
                        style={{ marginBottom: '16px' }}
                      >
                        <span>{issuanceError}</span>
                      </div>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingTop: '16px',
                        borderTop: '1px solid var(--software-border, #e5e7eb)',
                      }}
                    >
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => setStage('validate')}
                      >
                        ← Back to Validate
                      </button>

                      <button
                        type="button"
                        data-testid="issue-assessment-button"
                        className="button button-primary"
                        disabled={isIssuing}
                        onClick={handleIssue}
                      >
                        {isIssuing ? 'Issuing session...' : 'Issue assessment'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Issued Session Success State */}
                {issuedSession && (
                  <div
                    data-testid="issuance-success"
                    style={{
                      padding: '24px',
                      borderRadius: 'var(--software-radius-surface, 8px)',
                      border: '1px solid #10b981',
                      background: '#ecfdf5',
                    }}
                  >
                    <h3
                      style={{
                        margin: '0 0 12px',
                        color: '#064e3b',
                        fontSize: '1.25rem',
                      }}
                    >
                      Assessment Successfully Issued!
                    </h3>
                    <p
                      style={{
                        margin: '0 0 16px',
                        color: '#065f46',
                        fontSize: '0.9rem',
                      }}
                    >
                      The candidate session has been created and bound to
                      immutable validated version{' '}
                      {validatedVersion?.versionNumber}.
                    </p>

                    <div
                      style={{
                        background: '#fff',
                        padding: '16px',
                        borderRadius: '6px',
                        border: '1px solid #a7f3d0',
                        marginBottom: '20px',
                      }}
                    >
                      <dl
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '140px 1fr',
                          gap: '8px',
                          fontSize: '0.9rem',
                          margin: 0,
                        }}
                      >
                        <dt style={{ fontWeight: 600 }}>Session Reference:</dt>
                        <dd>
                          <code data-testid="issued-session-id">
                            {issuedSession.sessionId}
                          </code>
                        </dd>
                        <dt style={{ fontWeight: 600 }}>Candidate Link:</dt>
                        <dd>
                          <Link
                            href={issuedSession.candidatePath}
                            data-testid="candidate-workspace-link"
                            style={{
                              color: '#047857',
                              fontWeight: 600,
                              wordBreak: 'break-all',
                            }}
                          >
                            {issuedSession.candidatePath}
                          </Link>
                        </dd>
                      </dl>
                    </div>

                    <div style={{ display: 'flex', gap: '12px' }}>
                      <Link
                        href={`/r23/organizations/${encodeURIComponent(organizationId)}/sessions/${encodeURIComponent(issuedSession.sessionId)}`}
                        className="button button-secondary"
                        data-testid="inspect-session-link"
                      >
                        Inspect Session in Organization
                      </Link>
                      <Link
                        href={`/r23/organizations/${encodeURIComponent(organizationId)}`}
                        className="button button-secondary"
                      >
                        Back to Session List
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
