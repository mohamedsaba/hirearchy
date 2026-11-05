import assert from 'node:assert/strict';

const content = {
  title: 'Durable notification retry assessment',
  brief:
    'Implement bounded notification retries and preserve the observable result of each delivery attempt.',
  expectedBehavior: [
    'Retry temporary failures within three delivery attempts.',
  ],
  acceptanceCriteria: ['Stop retrying after a successful delivery attempt.'],
  primaryFilePath: 'src/service.py',
  starterFiles: [
    { path: 'src/service.py', content: 'def notify():\n    pass\n' },
  ],
  durationMinutes: 60,
  terminalEnabled: true,
  integratedAi: false,
  rubric: [
    {
      id: 'correctness',
      label: 'Correctness',
      description: 'The implementation preserves the stated retry contract.',
      weight: 100,
      applicability: { kind: 'always', rule: 'Applies to all attempts' },
    },
  ],
};
export async function createJourney({
  call,
  appUrl,
  recruiter,
  reviewer,
  organizationId,
  provisioned,
}) {
  const created = await call(appUrl, recruiter, 'assessment.create', {
    organizationId,
    content,
  });
  const assessmentId = created.assessmentId;
  assert.match(assessmentId, /^[0-9a-f-]{36}$/i);
  await call(
    appUrl,
    reviewer,
    'assessment.create',
    { organizationId, content },
    403,
  );
  const args = { organizationId, assessmentId };
  await call(
    appUrl,
    recruiter,
    'assessment.issue',
    { ...args, reviewerPrincipalId: provisioned.users[1].principalId },
    403,
  );
  const validation = await call(appUrl, recruiter, 'assessment.validate', args);
  assert.equal(validation.validation.valid, true);
  assert.equal(validation.validation.executionValidationAvailable, false);
  const issued = await call(appUrl, recruiter, 'assessment.issue', {
    ...args,
    reviewerPrincipalId: provisioned.users[1].principalId,
  });
  assert(issued.sessionId);
  const state = { assessmentId, sessionId: issued.sessionId, content };
  await readJourney({
    call,
    appUrl,
    recruiter,
    reviewer,
    organizationId,
    state,
  });
  return state;
}
export async function readJourney({
  call,
  appUrl,
  recruiter,
  reviewer,
  organizationId,
  state,
}) {
  const assessment = await call(appUrl, recruiter, 'assessment.get', {
    organizationId,
    assessmentId: state.assessmentId,
  });
  assert.deepEqual(assessment.content, state.content);
  await call(
    appUrl,
    recruiter,
    'evidence.read',
    { organizationId, sessionId: state.sessionId },
    403,
  );
  const evidence = await call(appUrl, reviewer, 'evidence.read', {
    organizationId,
    sessionId: state.sessionId,
  });
  assert.equal(evidence.session.id, state.sessionId);
  assert.equal(evidence.session.organizationId, organizationId);
  assert.equal(evidence.session.status, 'CREATED');
  assert.equal(evidence.session.terminalEnabled, false);
  assert.equal(evidence.session.aiCapabilitySnapshot.enabled, false);
  for (const field of [
    'events',
    'fileRevisions',
    'submissions',
    'observations',
    'observationHistory',
  ])
    assert.deepEqual(evidence[field], []);
  assert.match(evidence.captureLimitation, /disabled|submitted/);
  assert.equal(evidence.session.status, 'CREATED');
  assert.deepEqual(evidence.events, []);
  assert.match(evidence.captureLimitation, /SUBMITTED/);
  const review = await call(appUrl, reviewer, 'review.read', {
    organizationId,
    sessionId: state.sessionId,
  });
  assert.equal(review.sessionId, state.sessionId);
  assert.deepEqual(review.packets, []);
  assert.deepEqual(review.history, []);
  assert.equal(review.status, 'CREATED');
  assert.deepEqual(review.packets, []);
  assert.match(review.availability, /SUBMITTED/);
  // Issuance captures a CREATED assessment. It never fabricates candidate work.
  assert(!JSON.stringify(evidence).includes('competenceScore'));
}
export async function revokeJourney({
  call,
  appUrl,
  recruiter,
  reviewer,
  organizationId,
  state,
  admin,
  provisioned,
}) {
  await admin.query(
    "UPDATE hirearchy.organization_memberships SET status='revoked',revoked_at=now(),version=version+1 WHERE organization_id=$1 AND principal_id=$2",
    [organizationId, provisioned.users[1].principalId],
  );
  await call(
    appUrl,
    reviewer,
    'evidence.read',
    { organizationId, sessionId: state.sessionId },
    403,
  );
  await call(appUrl, recruiter, 'session.revoke', { organizationId });
  await call(
    appUrl,
    recruiter,
    'assessment.get',
    { organizationId, assessmentId: state.assessmentId },
    401,
  );
}
