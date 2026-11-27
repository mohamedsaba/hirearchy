import { NextResponse } from 'next/server';

import { generateHiringAssessmentWithKimi } from '../../../../../../../../src/hiring/ai-builder';
import {
  consumeBuilderGenerationJob,
  getLatestBuilderGenerationJob,
  startBuilderGenerationJob,
} from '../../../../../../../../src/hiring/builder-generation-jobs';
import type {
  ExperienceLevelId,
  ProblemStructureId,
} from '../../../../../../../../src/hiring/catalogs';
import { hasPlanFeature } from '../../../../../../../../src/plans/entitlements';
import {
  hiringFailureJsonResponse,
  hiringParseJsonBody,
  StagingBadRequest,
  withHiringOrganizationSession,
} from '../../../../../../../../src/staging/browser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId')?.trim() || undefined;
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: false },
      async ({ orgContext }) => {
        const job = getLatestBuilderGenerationJob(
          organizationId,
          orgContext.principalId,
          jobId,
        );
        return NextResponse.json(
          { job },
          { headers: { 'Cache-Control': 'private, no-store' } },
        );
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
): Promise<Response> {
  try {
    const { organizationId } = await params;
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId')?.trim() || '';
    if (!jobId) {
      throw new StagingBadRequest();
    }
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true },
      async ({ orgContext }) => {
        const ok = consumeBuilderGenerationJob(
          organizationId,
          orgContext.principalId,
          jobId,
        );
        return NextResponse.json(
          { ok },
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
    const body = await hiringParseJsonBody(request, 16384);
    return await withHiringOrganizationSession(
      request,
      organizationId,
      { requireOriginCsrf: true, body },
      async ({ orgContext, plan }) => {
        if (!hasPlanFeature(plan.planTier, 'aiAssessmentBuilder')) {
          return NextResponse.json(
            {
              error: {
                code: 'PLAN_UPGRADE_REQUIRED',
                requiredPlan: 'per_candidate',
                currentPlan: plan.planTier,
                message:
                  'An active plan (Per Candidate, Pro, or Ultra) is required to generate assessments with AI.',
              },
            },
            { status: 402, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        const targetRole = String(body.targetRole ?? '').trim();
        if (!targetRole || targetRole.length > 120) {
          throw new StagingBadRequest();
        }
        const expLevel = String(body.experienceLevel ?? 'mid');
        if (!['junior', 'mid', 'senior', 'staff'].includes(expLevel)) {
          throw new StagingBadRequest();
        }
        const structure = String(body.problemStructure ?? 'multi_file');
        if (structure !== 'multi_file' && structure !== 'single_module') {
          throw new StagingBadRequest();
        }
        const rawDuration = Number(body.durationMinutes ?? 60);
        const durationMinutes: 30 | 45 | 60 | 90 =
          rawDuration === 30 ||
          rawDuration === 45 ||
          rawDuration === 60 ||
          rawDuration === 90
            ? rawDuration
            : 60;
        const yearsRaw = Number(body.yearsExperience ?? 3);
        const yearsExperience = Number.isFinite(yearsRaw)
          ? Math.max(0, Math.min(50, Math.trunc(yearsRaw)))
          : 3;
        const skills = Array.isArray(body.skills)
          ? body.skills
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 12)
          : [];
        const workKind =
          String(body.workKind ?? 'incident').trim() || 'incident';
        const domain = String(body.domain ?? 'fintech').trim() || 'fintech';
        const integratedAi = Boolean(body.integratedAi);
        const guidance =
          typeof body.guidance === 'string' && body.guidance.trim()
            ? body.guidance.trim().slice(0, 600)
            : undefined;
        const draftId =
          typeof body.draftId === 'string' && body.draftId.trim()
            ? body.draftId.trim().slice(0, 128)
            : undefined;

        if (body.async === true) {
          const job = startBuilderGenerationJob(
            {
              organizationId,
              principalId: orgContext.principalId,
              draftId,
              targetRole,
              experienceLevel: expLevel as ExperienceLevelId,
              yearsExperience,
              skills,
              problemStructure: structure as ProblemStructureId,
              workKind,
              domain,
              durationMinutes,
              integratedAi,
              guidance,
            },
            () =>
              generateHiringAssessmentWithKimi({
                targetRole,
                experienceLevel: expLevel as ExperienceLevelId,
                yearsExperience,
                skills,
                problemStructure: structure as ProblemStructureId,
                workKind,
                domain,
                durationMinutes,
                integratedAi,
                guidance,
              }),
          );
          return NextResponse.json(
            { job },
            { status: 202, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        try {
          const generated = await generateHiringAssessmentWithKimi({
            targetRole,
            experienceLevel: expLevel as ExperienceLevelId,
            yearsExperience,
            skills,
            problemStructure: structure as ProblemStructureId,
            workKind,
            domain,
            durationMinutes,
            integratedAi,
            guidance,
          });

          return NextResponse.json(
            {
              draft: generated.draft,
              modelId: generated.modelId,
              source: 'ai-generated',
            },
            { headers: { 'Cache-Control': 'private, no-store' } },
          );
        } catch (err) {
          const message =
            err instanceof Error
              ? err.message
              : 'Unable to generate assessment with AI.';
          return NextResponse.json(
            {
              error: {
                code: 'AI_BUILDER_UNAVAILABLE',
                message,
              },
            },
            { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }
      },
    );
  } catch (error) {
    return hiringFailureJsonResponse(request, error);
  }
}
