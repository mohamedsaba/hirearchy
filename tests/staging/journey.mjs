import assert from 'node:assert/strict';
import { normalizeAssessmentTemplate } from '../../database/postgres/r211/template.mjs';

export const content = {
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

export const reservationMovesContent = normalizeAssessmentTemplate({
  templateId: 'reservation-moves-v3',
  durationMinutes: 60,
  terminalEnabled: true,
  integratedAi: false,
});

export async function createJourney({
  call,
  appUrl,
  recruiter,
  reviewer,
  organizationId,
  provisioned,
  content: customContent = content,
}) {
  const journeyContent = customContent;
  const created = await call(appUrl, recruiter, 'assessment.create', {
    organizationId,
    content: journeyContent,
  });
  const assessmentId = created.assessmentId;
  assert.match(assessmentId, /^[0-9a-f-]{36}$/i);
  await call(
    appUrl,
    reviewer,
    'assessment.create',
    { organizationId, content: journeyContent },
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
  await call(appUrl, reviewer, 'session.open', { organizationId });
  const libraryContent = { templateId: 'custom', ...journeyContent };
  const { problem } = await call(appUrl, recruiter, 'problem.create', {
    organizationId,
    content: libraryContent,
  });
  assert.match(problem.id, /^[0-9a-f-]{36}$/i);
  assert.equal(problem.organizationId, organizationId);
  assert.equal(problem.authorPrincipalId, provisioned.users[0].principalId);
  assert.equal(problem.version, 1);
  assert.deepEqual(problem.content, libraryContent);

  const problemArgs = { organizationId, problemId: problem.id };
  const update = {
    ...problemArgs,
    expectedVersion: 1,
    content: { ...libraryContent, title: 'Updated reusable problem' },
  };
  for (const [operation, operationArgs] of [
    ['problem.create', { organizationId, content: libraryContent }],
    ['problem.list', { organizationId }],
    ['problem.get', problemArgs],
    ['problem.update', update],
    ['problem.delete', { ...problemArgs, expectedVersion: 1 }],
    ['problem.reuse', problemArgs],
  ]) {
    await call(appUrl, reviewer, operation, operationArgs, 403);
  }

  const { problems } = await call(appUrl, recruiter, 'problem.list', {
    organizationId,
  });
  assert.ok(problems.some((entry) => entry.id === problem.id));
  assert.deepEqual(await call(appUrl, recruiter, 'problem.get', problemArgs), {
    problem,
  });
  const { problem: edited } = await call(
    appUrl,
    recruiter,
    'problem.update',
    update,
  );
  assert.equal(edited.version, 2);
  assert.deepEqual(edited.content, update.content);
  await call(appUrl, recruiter, 'problem.update', update, 409);
  await call(
    appUrl,
    recruiter,
    'problem.delete',
    { ...problemArgs, expectedVersion: 1 },
    409,
  );

  const { draft } = await call(appUrl, recruiter, 'problem.reuse', problemArgs);
  assert.match(draft.definitionId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(draft.definitionId, assessmentId);
  assert.notEqual(draft.definitionId, problem.id);
  assert.equal(draft.version, 1);
  assert.equal(draft.organizationId, organizationId);
  assert.equal(draft.authorPrincipalId, provisioned.users[0].principalId);
  for (const [key, value] of Object.entries(edited.content)) {
    assert.deepEqual(draft[key], value, `copied draft field ${key}`);
  }
  const copiedArgs = { organizationId, assessmentId: draft.definitionId };
  await call(
    appUrl,
    recruiter,
    'assessment.issue',
    { ...copiedArgs, reviewerPrincipalId: provisioned.users[1].principalId },
    403,
  );
  const { problem: editedAgain } = await call(
    appUrl,
    recruiter,
    'problem.update',
    { ...update, expectedVersion: 2, content: libraryContent },
  );
  assert.equal(editedAgain.version, 3);
  assert.deepEqual(
    await call(appUrl, recruiter, 'problem.delete', {
      ...problemArgs,
      expectedVersion: 3,
    }),
    { deleted: true },
  );
  await call(appUrl, recruiter, 'problem.get', problemArgs, 404);
  await call(appUrl, recruiter, 'problem.reuse', problemArgs, 404);
  assert.deepEqual(
    await call(appUrl, recruiter, 'assessment.get', copiedArgs),
    { assessmentId: draft.definitionId, content: edited.content },
  );

  const validation = await call(appUrl, recruiter, 'assessment.validate', args);
  assert.equal(validation.validation.valid, true);
  assert.equal(validation.validation.executionValidationAvailable, false);
  const issued = await call(appUrl, recruiter, 'assessment.issue', {
    ...args,
    reviewerPrincipalId: provisioned.users[1].principalId,
  });
  assert(issued.sessionId);
  const state = {
    assessmentId,
    sessionId: issued.sessionId,
    content: journeyContent,
  };
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
  if (state.content?.templateId === 'reservation-moves-v3') {
    assert.equal(evidence.session.scenarioId, 'reservation-moves');
    assert.equal(evidence.session.scenarioVersion, 'v3');
    assert.equal(evidence.session.scenarioTitle, 'Reservation Moves');
    const snapshot = evidence.session.scenarioSnapshot;
    assert.equal(snapshot?.scenario?.templateId, 'reservation-moves-v3');
    assert.equal(snapshot?.scenario?.recipe?.id, 'reservation-moves.pytest');
    assert.ok(snapshot?.workspaceFiles?.['src/service.py'] !== undefined);
  }
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
