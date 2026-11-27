import { NextResponse } from 'next/server';

import {
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from '../../../../../../../../../database/postgres/r211/template.mjs';
import { getPlatformTemplate } from '../../../../../../../src/hiring/templates';
import type { SavedLibraryProblem } from '../../../../../../../src/hiring/types';
import type { R211AssessmentDraftInput } from '../../../../../../../src/r211-builder/contract';
import {
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
  computeCanonicalContentDigest,
  validateAssessmentDraft,
} from '../../../../../../../src/r211-builder/validation';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../src/staging/browser';
import { recordServerTelemetryEvent } from '../../../../../../../src/telemetry/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    return await withHiringOrganizationSession(
      request,
      organizationId,
      {},
      async ({ dispatch, organizationId: orgId, plan }) => {
        const res = (await dispatch('hiring.library.list', {
          organizationId: orgId,
        })) as { problems?: SavedLibraryProblem[] };
        return NextResponse.json(
          { problems: res?.problems ?? [], plan },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    const body = await hiringParseJsonBody(request, 256 * 1024);
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ dispatch, organizationId: orgId, orgContext, plan }) => {
        const rawDraft = body.draft as R211AssessmentDraftInput | undefined;
        if (!rawDraft || typeof rawDraft !== 'object') {
          throw new StagingBadRequest();
        }
        const meta = (body.metadata ?? {}) as Record<string, unknown>;

        const isReservationMoves =
          rawDraft.templateId === 'reservation-moves-v3';
        const preparedDraft: R211AssessmentDraftInput = isReservationMoves
          ? {
              ...normalizeAssessmentTemplate(rawDraft),
              templateId: 'reservation-moves-v3',
            }
          : rawDraft;

        const validation = validateAssessmentDraft(preparedDraft);
        if (!validation.valid) {
          return NextResponse.json(
            {
              error: {
                code: 'VALIDATION_FAILED',
                message:
                  validation.issues[0]?.message ??
                  'Assessment draft failed validation.',
              },
              issues: validation.issues,
            },
            { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        const platformTpl = getPlatformTemplate(preparedDraft.templateId ?? '');
        const binding = isReservationMoves
          ? reservationMovesBinding()
          : undefined;
        const scenarioId =
          platformTpl?.scenarioId ??
          `ai-${
            preparedDraft.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 32) || 'problem'
          }`;
        const scenarioVersion = platformTpl?.scenarioVersion ?? '1.0.0';

        const scenarioSnapshot = buildScenarioSnapshotEnvelope(
          scenarioId,
          scenarioVersion,
          preparedDraft,
        );
        if (binding) Object.assign(scenarioSnapshot.scenario, binding);

        const validatedVersion = {
          contentDigest: computeCanonicalContentDigest(preparedDraft, binding),
          scenarioId,
          scenarioVersion,
          scenarioTitle: preparedDraft.title.trim(),
          scenarioSnapshot,
          taskRubricSnapshot: buildTaskRubricSnapshot(preparedDraft),
          durationSeconds: preparedDraft.durationMinutes * 60,
          terminalEnabled: preparedDraft.terminalEnabled,
          integratedAi: preparedDraft.integratedAi,
          validationReceipt: {
            validatedAt: new Date().toISOString(),
            checks: [
              'structural_schema',
              'file_boundaries',
              'rubric_weights',
              'duration_limits',
            ],
            executionValidationAvailable: false,
          },
        };

        const saved = (await dispatch('hiring.library.save', {
          organizationId: orgId,
          entry: {
            draft: preparedDraft,
            validatedVersion,
            metadata: {
              sourceKind:
                meta.sourceKind === 'template' ? 'template' : 'ai_generated',
              targetRole: String(meta.targetRole ?? '')
                .trim()
                .slice(0, 120),
              experienceLevel: ['junior', 'mid', 'senior', 'staff'].includes(
                String(meta.experienceLevel),
              )
                ? String(meta.experienceLevel)
                : 'mid',
              yearsExperience: Number(meta.yearsExperience ?? 3),
              skills: Array.isArray(meta.skills)
                ? meta.skills.slice(0, 12)
                : [],
              problemStructure:
                meta.problemStructure === 'single_module'
                  ? 'single_module'
                  : 'multi_file',
              workKind: String(meta.workKind ?? 'incident').slice(0, 64),
              domain: String(meta.domain ?? 'fintech').slice(0, 64),
              generationBrief: meta.generationBrief ?? {},
            },
          },
        })) as { definitionId: string; validatedVersionId: string };

        recordServerTelemetryEvent({
          eventName: 'builder.problem.saved',
          category: 'team_funnel',
          actorType: 'team_member',
          organizationId: orgId,
          principalId: orgContext.principalId,
          planTier: plan.planTier,
          route: '/r23/organizations/:id/builder',
          properties: {
            sourceKind:
              meta.sourceKind === 'template' ? 'template' : 'ai_generated',
            problemStructure:
              meta.problemStructure === 'single_module'
                ? 'single_module'
                : 'multi_file',
            durationMinutes: preparedDraft.durationMinutes,
            integratedAi: preparedDraft.integratedAi,
          },
        });

        return NextResponse.json(
          {
            definitionId: saved.definitionId,
            validatedVersionId: saved.validatedVersionId,
            draft: preparedDraft,
          },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
