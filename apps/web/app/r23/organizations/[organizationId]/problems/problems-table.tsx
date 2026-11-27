'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  IconArrowRight,
  IconSparkles,
  IconTerminal2,
} from '@tabler/icons-react';

import type { R211ReusableProblem } from '../../../../../src/r211-builder/contract';
import {
  healthFlagMeta,
  type OrgProblemHealthItem,
} from '../../../_components/org-benchmarks-strip';

function inferRoleOrTemplateLabel(
  problem: R211ReusableProblem,
  health?: OrgProblemHealthItem,
): string {
  if (health?.targetRole) return health.targetRole;
  switch (problem.content.templateId) {
    case 'reservation-moves-v3':
      return 'Backend Engineer';
    case 'webhook-dedup-v1':
      return 'Backend / Integrations';
    case 'cache-rate-limiter-v1':
      return 'Systems / Backend';
    case 'ai-generated':
      return 'AI generated';
    default:
      return 'Custom problem';
  }
}

export function ProblemsTable({
  workspace,
  organizationId,
  problems,
}: {
  workspace: string;
  organizationId?: string;
  problems: R211ReusableProblem[];
}) {
  const [healthById, setHealthById] = useState<
    Record<string, OrgProblemHealthItem>
  >({});

  const resolvedOrgId =
    organizationId ??
    workspace.match(/\/r23\/organizations\/([^/?#]+)/)?.[1] ??
    '';

  useEffect(() => {
    if (
      !resolvedOrgId ||
      problems.length === 0 ||
      typeof fetch !== 'function'
    ) {
      return;
    }
    let active = true;
    fetch(
      `/r23/api/organizations/${encodeURIComponent(resolvedOrgId)}/hiring/health`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { problems?: OrgProblemHealthItem[] } | null) => {
        if (!active || !Array.isArray(payload?.problems)) return;
        const map: Record<string, OrgProblemHealthItem> = {};
        for (const item of payload.problems) {
          map[item.definitionId] = item;
          map[`title:${item.title}`] = item;
        }
        setHealthById(map);
      })
      .catch(() => {
        // Non-blocking health badge enrichment.
      });
    return () => {
      active = false;
    };
  }, [resolvedOrgId, problems.length]);

  if (!problems.length) {
    return (
      <div className="hiring-card">
        <p className="hiring-muted-copy">
          No saved problems yet. Choose <strong>Save for reuse</strong> when
          authoring an assessment to add one here.
        </p>
      </div>
    );
  }

  return (
    <div
      className="hiring-card problems-table-card"
      data-testid="problems-table-card"
    >
      <div
        className="software-overflow-region problems-table-wrap"
        tabIndex={0}
      >
        <table
          className="software-members-table problems-table"
          aria-label="Saved problems"
        >
          <thead>
            <tr>
              <th scope="col">Problem</th>
              <th scope="col">Duration</th>
              <th scope="col">Updated</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((problem) => {
              const health =
                healthById[problem.id] ??
                healthById[`title:${problem.content.title}`];
              const healthMeta = health
                ? healthFlagMeta(health.healthFlag)
                : null;
              const roleLabel = inferRoleOrTemplateLabel(problem, health);

              return (
                <tr key={problem.id} className="problems-table-row">
                  <th scope="row">
                    <div className="problems-row-primary">
                      <Link
                        className="problems-row-title-link"
                        href={
                          workspace +
                          '/problems/' +
                          encodeURIComponent(problem.id)
                        }
                      >
                        {problem.content.title}
                      </Link>
                      <div className="hiring-chip-group problems-row-badges">
                        <span className="hiring-pill hiring-pill-plum">
                          {roleLabel}
                        </span>
                        <span
                          className={`hiring-pill ${problem.content.integratedAi ? 'hiring-pill-mint' : ''}`}
                        >
                          <IconSparkles size={12} aria-hidden="true" /> AI{' '}
                          {problem.content.integratedAi ? 'on' : 'off'}
                        </span>
                        <span className="hiring-pill">
                          <IconTerminal2 size={12} aria-hidden="true" />{' '}
                          Terminal{' '}
                          {problem.content.terminalEnabled ? 'on' : 'off'}
                        </span>
                        {healthMeta ? (
                          <span className={healthMeta.pillClass}>
                            {healthMeta.label}
                          </span>
                        ) : (
                          <span className="hiring-pill">
                            v{problem.version}
                          </span>
                        )}
                      </div>
                    </div>
                  </th>
                  <td className="tabular-nums">
                    {problem.content.durationMinutes} min
                  </td>
                  <td className="tabular-nums">
                    <time dateTime={problem.updatedAt}>
                      {problem.updatedAt.slice(0, 10)}
                    </time>
                  </td>
                  <td>
                    <div className="hiring-header-actions problems-row-actions">
                      <Link
                        className="hiring-btn hiring-btn-sm"
                        href={`${workspace}/builder?definitionId=${encodeURIComponent(problem.id)}`}
                      >
                        Customize in Builder
                      </Link>
                      <Link
                        className="hiring-btn hiring-btn-primary hiring-btn-sm"
                        href={`${workspace}/builder?definitionId=${encodeURIComponent(problem.id)}&stage=invite`}
                      >
                        Issue <IconArrowRight size={13} aria-hidden="true" />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
