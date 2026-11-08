'use client';

import { useState, useRef, useSyncExternalStore, type FormEvent } from 'react';
import Link from 'next/link';
import { Arrow } from './site';

interface SubmissionSuccess {
  submissionId: string;
  receivedAt: string;
  company: string;
  message: string;
}

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function EarlyAccessForm() {
  const [state, setState] = useState<
    'idle' | 'submitting' | 'error' | 'success'
  >('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [successData, setSuccessData] = useState<SubmissionSuccess | null>(
    null,
  );
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    getClientSnapshot,
    getServerSnapshot,
  );
  const statusRef = useRef<HTMLDivElement>(null);

  const teamSizes = [
    { value: '1-10', label: '1–10 engineers' },
    { value: '11-50', label: '11–50 engineers' },
    { value: '51-200', label: '51–200 engineers' },
    { value: '201+', label: '201+ engineers' },
  ];

  const primaryChallenges = [
    {
      value: 'leetcode_fatigue',
      label: 'LeetCode fatigue & senior candidate drop-off',
    },
    {
      value: 'ai_authenticity_uncertainty',
      label: 'Uncertainty around AI-generated code vs. competence',
    },
    {
      value: 'evaluator_time_cost',
      label: 'Senior engineer time lost to screening & take-home grading',
    },
    {
      value: 'unrealistic_assessments',
      label: 'Disconnect between assessment tasks and real codebase work',
    },
    {
      value: 'other',
      label: 'Other technical evaluation challenge',
    },
  ];

  function validate(formData: FormData): Record<string, string> {
    const errors: Record<string, string> = {};
    const name = String(formData.get('name') || '').trim();
    const email = String(formData.get('email') || '').trim();
    const company = String(formData.get('company') || '').trim();
    const role = String(formData.get('role') || '').trim();
    const teamSize = String(formData.get('teamSize') || '').trim();
    const primaryChallenge = String(
      formData.get('primaryChallenge') || '',
    ).trim();

    if (!name) errors.name = 'Please enter your name.';
    if (!email) {
      errors.email = 'Please enter your work email.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Please enter a valid email address.';
    }
    if (!company) errors.company = 'Please enter your company or team name.';
    if (!role) errors.role = 'Please enter your title or role.';
    if (!teamSize)
      errors.teamSize = 'Please select your engineering team size.';
    if (!primaryChallenge)
      errors.primaryChallenge =
        'Please choose your primary evaluation challenge.';

    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === 'submitting') return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    const errors = validate(formData);

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      const firstInvalidKey = Object.keys(errors)[0];
      const targetElement = form.querySelector(
        `[name="${firstInvalidKey}"]`,
      ) as HTMLElement;
      targetElement?.focus();
      return;
    }

    setFieldErrors({});
    setState('submitting');
    setErrorMessage('');

    const payload = {
      name: String(formData.get('name') || '').trim(),
      email: String(formData.get('email') || '').trim(),
      company: String(formData.get('company') || '').trim(),
      role: String(formData.get('role') || '').trim(),
      teamSize: String(formData.get('teamSize') || '').trim(),
      primaryChallenge: String(formData.get('primaryChallenge') || '').trim(),
      notes: String(formData.get('notes') || '').trim() || undefined,
    };

    try {
      const response = await fetch('/api/early-access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || 'Failed to record your request. Please try again.',
        );
      }

      setSuccessData({
        submissionId: result.submissionId,
        receivedAt: result.receivedAt,
        company: result.company,
        message: result.message,
      });
      setState('success');
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch (err) {
      setErrorMessage(
        err instanceof Error && err.name !== 'TimeoutError'
          ? err.message
          : 'Could not record request due to a network timeout. Please try again.',
      );
      setState('error');
      requestAnimationFrame(() => statusRef.current?.focus());
    }
  }

  return (
    <div className="ct-contact-form" data-testid="early-access-form-container">
      {state === 'success' && successData ? (
        <div
          ref={statusRef}
          tabIndex={-1}
          className="ct-form-success"
          role="status"
          data-testid="early-access-success-panel"
        >
          <h2>
            Early access request
            <br />
            recorded.
          </h2>
          <p className="ct-success-lead">
            Thank you for requesting early access for{' '}
            <strong>{successData.company}</strong>.
          </p>
          <div
            className="ct-success-receipt"
            data-testid="early-access-receipt"
          >
            <p>
              <span className="ct-receipt-label">Submission ID:</span>{' '}
              <code data-testid="receipt-submission-id">
                {successData.submissionId}
              </code>
            </p>
            <p>
              <span className="ct-receipt-label">Timestamp:</span>{' '}
              <span>{new Date(successData.receivedAt).toUTCString()}</span>
            </p>
            <p className="ct-receipt-notice" data-testid="receipt-smtp-notice">
              <strong>Delivery notice:</strong> No email was sent. An authorized
              operator can review your request on the application host;
              automated follow-up is not configured.
            </p>
          </div>
          <div className="ct-success-actions">
            <Link
              className="ct-button"
              href="/products/software"
              prefetch={false}
            >
              Explore Hirearchy Software <Arrow />
            </Link>
            <button
              type="button"
              className="ct-button ct-button--light"
              onClick={() => {
                setState('idle');
                setFieldErrors({});
                setSuccessData(null);
              }}
            >
              Submit another request
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          noValidate
          method="POST"
          action="/api/early-access"
          data-hydrated={hydrated ? 'true' : 'false'}
          aria-label="Request Early Access or Pilot"
          data-testid="early-access-form"
        >
          <p className="ct-form-stage" aria-hidden="true">
            <span />
            Early access interest
          </p>
          <h2>Request early access</h2>
          <p className="ct-form-intro">
            Share your team context to request an early-access conversation.
            Submitting this form does not create an account, activate a pilot,
            or guarantee product access.
          </p>

          <label
            className="ct-field"
            htmlFor="ea-name"
            data-number="01"
            data-invalid={Boolean(fieldErrors.name)}
          >
            <span className="ct-field-title">Name</span>
            <input
              id="ea-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              maxLength={120}
              placeholder="Your full name"
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? 'error-ea-name' : undefined}
            />
            <span className="ct-field-underline" aria-hidden="true" />
            {fieldErrors.name && (
              <span className="ct-field-error" id="error-ea-name">
                {fieldErrors.name}
              </span>
            )}
          </label>

          <label
            className="ct-field"
            htmlFor="ea-email"
            data-number="02"
            data-invalid={Boolean(fieldErrors.email)}
          >
            <span className="ct-field-title">Work Email</span>
            <input
              id="ea-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              placeholder="you@company.com"
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={
                fieldErrors.email ? 'error-ea-email' : undefined
              }
            />
            <span className="ct-field-underline" aria-hidden="true" />
            {fieldErrors.email && (
              <span className="ct-field-error" id="error-ea-email">
                {fieldErrors.email}
              </span>
            )}
          </label>

          <label
            className="ct-field"
            htmlFor="ea-company"
            data-number="03"
            data-invalid={Boolean(fieldErrors.company)}
          >
            <span className="ct-field-title">Company / Team</span>
            <input
              id="ea-company"
              name="company"
              type="text"
              autoComplete="organization"
              required
              maxLength={160}
              placeholder="Where you do your engineering work"
              aria-invalid={Boolean(fieldErrors.company)}
              aria-describedby={
                fieldErrors.company ? 'error-ea-company' : undefined
              }
            />
            <span className="ct-field-underline" aria-hidden="true" />
            {fieldErrors.company && (
              <span className="ct-field-error" id="error-ea-company">
                {fieldErrors.company}
              </span>
            )}
          </label>

          <label
            className="ct-field"
            htmlFor="ea-role"
            data-number="04"
            data-invalid={Boolean(fieldErrors.role)}
          >
            <span className="ct-field-title">Role / Title</span>
            <input
              id="ea-role"
              name="role"
              type="text"
              required
              maxLength={120}
              placeholder="e.g. VP Engineering, Staff Engineer, Hiring Manager"
              aria-invalid={Boolean(fieldErrors.role)}
              aria-describedby={fieldErrors.role ? 'error-ea-role' : undefined}
            />
            <span className="ct-field-underline" aria-hidden="true" />
            {fieldErrors.role && (
              <span className="ct-field-error" id="error-ea-role">
                {fieldErrors.role}
              </span>
            )}
          </label>

          <fieldset
            className="ct-topic-field"
            data-invalid={Boolean(fieldErrors.teamSize)}
            aria-describedby={
              fieldErrors.teamSize ? 'error-ea-teamSize' : undefined
            }
          >
            <legend>
              05 <span>Engineering team size</span>
            </legend>
            <div className="ct-topic-options">
              {teamSizes.map((item) => (
                <label className="ct-topic-choice" key={item.value}>
                  <input
                    type="radio"
                    name="teamSize"
                    value={item.value}
                    required
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
            {fieldErrors.teamSize && (
              <p className="ct-field-error" id="error-ea-teamSize">
                {fieldErrors.teamSize}
              </p>
            )}
          </fieldset>

          <fieldset
            className="ct-topic-field"
            data-invalid={Boolean(fieldErrors.primaryChallenge)}
            aria-describedby={
              fieldErrors.primaryChallenge
                ? 'error-ea-primaryChallenge'
                : undefined
            }
          >
            <legend>
              06 <span>Primary evaluation challenge</span>
            </legend>
            <div className="ct-topic-options ct-topic-options--vertical">
              {primaryChallenges.map((item) => (
                <label className="ct-topic-choice" key={item.value}>
                  <input
                    type="radio"
                    name="primaryChallenge"
                    value={item.value}
                    required
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
            {fieldErrors.primaryChallenge && (
              <p className="ct-field-error" id="error-ea-primaryChallenge">
                {fieldErrors.primaryChallenge}
              </p>
            )}
          </fieldset>

          <label
            className="ct-field ct-field--message"
            htmlFor="ea-notes"
            data-number="07"
          >
            <span className="ct-field-title">
              Hiring context or upcoming roles <span>(optional)</span>
            </span>
            <textarea
              id="ea-notes"
              name="notes"
              maxLength={2000}
              rows={3}
              placeholder="Tell us what roles you are hiring for or specific pain points in your current technical interview loop..."
            />
            <span className="ct-field-underline" aria-hidden="true" />
          </label>

          <div
            className="ct-form-notice"
            data-testid="staging-restrictions-notice"
          >
            <p>
              <strong>Request information:</strong> We store your name, work
              email, company or team, role, team size, selected challenge, and
              optional note for authorized Hirearchy operators to review. Your
              request stays on the application host until an authorized operator
              deletes it; no automatic expiry or deletion-request process is
              configured. Automated email and follow-up are not configured.
              Share only information you want reviewed. Do not include candidate
              data, credentials, or secrets. Read the{' '}
              <Link href="/privacy">privacy notice draft</Link> before
              submitting.
            </p>
            <p>
              The current internal demo uses synthetic data. Candidate code
              execution, live AI assistance, and automated email are disabled.
            </p>
          </div>

          {state === 'error' && (
            <div
              className="ct-form-error"
              role="alert"
              tabIndex={-1}
              ref={statusRef}
              data-testid="early-access-error-alert"
            >
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            className="ct-button"
            disabled={state === 'submitting'}
            data-testid="early-access-submit-button"
          >
            {state === 'submitting'
              ? 'Recording request…'
              : 'Request early access'}
            <Arrow />
          </button>
        </form>
      )}
    </div>
  );
}
