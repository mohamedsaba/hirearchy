'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCircle,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';

import type { WorkspaceRoleKind } from '../../../src/hiring/types';
import type { PlanTier } from '../../../src/plans/entitlements';
import {
  readPersistedJson,
  writePersistedJson,
} from '../../../src/ui/browser-state';

export const ORG_ACTIVATION_STORAGE_PREFIX = 'hirearchy:org-activation:v1:';

export interface OrgActivationLocalState {
  readonly sampleVisited?: boolean;
  readonly previewVisited?: boolean;
  readonly collapsed?: boolean;
  readonly dismissed?: boolean;
}

export function orgActivationStorageKey(organizationId: string): string {
  return `${ORG_ACTIVATION_STORAGE_PREFIX}${organizationId.toLowerCase()}`;
}

export function readOrgActivationState(
  organizationId: string,
): OrgActivationLocalState {
  const saved = readPersistedJson<OrgActivationLocalState>(
    orgActivationStorageKey(organizationId),
    'durable',
  );
  return saved && typeof saved === 'object' ? saved : {};
}

export function markOrgActivationFlag(
  organizationId: string,
  flag: 'sampleVisited' | 'previewVisited',
): OrgActivationLocalState {
  const current = readOrgActivationState(organizationId);
  const next: OrgActivationLocalState = { ...current, [flag]: true };
  writePersistedJson(orgActivationStorageKey(organizationId), next, 'durable');
  return next;
}

export interface OrgActivationChecklistProps {
  readonly organizationId: string;
  readonly planTier: PlanTier;
  readonly currentRole: WorkspaceRoleKind;
  readonly candidatesCount: number;
  readonly decisionsCount: number;
  readonly savedProblemsCount?: number;
}

export interface ActivationStepStatus {
  readonly id: 'sample' | 'preview' | 'problem' | 'invite' | 'verdict';
  readonly title: string;
  readonly description: string;
  readonly completed: boolean;
  readonly ctaLabel: string;
  readonly href: string;
  readonly gatedByPlan?: boolean;
}

export function computeActivationSteps({
  organizationId,
  planTier,
  candidatesCount,
  decisionsCount,
  savedProblemsCount,
  localState,
}: {
  organizationId: string;
  planTier: PlanTier;
  candidatesCount: number;
  decisionsCount: number;
  savedProblemsCount: number;
  localState: OrgActivationLocalState;
}): readonly ActivationStepStatus[] {
  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;
  return [
    {
      id: 'sample',
      title: 'Explore sample candidate',
      description:
        'Inspect a pre-seeded evaluation timeline, code diff, and human verdict with zero credits used.',
      completed: Boolean(localState.sampleVisited || decisionsCount > 0),
      ctaLabel: 'Explore sample candidate',
      href: `${orgBase}/sample-review`,
    },
    {
      id: 'preview',
      title: 'Preview as Candidate',
      description:
        'Experience the proctor-free coding workspace and pre-start consent view firsthand.',
      completed: Boolean(localState.previewVisited),
      ctaLabel: 'Preview as Candidate',
      href: `${orgBase}/builder/candidate-preview`,
    },
    {
      id: 'problem',
      title: 'Save or customize first problem',
      description:
        'Pick a calibrated role template or author a bounded repo task for your team.',
      completed: savedProblemsCount > 0 || candidatesCount > 0,
      ctaLabel: 'Customize problem',
      href: `${orgBase}/builder?mode=new`,
    },
    {
      id: 'invite',
      title: 'Invite first candidate',
      description:
        planTier === 'none'
          ? 'Activate a plan when ready to send your first live assessment invitation.'
          : 'Send a respectful, time-boxed assessment link that starts only on Start.',
      completed: candidatesCount > 0,
      ctaLabel:
        planTier === 'none' ? 'Choose plan to invite' : 'Invite candidate',
      href:
        planTier === 'none'
          ? `${orgBase}/upgrade`
          : `${orgBase}/builder?mode=new&stage=invite`,
      gatedByPlan: planTier === 'none',
    },
    {
      id: 'verdict',
      title: 'Publish human verdict',
      description:
        'Review evidence chronologically and publish a team-owned Advance or Hold decision.',
      completed: decisionsCount > 0,
      ctaLabel: 'Review submissions',
      href: `${orgBase}/candidates?status=ready_for_review`,
    },
  ];
}

