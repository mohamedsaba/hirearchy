'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

import {
  HIRING_ROLES,
  NEXT_STAGE_OPTIONS,
  experienceLevelLabel,
} from '../../../../../src/hiring/catalogs';
import type { HandoffDossierItem } from '../../../../../src/hiring/types';

export interface HandoffsHubClientProps {
  readonly organizationId: string;
  readonly initialHandoffs: readonly HandoffDossierItem[];
}

function handoffPillClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'hiring-pill hiring-pill-success';
    case 'reviewed':
      return 'hiring-pill hiring-pill-plum';
    default:
      return 'hiring-pill hiring-pill-warning';
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function HandoffsHubClient({
  organizationId,
  initialHandoffs,
}: HandoffsHubClientProps) {
  const [stageFilter, setStageFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');

  const filtered = useMemo(() => {
    return initialHandoffs.filter((item) => {
      if (
        stageFilter !== 'all' &&
        (item.decision.nextStageLabel ?? '') !== stageFilter
      ) {
        return false;
      }
      if (
        statusFilter !== 'all' &&
        item.decision.handoffStatus !== statusFilter
      ) {
        return false;
      }
      if (roleFilter !== 'all' && item.targetRole !== roleFilter) {
        return false;
      }
      return true;
    });
  }, [initialHandoffs, stageFilter, statusFilter, roleFilter]);

  const orgBase = `/r23/organizations/${encodeURIComponent(organizationId)}`;

  return (
    <div className="hiring-page-shell">
      <section className="hiring-filter-bar" aria-label="Filter handoffs">
        <div className="hiring-filter-grid">
          <div className="hiring-field">
            <label htmlFor="handoff-stage">Next hiring stage</label>
            <select
              id="handoff-stage"
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
            >
              <option value="all">All stages</option>
              {NEXT_STAGE_OPTIONS.map((stage) => (
                <option key={stage} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </div>
          <div className="hiring-field">
            <label htmlFor="handoff-status">Handoff status</label>
            <select
              id="handoff-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="pending">Pending manager review</option>
              <option value="reviewed">Reviewed</option>
              <option value="completed">Interview completed</option>
            </select>
          </div>
          <div className="hiring-field">
            <label htmlFor="handoff-role">Target role</label>
            <select
              id="handoff-role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="all">All roles</option>
              {HIRING_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="hiring-card">
          <h2>No managerial handoffs yet</h2>
          <p>
            When an evaluator accepts a candidate on the Evidence Review page
            and sets a next stage, the full managerial dossier appears here.
          </p>
        </div>
      ) : (
        <div className="hiring-candidate-list">
          {filtered.map((item) => (
            <article key={item.sessionId} className="hiring-candidate-card">
              <div className="hiring-candidate-header">
                <div className="hiring-candidate-identity">
                  <span className="hiring-avatar" aria-hidden="true">
                    {getInitials(item.candidateName)}
                  </span>
                  <div>
                    <div className="hiring-candidate-name">
                      <h2>{item.candidateName}</h2>
                      <span
                        className={handoffPillClass(
                          item.decision.handoffStatus,
                        )}
                      >
                        {item.decision.handoffStatus}
                      </span>
                      <span className="hiring-pill hiring-pill-plum">
                        {item.decision.nextStageLabel ?? 'Managerial Interview'}
                      </span>
                      {item.candidateCode ? (
                        <span className="hiring-pill">
                          {item.candidateCode}
                        </span>
                      ) : null}
                      {item.secondOpinions.length > 0
                        ? (() => {
                            const approved = item.secondOpinions.filter(
                              (op) =>
                                op.status === 'completed' &&
                                op.verdict === 'approve',
                            ).length;
                            const flagged = item.secondOpinions.filter(
                              (op) =>
                                op.status === 'completed' &&
                                op.verdict === 'request_changes',
                            ).length;
                            const pillCls =
                              flagged > 0
                                ? 'hiring-pill hiring-pill-danger'
                                : approved > 0
                                  ? 'hiring-pill hiring-pill-success'
                                  : 'hiring-pill';
                            const label =
                              flagged > 0
                                ? `${flagged} peer concern${flagged === 1 ? '' : 's'}`
                                : approved > 0
                                  ? `${approved} peer approved`
                                  : `${item.secondOpinions.length} peer review${item.secondOpinions.length === 1 ? '' : 's'}`;
                            return <span className={pillCls}>{label}</span>;
                          })()
                        : null}
                    </div>
                    <div className="hiring-candidate-meta">
                      <span>{item.candidateEmail}</span>
                      <span>
                        {item.targetRole} ·{' '}
                        {experienceLevelLabel(item.experienceLevel)}
                      </span>
                      <span>Assessment: {item.scenarioTitle}</span>
                      <span>Decided by: {item.decision.decidedByName}</span>
                      <span>
                        Manager:{' '}
                        {item.decision.handoffRecipientName ?? 'Team manager'}
                      </span>
                    </div>
                    {item.decision.performanceReport ? (
                      <p className="hiring-fit-headline">
                        <strong>Fit Report:</strong>{' '}
                        {item.decision.performanceReport.fitHeadline}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="hiring-chip-group">
                  {item.skills.slice(0, 5).map((skill) => (
                    <span key={skill} className="hiring-pill">
                      {skill}
                    </span>
                  ))}
                </div>

                <div className="hiring-header-actions">
                  <Link
                    className="hiring-btn hiring-btn-primary hiring-btn-sm"
                    href={`${orgBase}/handoffs/${encodeURIComponent(item.sessionId)}`}
                  >
                    Open Handoff Dossier
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
