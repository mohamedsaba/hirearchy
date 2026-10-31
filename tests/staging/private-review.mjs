import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Separate synthetic data regression, after the real CREATED-session journey.
// No candidate activity or evaluator interpretation is claimed by this setup.
export async function checkPrivateReview({
  call,
  appUrl,
  recruiter,
  reviewer,
  otherReviewer,
  organizationId,
  state,
  admin,
  provisioned,
}) {
  const { assessmentId } = await call(appUrl, recruiter, 'assessment.create', {
    organizationId,
    content: state.content,
  });
  await call(appUrl, recruiter, 'assessment.validate', {
    organizationId,
    assessmentId,
  });
  const { sessionId } = await call(appUrl, recruiter, 'assessment.issue', {
    organizationId,
    assessmentId,
    reviewerPrincipalId: provisioned.users[1].principalId,
  });
  const args = { organizationId, sessionId };
  await call(appUrl, otherReviewer, 'session.open', { organizationId });
  await call(appUrl, otherReviewer, 'evidence.read', args, 403);
  await admin.query(
    'INSERT INTO hirearchy.reviewer_assignments(id,organization_id,session_id,reviewer_principal_id,assigned_by_principal_id) VALUES($1,$2,$3,$4,$5)',
    [
      randomUUID(),
      organizationId,
      sessionId,
      provisioned.users[2].principalId,
      provisioned.users[0].principalId,
    ],
  );
  for (const user of provisioned.users.slice(1)) {
    await admin.query(
      'INSERT INTO hirearchy.evaluator_review_packets(organization_id,session_id,author_principal_id,summary) VALUES($1,$2,$3,$4)',
      [
        organizationId,
        sessionId,
        user.principalId,
        `private-${user.principalId}`,
      ],
    );
  }
  assert.deepEqual(
    (await call(appUrl, reviewer, 'review.read', args)).packets,
    [],
    'Unsubmitted private data stays unavailable',
  );
  await admin.query(
    "UPDATE hirearchy.assessment_sessions SET status='SUBMITTED',activated_at=now(),submitted_at=now(),closure_reason='candidate_submission',review_process_status='not_started' WHERE id=$1",
    [sessionId],
  );
  await admin.query(
    "INSERT INTO hirearchy.candidate_session_events(organization_id,session_id,sequence,event_type,happened_at,payload) VALUES($1,$2,1,'SESSION_SUBMITTED',now(),'{\"syntheticSecurityRegression\":true}')",
    [organizationId, sessionId],
  );
  for (const user of provisioned.users.slice(1)) {
    await admin.query(
      "INSERT INTO hirearchy.evaluator_observations(organization_id,session_id,author_principal_id,evidence_source_type,event_sequence,evidence_digest,body) VALUES($1,$2,$3,'timeline_event',1,$4,$5)",
      [
        organizationId,
        sessionId,
        user.principalId,
        'a'.repeat(64),
        `private-${user.principalId}`,
      ],
    );
  }
  await admin.query(
    `INSERT INTO hirearchy.evaluator_observation_history
    (observation_id,organization_id,session_id,author_principal_id,version,body,evidence_source_type,event_sequence,file_path,file_version,evidence_digest,visibility,valid_from,valid_until)
    SELECT id,organization_id,session_id,author_principal_id,version,body,evidence_source_type,event_sequence,file_path,file_version,evidence_digest,visibility,created_at,clock_timestamp()
    FROM hirearchy.evaluator_observations WHERE session_id=$1`,
    [sessionId],
  );
  await admin.query(
    `INSERT INTO hirearchy.evaluator_review_packet_history
    (packet_id,organization_id,session_id,author_principal_id,status,version,summary,strengths,concerns,unresolved_questions,referenced_observation_ids,referenced_evidence,finalized_at,final_digest,valid_from,valid_until)
    SELECT id,organization_id,session_id,author_principal_id,status,version,summary,strengths,concerns,unresolved_questions,referenced_observation_ids,referenced_evidence,finalized_at,final_digest,created_at,clock_timestamp()
    FROM hirearchy.evaluator_review_packets WHERE session_id=$1`,
    [sessionId],
  );
  for (const [token, user] of [
    [reviewer, provisioned.users[1]],
    [otherReviewer, provisioned.users[2]],
  ]) {
    const review = await call(appUrl, token, 'review.read', args);
    assert.equal(review.packets.length, 1);
    assert.equal(review.history.length, 1);
    assert.equal(review.history[0].summary, `private-${user.principalId}`);
    assert.equal(review.packets[0].summary, `private-${user.principalId}`);
    const evidence = await call(appUrl, token, 'evidence.read', args);
    assert.equal(evidence.events.length, 1);
    assert.equal(evidence.observations.length, 1);
    assert.equal(evidence.observationHistory.length, 1);
    assert.equal(
      evidence.observationHistory[0].body,
      `private-${user.principalId}`,
    );
    assert.equal(evidence.observations[0].body, `private-${user.principalId}`);
  }
  const revokedClaims = JSON.parse(
    Buffer.from(otherReviewer.split('.')[1], 'base64url').toString(),
  );
  await admin.query('DELETE FROM auth.sessions WHERE id=$1', [
    revokedClaims.session_id,
  ]);
  await call(appUrl, otherReviewer, 'evidence.read', args, 401);
}