export function OrgActivationChecklist({
  organizationId,
  planTier,
  currentRole,
  candidatesCount,
  decisionsCount,
  savedProblemsCount,
}: OrgActivationChecklistProps) {
  const [localState, setLocalState] = useState<OrgActivationLocalState>({});
  const [fetchedProblemsCount, setFetchedProblemsCount] = useState<number>(0);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setLocalState(readOrgActivationState(organizationId));
      }
    });
    return () => {
      active = false;
    };
  }, [organizationId]);

  useEffect(() => {
    if (typeof savedProblemsCount === 'number' || typeof fetch !== 'function') {
      return;
    }
    let active = true;
    fetch(
      `/r23/api/organizations/${encodeURIComponent(organizationId)}/hiring/health`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { problems?: unknown[] } | null) => {
        if (active && Array.isArray(data?.problems)) {
          setFetchedProblemsCount(data.problems.length);
        }
      })
      .catch(() => {
        // Non-blocking enrichment; pipeline counts still drive steps cleanly.
      });
    return () => {
      active = false;
    };
  }, [organizationId, savedProblemsCount]);

  if (localState.dismissed) {
    return null;
  }

  const resolvedProblemsCount = savedProblemsCount ?? fetchedProblemsCount;
  const steps = computeActivationSteps({
    organizationId,
    planTier,
    candidatesCount,
    decisionsCount,
    savedProblemsCount: resolvedProblemsCount,
    localState,
  });

  const completedCount = steps.filter((step) => step.completed).length;
  const collapsed = Boolean(localState.collapsed);

  const updateLocal = (patch: Partial<OrgActivationLocalState>) => {
    setLocalState((prev) => {
      const next = { ...prev, ...patch };
      writePersistedJson(
        orgActivationStorageKey(organizationId),
        next,
        'durable',
      );
      return next;
    });
  };

  return (
    <section
      className="hiring-card org-activation-checklist"
      aria-labelledby="org-activation-checklist-title"
      data-testid="org-activation-checklist"
    >
      <div className="org-checklist-header">
        <div className="org-checklist-heading">
          <span className="hiring-eyebrow">
            <IconSparkles size={13} aria-hidden="true" /> First 5 minutes
          </span>
          <div className="org-checklist-title-row">
            <h2 id="org-activation-checklist-title">
              Workspace activation checklist
            </h2>
            <span
              className={`hiring-pill ${completedCount === steps.length ? 'hiring-pill-success' : 'hiring-pill-plum'}`}
              data-testid="org-checklist-progress-pill"
            >
              {completedCount}/{steps.length} complete
            </span>
          </div>
          {!collapsed ? (
            <p className="hiring-muted-copy">
              Preview the candidate and evaluator experience before sending your
              first live invite.
              {planTier === 'none' && currentRole !== 'cto'
                ? ' Ask your workspace owner or CTO to activate a plan when ready to invite.'
                : ''}
            </p>
          ) : null}
        </div>
        <div className="org-checklist-controls">
          <button
            type="button"
            className="hiring-btn hiring-btn-sm"
            aria-expanded={!collapsed}
            onClick={() => updateLocal({ collapsed: !collapsed })}
          >
            {collapsed ? (
              <>
                <IconChevronDown size={15} aria-hidden="true" /> Expand
              </>
            ) : (
              <>
                <IconChevronUp size={15} aria-hidden="true" /> Collapse
              </>
            )}
          </button>
          <button
            type="button"
            className="hiring-btn hiring-btn-sm"
            aria-label="Dismiss activation checklist"
            onClick={() => updateLocal({ dismissed: true })}
          >
            <IconX size={15} aria-hidden="true" /> Dismiss
          </button>
        </div>
      </div>

      {!collapsed ? (
        <>
          <progress
            className="org-checklist-progress"
            value={completedCount}
            max={steps.length}
            aria-label={`${completedCount} of ${steps.length} activation steps complete`}
          />
          <ol className="org-checklist-steps">
            {steps.map((step) => {
              const stepAction = (
                <Link
                  className={`hiring-btn hiring-btn-sm${!step.completed ? ' hiring-btn-primary' : ''}`}
                  href={step.href}
                  onClick={() => {
                    if (step.id === 'sample') {
                      updateLocal({ sampleVisited: true });
                    } else if (step.id === 'preview') {
                      updateLocal({ previewVisited: true });
                    }
                  }}
                >
                  {step.ctaLabel}
                </Link>
              );

              return (
                <li
                  key={step.id}
                  className={`org-checklist-step${step.completed ? ' is-done' : ''}`}
                  data-step-id={step.id}
                  data-completed={step.completed ? 'true' : 'false'}
                >
                  <span className="org-checklist-icon" aria-hidden="true">
                    {step.completed ? (
                      <IconCheck size={16} />
                    ) : (
                      <IconCircle size={16} />
                    )}
                  </span>
                  <div className="org-checklist-body">
                    <div className="org-checklist-step-head">
                      <strong>{step.title}</strong>
                      {step.completed ? (
                        <span className="hiring-pill hiring-pill-success">
                          Done
                        </span>
                      ) : step.gatedByPlan ? (
                        <span className="hiring-pill hiring-pill-warning">
                          Plan needed
                        </span>
                      ) : null}
                    </div>
                    <p className="hiring-muted-copy">{step.description}</p>
                  </div>
                  <div className="org-checklist-cta">
                    {step.gatedByPlan ? (
                      <a className="hiring-btn hiring-btn-sm" href={step.href}>
                        {step.ctaLabel}
                      </a>
                    ) : (
                      stepAction
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
    </section>
  );
}
