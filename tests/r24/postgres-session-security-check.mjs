import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { applyMigrations } from '../../database/postgres/migrate.mjs';
import {
  FIXTURE_IDS,
  applyR23DisposableSchema,
  listOrganizationSessions,
  getOrganizationSessionSummary,
  revokeReviewerAssignment,
  restoreReviewerAssignment,
  revokeOrganizationMembership,
  restoreOrganizationMembership,
} from '../../database/postgres/r23/adapter.mjs';

const POSTGRES_IMAGE =
  'postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';

export async function seedR24SessionFixtures(admin) {
  // Organizations
  await admin.query(
    `INSERT INTO hirearchy.organizations (id)
     VALUES ($1), ($2)
     ON CONFLICT DO NOTHING`,
    [FIXTURE_IDS.orgA, FIXTURE_IDS.orgB],
  );

  // Principals
  const principals = [
    [FIXTURE_IDS.userA.principalId, FIXTURE_IDS.userA.subjectId],
    [FIXTURE_IDS.userB.principalId, FIXTURE_IDS.userB.subjectId],
    [FIXTURE_IDS.userAB.principalId, FIXTURE_IDS.userAB.subjectId],
    [FIXTURE_IDS.userRevoked.principalId, FIXTURE_IDS.userRevoked.subjectId],
    [FIXTURE_IDS.recruiterA2.principalId, FIXTURE_IDS.recruiterA2.subjectId],
    [
      FIXTURE_IDS.recruiterAEmpty.principalId,
      FIXTURE_IDS.recruiterAEmpty.subjectId,
    ],
    [FIXTURE_IDS.adminA.principalId, FIXTURE_IDS.adminA.subjectId],
    [FIXTURE_IDS.recruiterB.principalId, FIXTURE_IDS.recruiterB.subjectId],
  ];

  for (const [principalId, subjectId] of principals) {
    await admin.query(
      `INSERT INTO hirearchy.application_principals (id, auth_user_id)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id`,
      [principalId, subjectId],
    );
  }

  // Memberships
  const memberships = [
    // Org A
    [
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userA.principalId,
      'recruiter',
      'active',
      null,
    ],
    [
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userAB.principalId,
      'reviewer',
      'active',
      null,
    ],
    [
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userRevoked.principalId,
      'reviewer',
      'revoked',
      '2026-10-24T08:00:00Z',
    ],
    [
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.recruiterA2.principalId,
      'recruiter',
      'active',
      null,
    ],
    [
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.recruiterAEmpty.principalId,
      'recruiter',
      'active',
      null,
    ],
    [FIXTURE_IDS.orgA, FIXTURE_IDS.adminA.principalId, 'admin', 'active', null],
    // Org B
    [
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.userB.principalId,
      'reviewer',
      'active',
      null,
    ],
    [FIXTURE_IDS.orgB, FIXTURE_IDS.userAB.principalId, 'admin', 'active', null],
    [
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.recruiterB.principalId,
      'recruiter',
      'active',
      null,
    ],
  ];

  for (const [orgId, principalId, role, status, revokedAt] of memberships) {
    await admin.query(
      `INSERT INTO hirearchy.organization_memberships
         (organization_id, principal_id, role, status, joined_at, revoked_at, version)
       VALUES ($1, $2, $3, $4, '2026-10-24T08:00:00Z', $5, 1)
       ON CONFLICT (organization_id, principal_id)
       DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status, revoked_at = EXCLUDED.revoked_at`,
      [orgId, principalId, role, status, revokedAt],
    );
  }

  // Assessment Sessions
  const sessions = [
    // In Org A issued by userA:
    [
      FIXTURE_IDS.sessions.a001Created,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userA.principalId,
      'scenario-002-booking-notification-retry',
      '1.0.0',
      'Booking notification retry',
      'CREATED',
      '2026-10-24T09:00:00Z',
      null,
      null,
      2700,
      null,
      null,
    ],
    [
      FIXTURE_IDS.sessions.a002Active,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userA.principalId,
      'scenario-001-idempotent-payment-webhook',
      '1.0.0',
      'Idempotent payment webhook',
      'ACTIVE',
      '2026-10-24T10:00:00Z',
      '2026-10-24T10:05:00Z',
      null,
      2700,
      null,
      null,
    ],
    [
      FIXTURE_IDS.sessions.a003SubmittedAssigned,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userA.principalId,
      'scenario-002-booking-notification-retry',
      '1.0.0',
      'Booking notification retry',
      'SUBMITTED',
      '2026-10-24T11:00:00Z',
      '2026-10-24T11:05:00Z',
      '2026-10-24T11:42:00Z',
      2700,
      'candidate_submission',
      'not_started',
    ],
    [
      FIXTURE_IDS.sessions.a004TimeoutAssigned,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userA.principalId,
      'scenario-003-stale-read-cache-invalidation',
      '1.0.0',
      'Stale read cache invalidation',
      'SUBMITTED',
      '2026-10-24T12:00:00Z',
      '2026-10-24T12:05:00Z',
      '2026-10-24T12:50:00Z',
      2700,
      'timeout',
      'waiting_for_response',
    ],
    [
      FIXTURE_IDS.sessions.a005SubmittedUnassigned,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.userA.principalId,
      'scenario-004-order-ledger-reconciliation',
      '1.0.0',
      'Order ledger reconciliation',
      'SUBMITTED',
      '2026-10-24T13:00:00Z',
      '2026-10-24T13:05:00Z',
      '2026-10-24T13:40:00Z',
      2700,
      'candidate_submission',
      'next_step_recorded',
    ],
    // In Org A issued by recruiterA2:
    [
      FIXTURE_IDS.sessions.a006OtherRecruiter,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.recruiterA2.principalId,
      'scenario-002-booking-notification-retry',
      '1.0.0',
      'Booking notification retry (Peer Recruiter)',
      'SUBMITTED',
      '2026-10-24T14:00:00Z',
      '2026-10-24T14:05:00Z',
      '2026-10-24T14:38:00Z',
      1800,
      'candidate_submission',
      'not_started',
    ],
    // In Org B issued by recruiterB:
    [
      FIXTURE_IDS.sessions.b001Created,
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.recruiterB.principalId,
      'scenario-002-booking-notification-retry',
      '1.0.0',
      'Beta queue retry assessment',
      'CREATED',
      '2026-10-24T09:30:00Z',
      null,
      null,
      2700,
      null,
      null,
    ],
    [
      FIXTURE_IDS.sessions.b002Active,
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.recruiterB.principalId,
      'scenario-001-idempotent-payment-webhook',
      '1.0.0',
      'Beta webhook idempotency',
      'ACTIVE',
      '2026-10-24T10:30:00Z',
      '2026-10-24T10:35:00Z',
      null,
      2700,
      null,
      null,
    ],
    [
      FIXTURE_IDS.sessions.b003SubmittedAssigned,
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.recruiterB.principalId,
      'scenario-003-stale-read-cache-invalidation',
      '1.0.0',
      'Beta cache invalidation review',
      'SUBMITTED',
      '2026-10-24T11:30:00Z',
      '2026-10-24T11:35:00Z',
      '2026-10-24T12:15:00Z',
      2700,
      'candidate_submission',
      'next_step_recorded',
    ],
    [
      FIXTURE_IDS.sessions.b004SubmittedUnassigned,
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.recruiterB.principalId,
      'scenario-004-order-ledger-reconciliation',
      '1.0.0',
      'Beta ledger reconciliation',
      'SUBMITTED',
      '2026-10-24T12:30:00Z',
      '2026-10-24T12:35:00Z',
      '2026-10-24T13:20:00Z',
      2700,
      'timeout',
      'waiting_for_response',
    ],
  ];

  for (const s of sessions) {
    await admin.query(
      `INSERT INTO hirearchy.assessment_sessions
         (id, organization_id, issuer_principal_id, scenario_id, scenario_version, scenario_title,
          status, created_at, activated_at, submitted_at, duration_seconds, closure_reason, review_process_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         scenario_id = EXCLUDED.scenario_id,
         scenario_version = EXCLUDED.scenario_version,
         scenario_title = EXCLUDED.scenario_title,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         activated_at = EXCLUDED.activated_at,
         submitted_at = EXCLUDED.submitted_at,
         duration_seconds = EXCLUDED.duration_seconds,
         closure_reason = EXCLUDED.closure_reason,
         review_process_status = EXCLUDED.review_process_status`,
      s,
    );
  }

  // Reviewer Assignments
  const assignments = [
    // Org A assignments to userAB by userA
    [
      FIXTURE_IDS.assignments.a001,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.sessions.a002Active,
      FIXTURE_IDS.userAB.principalId,
      FIXTURE_IDS.userA.principalId,
      '2026-10-24T10:10:00Z',
      null,
    ],
    [
      FIXTURE_IDS.assignments.a002,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.sessions.a003SubmittedAssigned,
      FIXTURE_IDS.userAB.principalId,
      FIXTURE_IDS.userA.principalId,
      '2026-10-24T11:10:00Z',
      null,
    ],
    [
      FIXTURE_IDS.assignments.a003,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.sessions.a004TimeoutAssigned,
      FIXTURE_IDS.userAB.principalId,
      FIXTURE_IDS.userA.principalId,
      '2026-10-24T12:10:00Z',
      null,
    ],
    [
      FIXTURE_IDS.assignments.a004Revoked,
      FIXTURE_IDS.orgA,
      FIXTURE_IDS.sessions.a005SubmittedUnassigned,
      FIXTURE_IDS.userAB.principalId,
      FIXTURE_IDS.userA.principalId,
      '2026-10-24T13:45:00Z',
      '2026-10-24T13:55:00Z',
    ],
    // Org B assignments to userB by recruiterB
    [
      FIXTURE_IDS.assignments.b001,
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.sessions.b002Active,
      FIXTURE_IDS.userB.principalId,
      FIXTURE_IDS.recruiterB.principalId,
      '2026-10-24T10:40:00Z',
      null,
    ],
    [
      FIXTURE_IDS.assignments.b002,
      FIXTURE_IDS.orgB,
      FIXTURE_IDS.sessions.b003SubmittedAssigned,
      FIXTURE_IDS.userB.principalId,
      FIXTURE_IDS.recruiterB.principalId,
      '2026-10-24T11:40:00Z',
      null,
    ],
  ];

  for (const a of assignments) {
    await admin.query(
      `INSERT INTO hirearchy.reviewer_assignments
         (id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id, assigned_at, revoked_at, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (id) DO UPDATE SET
         revoked_at = EXCLUDED.revoked_at,
         assigned_at = EXCLUDED.assigned_at`,
      a,
    );
  }
}

