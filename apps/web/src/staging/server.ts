import { createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';

import {
  R23AuthenticationDenied,
  verifyR23AccessToken,
} from '../r23-auth/identity';
import { issueStagingProof } from '../r23-auth/staging-proof';
import { isAuthenticatedStaging } from '../runtime/profile';
import {
  validateAssessmentDraft,
  computeCanonicalContentDigest,
  buildScenarioSnapshotEnvelope,
  buildTaskRubricSnapshot,
} from '../r211-builder/validation';
import {
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from '../../../../database/postgres/r211/template.mjs';
import type { R211AssessmentDraftInput } from '../r211-builder/contract';
import { dispatchStagingProof } from './dispatch.mjs';

const operations = new Set([
  'session.open',
  'session.revoke',
  'assessment.create',
  'assessment.get',
  'assessment.validate',
  'assessment.issue',
  'evidence.read',
  'review.read',
]);

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 16384)
    throw new Error('Staging configuration unavailable');
  return value;
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
}

function configuration() {
  const authUrl = new URL(required('STAGING_AUTH_URL'));
  const database = new URL(required('STAGING_DATABASE_URL'));
  const issuerUrl = new URL(required('STAGING_AUTH_ISSUER'));
  if (
    !['http:', 'https:'].includes(authUrl.protocol) ||
    !loopback(authUrl.hostname) ||
    !authUrl.port ||
    authUrl.pathname !== '/' ||
    authUrl.username ||
    authUrl.password ||
    authUrl.search ||
    authUrl.hash ||
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !loopback(database.hostname) ||
    !database.port ||
    database.username !== 'r23_gateway' ||
    !database.password ||
    database.pathname === '/' ||
    database.search ||
    database.hash ||
    !['http:', 'https:'].includes(issuerUrl.protocol) ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash
  )
    throw new Error('Staging configuration unavailable');
  const encoded = required('STAGING_PROOF_PRIVATE_KEY');
  const keyBytes = Buffer.from(encoded, 'base64');
  if (keyBytes.toString('base64') !== encoded)
    throw new Error('Staging configuration unavailable');
  const privateKey = createPrivateKey({
    key: keyBytes,
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('Staging configuration unavailable');
  return {
    auth: {
      authUrl,
      authIssuer: required('STAGING_AUTH_ISSUER'),
      authAudience: required('STAGING_AUTH_AUDIENCE'),
    },
    databaseUrl: database.toString(),
    proof: {
      issuer: required('STAGING_PROOF_ISSUER'),
      audience: required('STAGING_PROOF_AUDIENCE'),
      keyId: required('STAGING_PROOF_KEY_ID'),
      privateKey,
    },
  };
}

function response(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new TypeError('Invalid request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) throw new TypeError('Invalid request');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError('Invalid request');
  return parsed as Record<string, unknown>;
}

export async function stagingPost(request: Request): Promise<Response> {
  if (!isAuthenticatedStaging()) return response(503, { error: 'Unavailable' });
  let config: ReturnType<typeof configuration>;
  try {
    config = configuration();
  } catch {
    return response(503, { error: 'Unavailable' });
  }
  try {
    const auth = request.headers.get('authorization');
    const match = auth?.match(/^Bearer ([A-Za-z0-9._-]{1,16384})$/);
    if (!match) return response(401, { error: 'Authentication denied' });
    const input = await body(request);
    if (
      Object.keys(input).sort().join(',') !== 'args,op' ||
      typeof input.op !== 'string' ||
      !operations.has(input.op) ||
      !input.args ||
      typeof input.args !== 'object' ||
      Array.isArray(input.args)
    )
      return response(400, { error: 'Invalid request' });
    const identity = await verifyR23AccessToken(config.auth, match[1]);
    type ProofArgs = Parameters<typeof issueStagingProof>[3];
    const dispatch = async (op: string, args: ProofArgs) => {
      const proof = issueStagingProof(config.proof, identity, op, args);
      return dispatchStagingProof(
        config.databaseUrl,
        proof.payload,
        proof.signature,
      );
    };
    const args = input.args as ProofArgs;
    if (input.op === 'assessment.validate') {
      // The caller cannot supply the validation result or its content. Read the
      // persisted draft, then have SQL compare it under lock before recording it.
      if (
        Object.keys(args).sort().join(',') !== 'assessmentId,organizationId' ||
        typeof args.assessmentId !== 'string' ||
        typeof args.organizationId !== 'string'
      )
        return response(400, { error: 'Invalid request' });
      const draft = await dispatch('assessment.get', args);
      if (
        !draft ||
        typeof draft !== 'object' ||
        Array.isArray(draft) ||
        !('content' in draft) ||
        !draft.content ||
        typeof draft.content !== 'object' ||
        Array.isArray(draft.content)
      )
        throw new Error('Assessment unavailable');
      if (
        !('integratedAi' in draft.content) ||
        draft.content.integratedAi !== false
      ) {
        return response(422, {
          error: 'AI capability is unavailable in staging',
        });
      }
      const approved = normalizeAssessmentTemplate(
        draft.content as R211AssessmentDraftInput,
      );
      const validation = validateAssessmentDraft(approved);
      if (!validation.valid) return response(422, validation);
      const reservation = approved.templateId === 'reservation-moves-v3';
      const binding = reservation ? reservationMovesBinding() : undefined;
      const scenarioId = reservation
        ? 'reservation-moves'
        : 'authored-assessment';
      const scenarioVersion = reservation ? 'v3' : '1.0.0';
      const scenarioSnapshot = buildScenarioSnapshotEnvelope(
        scenarioId,
        scenarioVersion,
        approved,
      );
      if (binding) Object.assign(scenarioSnapshot.scenario, binding);
      const validatedVersion = {
        contentDigest: computeCanonicalContentDigest(approved, binding),
        scenarioId,
        scenarioVersion,
        scenarioTitle: approved.title.trim(),
        scenarioSnapshot,
        taskRubricSnapshot: buildTaskRubricSnapshot(approved),
        durationSeconds: approved.durationMinutes * 60,
        terminalEnabled: approved.terminalEnabled,
        integratedAi: approved.integratedAi,
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
      const result = await dispatch('assessment.validate', {
        ...args,
        content: draft.content as ProofArgs,
        validatedVersion: validatedVersion as unknown as ProofArgs,
      });
      return response(200, { validation, result });
    }
    return response(200, await dispatch(input.op, args));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === '28000')
        return response(401, { error: 'Authentication denied' });
      if (error.code === '42501' || error.code === '23505')
        return response(403, { error: 'Authorization denied' });
    }
    if (error instanceof R23AuthenticationDenied)
      return response(401, { error: 'Authentication denied' });
    if (error instanceof SyntaxError || error instanceof TypeError)
      return response(400, { error: 'Invalid request' });
    return response(503, { error: 'Unavailable' });
  }
}
