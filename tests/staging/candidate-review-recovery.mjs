import { createHash } from 'node:crypto';

const sessionTables = [
  ['assessment_sessions', 'id'],
  ['assessment_issuances', 'session_id'],
  ['reviewer_assignments', 'session_id'],
  ['candidate_token_envelopes', 'session_id'],
  ['candidate_invitation_requests', 'session_id'],
  ['candidate_data_consents', 'session_id'],
  ['candidate_workspace_files', 'session_id'],
  ['candidate_session_events', 'session_id'],
  ['candidate_session_operations', 'session_id'],
  ['candidate_session_submissions', 'session_id'],
  ['candidate_file_revisions', 'session_id'],
  ['evaluator_observations', 'session_id'],
  ['evaluator_observation_history', 'session_id'],
  ['evaluator_review_packets', 'session_id'],
  ['evaluator_review_packet_history', 'session_id'],
];

export async function candidateReviewRecoveryHash(
  admin,
  organizationId,
  sessionId,
) {
  const { rows } = await admin.query(
    `SELECT
       EXISTS (SELECT 1 FROM hirearchy.assessment_sessions
                WHERE organization_id=$1::pg_catalog.uuid AND id=$2 AND status='SUBMITTED') AS submitted_session,
       EXISTS (SELECT 1 FROM hirearchy.candidate_data_consents
                WHERE organization_id=$1::pg_catalog.uuid AND session_id=$2) AS consent,
       EXISTS (SELECT 1 FROM hirearchy.candidate_file_revisions
                WHERE organization_id=$1::pg_catalog.uuid AND session_id=$2) AS saved_revisions,
       EXISTS (SELECT 1 FROM hirearchy.candidate_session_submissions
                WHERE organization_id=$1::pg_catalog.uuid AND session_id=$2 AND closure_reason='candidate_submission') AS submission,
       EXISTS (SELECT 1 FROM hirearchy.candidate_token_envelopes
                WHERE organization_id=$1::pg_catalog.uuid AND session_id=$2 AND expires_at IS NOT NULL AND revoked_at IS NOT NULL) AS revoked_invitation,
       EXISTS (SELECT 1 FROM hirearchy.evaluator_review_packets
                WHERE organization_id=$1::pg_catalog.uuid AND session_id=$2 AND status='FINALIZED' AND finalized_at IS NOT NULL AND final_digest IS NOT NULL) AS finalized_packet,
       EXISTS (SELECT 1 FROM hirearchy.evaluator_review_packet_history AS prior
               JOIN hirearchy.evaluator_review_packets AS packet
                 ON packet.id = prior.packet_id
                WHERE prior.organization_id=$1::pg_catalog.uuid
                  AND prior.session_id=$2
                  AND packet.status='FINALIZED'
                  AND prior.status='DRAFT'
                  AND prior.version=packet.version - 1
                  AND prior.finalized_at IS NULL
                  AND prior.final_digest IS NULL) AS prior_draft_history`,
    [organizationId, sessionId],
  );
  const state = rows[0];
  for (const field of [
    'submitted_session',
    'consent',
    'saved_revisions',
    'submission',
    'revoked_invitation',
    'finalized_packet',
    'prior_draft_history',
  ]) {
    if (!state[field]) {
      throw new Error(
        `Candidate review recovery precondition failed: ${field}`,
      );
    }
  }

  const hash = createHash('sha256');
  for (const [table, sessionColumn] of sessionTables) {
    const { rows: tableRows } = await admin.query(
      `SELECT pg_catalog.to_jsonb(session_row)::pg_catalog.text AS row_json
         FROM hirearchy.${table} AS session_row
        WHERE session_row.organization_id=$1::pg_catalog.uuid
          AND session_row.${sessionColumn}=$2
        ORDER BY pg_catalog.to_jsonb(session_row)::pg_catalog.text`,
      [organizationId, sessionId],
    );
    hash.update(table, 'utf8').update('\0');
    for (const row of tableRows) hash.update(row.row_json, 'utf8').update('\0');
  }
  return hash.digest('hex');
}

export function candidateReviewApiHash(evidence, review) {
  return createHash('sha256')
    .update(JSON.stringify({ evidence, review }), 'utf8')
    .digest('hex');
}