export async function runR24PostgresSessionSecurityChecks({
  admin,
  evaluatorPool,
  candidatePool,
  workerPool,
}) {
  // 1. Schema & RLS verification
  const { rows: tableSecurity } = await admin.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'hirearchy'
        AND c.relname = ANY(ARRAY['assessment_sessions', 'reviewer_assignments'])
      ORDER BY relname`,
  );
  assert.equal(tableSecurity.length, 2);
  for (const table of tableSecurity) {
    assert.equal(
      table.relrowsecurity,
      true,
      `${table.relname} must have RLS enabled`,
    );
    assert.equal(
      table.relforcerowsecurity,
      true,
      `${table.relname} must have RLS forced`,
    );
  }

  // Direct table access from runtime pools without grants must fail with 42501
  for (const [poolName, pool] of [
    ['app_evaluator', evaluatorPool],
    ['app_candidate_gateway', candidatePool],
    ['app_control_worker', workerPool],
  ]) {
    if (!pool) continue;
    await assert.rejects(
      pool.query('SELECT * FROM hirearchy.assessment_sessions'),
      (err) => err.code === '42501',
      `${poolName} direct SELECT on assessment_sessions must fail with 42501`,
    );
    await assert.rejects(
      pool.query('SELECT * FROM hirearchy.reviewer_assignments'),
      (err) => err.code === '42501',
      `${poolName} direct SELECT on reviewer_assignments must fail with 42501`,
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO hirearchy.assessment_sessions (id, organization_id, issuer_principal_id) VALUES ('x', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111')",
      ),
      (err) => err.code === '42501',
      `${poolName} direct INSERT on assessment_sessions must fail with 42501`,
    );
    await assert.rejects(
      pool.query("UPDATE hirearchy.assessment_sessions SET status = 'ACTIVE'"),
      (err) => err.code === '42501',
      `${poolName} direct UPDATE on assessment_sessions must fail with 42501`,
    );
    await assert.rejects(
      pool.query('DELETE FROM hirearchy.assessment_sessions'),
      (err) => err.code === '42501',
      `${poolName} direct DELETE on assessment_sessions must fail with 42501`,
    );
  }

  // Composite foreign key checks
  await assert.rejects(
    admin.query(
      `INSERT INTO hirearchy.reviewer_assignments
         (id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id)
       VALUES ('invalid-fk-cross-org', $1, $2, $3, $4)`,
      [
        FIXTURE_IDS.orgA,
        FIXTURE_IDS.sessions.b002Active, // Belongs to Org B!
        FIXTURE_IDS.userAB.principalId,
        FIXTURE_IDS.userA.principalId,
      ],
    ),
    (err) => err.code === '23503',
    'Cross-org session reference in reviewer_assignments must violate composite foreign key (23503)',
  );

  await assert.rejects(
    admin.query(
      `INSERT INTO hirearchy.reviewer_assignments
         (id, organization_id, session_id, reviewer_principal_id, assigned_by_principal_id)
       VALUES ('invalid-fk-cross-member', $1, $2, $3, $4)`,
      [
        FIXTURE_IDS.orgA,
        FIXTURE_IDS.sessions.a002Active,
        FIXTURE_IDS.userB.principalId, // Member of Org B, not Org A!
        FIXTURE_IDS.userA.principalId,
      ],
    ),
    (err) => err.code === '23503',
    'Cross-org reviewer membership in reviewer_assignments must violate composite foreign key (23503)',
  );

  // Lifecycle check constraints
  await assert.rejects(
    admin.query(
      `INSERT INTO hirearchy.assessment_sessions
         (id, organization_id, issuer_principal_id, status, submitted_at, closure_reason)
       VALUES ('invalid-created-submitted', $1, $2, 'CREATED', now(), 'candidate_submission')`,
      [FIXTURE_IDS.orgA, FIXTURE_IDS.userA.principalId],
    ),
    (err) => err.code === '23514',
    'CREATED session with submitted_at/closure_reason must violate lifecycle CHECK constraint (23514)',
  );

  await assert.rejects(
    admin.query(
      `INSERT INTO hirearchy.assessment_sessions
         (id, organization_id, issuer_principal_id, status, activated_at, submitted_at, closure_reason)
       VALUES ('invalid-submitted-null-reason', $1, $2, 'SUBMITTED', now(), now(), NULL)`,
      [FIXTURE_IDS.orgA, FIXTURE_IDS.userA.principalId],
    ),
    (err) => err.code === '23514',
    'SUBMITTED session with NULL closure_reason must violate lifecycle CHECK constraint (23514)',
  );

  await assert.rejects(
    admin.query(
      `INSERT INTO hirearchy.assessment_sessions
         (id, organization_id, issuer_principal_id, status, duration_seconds)
       VALUES ('invalid-negative-duration', $1, $2, 'CREATED', -10)`,
      [FIXTURE_IDS.orgA, FIXTURE_IDS.userA.principalId],
    ),
    (err) => err.code === '23514',
    'Negative duration_seconds must violate CHECK constraint (23514)',
  );

  // Lifecycle transition guard (trigger)
  await assert.rejects(
    admin.query(
      `UPDATE hirearchy.assessment_sessions
          SET status = 'CREATED'
        WHERE id = $1`,
      [FIXTURE_IDS.sessions.a002Active],
    ),
    (err) => err.code === '23514',
    'Status regression from ACTIVE to CREATED must be rejected by lifecycle guard (23514)',
  );

  await assert.rejects(
    admin.query(
      `UPDATE hirearchy.assessment_sessions
          SET status = 'ACTIVE'
        WHERE id = $1`,
      [FIXTURE_IDS.sessions.a003SubmittedAssigned],
    ),
    (err) => err.code === '23514',
    'Status regression from SUBMITTED to ACTIVE must be rejected by lifecycle guard (23514)',
  );

  await assert.rejects(
    admin.query(
      `UPDATE hirearchy.assessment_sessions
          SET activated_at = '2026-10-24T10:00:00Z'
        WHERE id = $1`,
      [FIXTURE_IDS.sessions.a002Active],
    ),
    (err) => err.code === '23514',
    'Modifying activated_at once set must be rejected (23514)',
  );

  // Immutability triggers
  await assert.rejects(
    admin.query(
      `UPDATE hirearchy.assessment_sessions
          SET organization_id = $1
        WHERE id = $2`,
      [FIXTURE_IDS.orgB, FIXTURE_IDS.sessions.a001Created],
    ),
    (err) => err.code === '23514',
    'Changing organization_id on assessment_sessions must be rejected by immutability trigger',
  );

  await assert.rejects(
    admin.query(
      `UPDATE hirearchy.assessment_sessions
          SET scenario_id = 'new-scenario'
        WHERE id = $1`,
      [FIXTURE_IDS.sessions.a001Created],
    ),
    (err) => err.code === '23514',
    'Changing scenario_id on assessment_sessions must be rejected by immutability trigger',
  );

  await assert.rejects(
    admin.query(
      `UPDATE hirearchy.reviewer_assignments
          SET session_id = 'other-session'
        WHERE id = $1`,
      [FIXTURE_IDS.assignments.a001],
    ),
    (err) => err.code === '23514',
    'Changing session_id on reviewer_assignments must be rejected by immutability trigger',
  );

  // 2. Tenant & Role Isolation Matrix
  // Recruiter A in Org A
  const recruiterARes = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(recruiterARes.authorized, true);
  assert.equal(recruiterARes.visibilityScope, 'issued_by_recruiter');
  assert.equal(recruiterARes.totalAuthorizedCount, 5);
  assert.equal(recruiterARes.sessions.length, 5);
  const recruiterASessionIds = recruiterARes.sessions.map((s) => s.sessionId);
  assert.ok(recruiterASessionIds.includes(FIXTURE_IDS.sessions.a001Created));
  assert.ok(recruiterASessionIds.includes(FIXTURE_IDS.sessions.a002Active));
  assert.ok(
    recruiterASessionIds.includes(FIXTURE_IDS.sessions.a003SubmittedAssigned),
  );
  assert.ok(
    recruiterASessionIds.includes(FIXTURE_IDS.sessions.a004TimeoutAssigned),
  );
  assert.ok(
    recruiterASessionIds.includes(FIXTURE_IDS.sessions.a005SubmittedUnassigned),
  );
  assert.equal(
    recruiterASessionIds.includes(FIXTURE_IDS.sessions.a006OtherRecruiter),
    false,
  );
  assert.equal(
    recruiterASessionIds.some((id) => id.startsWith('sess-b-')),
    false,
  );

  // Peer Recruiter A2 in Org A
  const recruiterA2Res = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.recruiterA2.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(recruiterA2Res.authorized, true);
  assert.equal(recruiterA2Res.totalAuthorizedCount, 1);
  assert.deepEqual(
    recruiterA2Res.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.a006OtherRecruiter],
  );

  // Empty Recruiter in Org A
  const recruiterEmptyRes = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.recruiterAEmpty.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(recruiterEmptyRes.authorized, true);
  assert.equal(recruiterEmptyRes.totalAuthorizedCount, 0);
  assert.deepEqual(recruiterEmptyRes.sessions, []);

  // Reviewer AB in Org A
  const reviewerABRes = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userAB.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(reviewerABRes.authorized, true);
  assert.equal(reviewerABRes.visibilityScope, 'assigned_to_reviewer');
  assert.equal(reviewerABRes.totalAuthorizedCount, 2);
  const reviewerABSessionIds = reviewerABRes.sessions.map((s) => s.sessionId);
  assert.deepEqual(reviewerABSessionIds, [
    FIXTURE_IDS.sessions.a004TimeoutAssigned,
    FIXTURE_IDS.sessions.a003SubmittedAssigned,
  ]);
  assert.equal(
    reviewerABSessionIds.includes(FIXTURE_IDS.sessions.a001Created),
    false,
  );
  assert.equal(
    reviewerABSessionIds.includes(FIXTURE_IDS.sessions.a002Active),
    false,
  );
  assert.equal(
    reviewerABSessionIds.includes(FIXTURE_IDS.sessions.a005SubmittedUnassigned),
    false,
  );
  assert.equal(
    reviewerABSessionIds.includes(FIXTURE_IDS.sessions.a006OtherRecruiter),
    false,
  );

  // User AB in Org B (where role is admin)
  const userABOrgBRes = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userAB.subjectId,
    organizationId: FIXTURE_IDS.orgB,
  });
  assert.equal(userABOrgBRes.authorized, true);
  assert.equal(userABOrgBRes.membership.role, 'admin');
  assert.equal(userABOrgBRes.visibilityScope, 'restricted_role');
  assert.equal(userABOrgBRes.totalAuthorizedCount, 0);
  assert.deepEqual(userABOrgBRes.sessions, []);

  // Admin A in Org A
  const adminARes = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.adminA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(adminARes.authorized, true);
  assert.equal(adminARes.membership.role, 'admin');
  assert.equal(adminARes.visibilityScope, 'restricted_role');
  assert.equal(adminARes.totalAuthorizedCount, 0);
  assert.deepEqual(adminARes.sessions, []);

  const adminLookup = await getOrganizationSessionSummary(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.adminA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    sessionId: FIXTURE_IDS.sessions.a003SubmittedAssigned,
  });
  assert.equal(adminLookup.authorized, true);
  assert.equal(
    adminLookup.session,
    null,
    'Admin session lookup must return null under fail-closed RLS',
  );

  // Reviewer B in Org B
  const reviewerBRes = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userB.subjectId,
    organizationId: FIXTURE_IDS.orgB,
  });
  assert.equal(reviewerBRes.authorized, true);
  assert.equal(reviewerBRes.visibilityScope, 'assigned_to_reviewer');
  assert.equal(reviewerBRes.totalAuthorizedCount, 1);
  assert.deepEqual(
    reviewerBRes.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.b003SubmittedAssigned],
  );

  // Reviewer B cannot access Org A
  const reviewerBCrossOrg = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userB.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(reviewerBCrossOrg.authorized, false);

  // Direct Session Lookup Isolation
  const userACrossRecruiter = await getOrganizationSessionSummary(
    evaluatorPool,
    {
      supabaseUserId: FIXTURE_IDS.userA.subjectId,
      organizationId: FIXTURE_IDS.orgA,
      sessionId: FIXTURE_IDS.sessions.a006OtherRecruiter,
    },
  );
  assert.equal(userACrossRecruiter.authorized, true);
  assert.equal(
    userACrossRecruiter.session,
    null,
    'Recruiter cannot look up sessions issued by another recruiter',
  );

  const userACrossOrg = await getOrganizationSessionSummary(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    sessionId: FIXTURE_IDS.sessions.b003SubmittedAssigned,
  });
  assert.equal(userACrossOrg.authorized, true);
  assert.equal(
    userACrossOrg.session,
    null,
    'Cannot look up cross-tenant session',
  );

  const userABUnassigned = await getOrganizationSessionSummary(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userAB.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    sessionId: FIXTURE_IDS.sessions.a005SubmittedUnassigned,
  });
  assert.equal(userABUnassigned.authorized, true);
  assert.equal(
    userABUnassigned.session,
    null,
    'Reviewer cannot look up unassigned/revoked session',
  );

  const userABActive = await getOrganizationSessionSummary(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userAB.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    sessionId: FIXTURE_IDS.sessions.a002Active,
  });
  assert.equal(userABActive.authorized, true);
  assert.equal(
    userABActive.session,
    null,
    'Reviewer cannot look up pre-submission ACTIVE session',
  );

  // Keyset Pagination: userA in Org A (5 items: sess-a-005, 004, 003, 002, 001)
  const page1 = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    limit: 2,
  });
  assert.equal(page1.sessions.length, 2);
  assert.deepEqual(
    page1.sessions.map((s) => s.sessionId),
    [
      FIXTURE_IDS.sessions.a005SubmittedUnassigned,
      FIXTURE_IDS.sessions.a004TimeoutAssigned,
    ],
  );
  assert.ok(page1.nextCursor);

  const page2 = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    limit: 2,
    cursor: page1.nextCursor,
  });
  assert.equal(page2.sessions.length, 2);
  assert.deepEqual(
    page2.sessions.map((s) => s.sessionId),
    [
      FIXTURE_IDS.sessions.a003SubmittedAssigned,
      FIXTURE_IDS.sessions.a002Active,
    ],
  );
  assert.ok(page2.nextCursor);

  const page3 = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    limit: 2,
    cursor: page2.nextCursor,
  });
  assert.equal(page3.sessions.length, 1);
  assert.deepEqual(
    page3.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.a001Created],
  );
  assert.equal(page3.nextCursor, null);

  // Lifecycle Filters
  const submittedFilter = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    lifecycleFilter: 'SUBMITTED',
  });
  assert.equal(submittedFilter.filteredAuthorizedCount, 3);
  assert.deepEqual(
    submittedFilter.sessions.map((s) => s.sessionId),
    [
      FIXTURE_IDS.sessions.a005SubmittedUnassigned,
      FIXTURE_IDS.sessions.a004TimeoutAssigned,
      FIXTURE_IDS.sessions.a003SubmittedAssigned,
    ],
  );

  const timeoutFilter = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    lifecycleFilter: 'timed_out',
  });
  assert.equal(timeoutFilter.filteredAuthorizedCount, 1);
  assert.deepEqual(
    timeoutFilter.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.a004TimeoutAssigned],
  );

  // Review Status Filter
  const reviewFilter = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    reviewStatusFilter: 'waiting_for_response',
  });
  assert.equal(reviewFilter.filteredAuthorizedCount, 1);
  assert.deepEqual(
    reviewFilter.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.a004TimeoutAssigned],
  );

  // Search Filter
  const searchFilter = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
    search: 'cache',
  });
  assert.equal(searchFilter.filteredAuthorizedCount, 1);
  assert.deepEqual(
    searchFilter.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.a004TimeoutAssigned],
  );

  // Live Assignment Revocation & Restoration
  const revOk = await revokeReviewerAssignment(admin, {
    organizationId: FIXTURE_IDS.orgA,
    sessionId: FIXTURE_IDS.sessions.a004TimeoutAssigned,
    reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
  });
  assert.equal(revOk, true);

  const reviewerAfterRevoke = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userAB.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(reviewerAfterRevoke.totalAuthorizedCount, 1);
  assert.deepEqual(
    reviewerAfterRevoke.sessions.map((s) => s.sessionId),
    [FIXTURE_IDS.sessions.a003SubmittedAssigned],
  );

  const reviewerLookupRevoked = await getOrganizationSessionSummary(
    evaluatorPool,
    {
      supabaseUserId: FIXTURE_IDS.userAB.subjectId,
      organizationId: FIXTURE_IDS.orgA,
      sessionId: FIXTURE_IDS.sessions.a004TimeoutAssigned,
    },
  );
  assert.equal(reviewerLookupRevoked.session, null);

  const restoreOk = await restoreReviewerAssignment(admin, {
    organizationId: FIXTURE_IDS.orgA,
    sessionId: FIXTURE_IDS.sessions.a004TimeoutAssigned,
    reviewerPrincipalId: FIXTURE_IDS.userAB.principalId,
  });
  assert.equal(restoreOk, true);

  const reviewerAfterRestore = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userAB.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(reviewerAfterRestore.totalAuthorizedCount, 2);

  // Live Membership Revocation & Restoration
  const revokeMemberOk = await revokeOrganizationMembership(admin, {
    organizationId: FIXTURE_IDS.orgA,
    principalId: FIXTURE_IDS.userA.principalId,
  });
  assert.equal(revokeMemberOk, true);

  const recruiterAfterRevoke = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(recruiterAfterRevoke.authorized, false);

  const restoreMemberOk = await restoreOrganizationMembership(admin, {
    organizationId: FIXTURE_IDS.orgA,
    principalId: FIXTURE_IDS.userA.principalId,
  });
  assert.equal(restoreMemberOk, true);

  const recruiterAfterRestore = await listOrganizationSessions(evaluatorPool, {
    supabaseUserId: FIXTURE_IDS.userA.subjectId,
    organizationId: FIXTURE_IDS.orgA,
  });
  assert.equal(recruiterAfterRestore.authorized, true);
  assert.equal(recruiterAfterRestore.totalAuthorizedCount, 5);

  // 3. No Sensitive Fields
  const allowedKeys = new Set([
    'sessionId',
    'organizationId',
    'issuerPrincipalId',
    'scenarioId',
    'scenarioVersion',
    'scenarioTitle',
    'status',
    'createdAt',
    'activatedAt',
    'submittedAt',
    'durationSeconds',
    'closureReason',
    'reviewProcessStatus',
    'visibilityScope',
  ]);

  for (const session of recruiterAfterRestore.sessions) {
    const keys = Object.keys(session);
    for (const key of keys) {
      assert.ok(
        allowedKeys.has(key),
        `Unexpected key ${key} found in session summary projection`,
      );
    }
    assert.equal(session.tokenHash, undefined);
    assert.equal(session.tokenCiphertext, undefined);
    assert.equal(session.candidatePath, undefined);
    assert.equal(session.notes, undefined);
    assert.equal(session.score, undefined);
  }
}

// Standalone runner if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const adminPassword = randomBytes(24).toString('base64url');
  const runtimePassword = randomBytes(24).toString('base64url');
  const name = `hirearchy-r24-pg-${process.pid}-${randomBytes(4).toString('hex')}`;

  function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new Error(
        `${command} failed: ${result.stderr || result.error?.message || ''}`,
      );
    }
    return String(result.stdout ?? '').trim();
  }

  let admin;
  let evaluatorPool;
  let candidatePool;
  let workerPool;
  let migrator;

  try {
    run('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_PASSWORD=${adminPassword}`,
      POSTGRES_IMAGE,
    ]);

    const portMatch = /^127\.0\.0\.1:(\d+)$/.exec(
      run('docker', ['port', name, '5432/tcp']),
    );
    if (!portMatch) throw new Error('PostgreSQL container port mapping failed');
    const port = Number(portMatch[1]);

    const connection = {
      host: '127.0.0.1',
      port,
      database: 'postgres',
    };

    // Wait for PG readiness
    let ready = false;
    for (let i = 0; i < 50; i++) {
      const probe = new Client({
        ...connection,
        user: 'postgres',
        password: adminPassword,
      });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
        await probe.end();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error('Database failed to start in time');

    admin = new Client({
      ...connection,
      user: 'postgres',
      password: adminPassword,
    });
    await admin.connect();

    // Bootstrap roles
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const bootstrapSql = readFileSync(
      join(root, 'database/postgres/bootstrap-roles.sql'),
      'utf8',
    );
    await admin.query(bootstrapSql);
    await admin.query(`
      ALTER ROLE hirearchy_migrator PASSWORD '${adminPassword}';
      ALTER ROLE app_evaluator PASSWORD '${runtimePassword}';
      ALTER ROLE app_candidate_gateway PASSWORD '${runtimePassword}';
      ALTER ROLE app_control_worker PASSWORD '${runtimePassword}';
      CREATE ROLE r23_gateway LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    `);

    // Run core migrations (0001, 0002)
    migrator = new Client({
      ...connection,
      user: 'hirearchy_migrator',
      password: adminPassword,
    });
    await migrator.connect();
    await applyMigrations(migrator);
    await migrator.end();
    migrator = undefined;

    // Apply R2.3 / R2.4 fixture schema
    await applyR23DisposableSchema(admin);

    // Seed R2.4 fixtures
    await seedR24SessionFixtures(admin);

    evaluatorPool = new Pool({
      ...connection,
      user: 'r23_gateway',
      password: runtimePassword,
      max: 5,
    });

    candidatePool = new Pool({
      ...connection,
      user: 'app_candidate_gateway',
      password: runtimePassword,
      max: 2,
    });

    workerPool = new Pool({
      ...connection,
      user: 'app_control_worker',
      password: runtimePassword,
      max: 2,
    });

    await runR24PostgresSessionSecurityChecks({
      admin,
      evaluatorPool,
      candidatePool,
      workerPool,
    });

    console.log(
      'PASS R2.4 PostgreSQL session security and tenant isolation checks',
    );
  } finally {
    await evaluatorPool?.end().catch(() => {});
    await candidatePool?.end().catch(() => {});
    await workerPool?.end().catch(() => {});
    await migrator?.end().catch(() => {});
    await admin?.end().catch(() => {});
    try {
      run('docker', ['stop', '--time', '5', name]);
    } catch {}
  }
}
