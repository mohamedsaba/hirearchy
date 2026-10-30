import { createHash, randomUUID } from 'node:crypto';
import { assertVerifiedIdentity } from './auth.mjs';
import { withTrustedEvaluatorTransaction } from '../../database/postgres/transaction.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MembershipLaneError extends Error {
  constructor(message = 'Membership operation denied') {
    super(message);
    this.name = 'MembershipLaneError';
    this.code = 'MEMBERSHIP_DENIED';
  }
}

function requiredUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`A valid ${label} is required`);
  }
  return value.toLowerCase();
}

function digestSecret(value, label) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096) {
    throw new TypeError(`A valid ${label} is required`);
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function confirmedEmail(identity) {
  if (
    identity.emailVerified !== true ||
    typeof identity.email !== 'string' ||
    identity.email.length > 320
  ) {
    throw new MembershipLaneError('A confirmed recipient is required');
  }
  const email = identity.email.trim().toLowerCase();
  if (email.length < 3)
    throw new MembershipLaneError('A confirmed recipient is required');
  return email;
}

function resultRow(row) {
  if (!row) throw new MembershipLaneError();
  return {
    organizationId: row.organization_id,
    principalId: row.principal_id,
    role: row.role,
    ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.acceptance_id === undefined
      ? {}
      : { acceptanceId: row.acceptance_id }),
    ...(row.accepted_at === undefined ? {} : { acceptedAt: row.accepted_at }),
    membershipVersion: row.membership_version,
  };
}

export function createMembershipLane({ pool, verify }) {
  if (
    !pool ||
    typeof pool.query !== 'function' ||
    typeof pool.connect !== 'function'
  ) {
    throw new TypeError('A restricted PostgreSQL pool is required');
  }
  if (typeof verify !== 'function')
    throw new TypeError('An Auth verifier is required');

  async function verifiedIdentity(accessToken) {
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new MembershipLaneError('Authentication required');
    }
    try {
      const identity = assertVerifiedIdentity(await verify(accessToken));
      requiredUuid(identity.subjectId, 'verified Auth subject');
      requiredUuid(identity.sessionId, 'verified Auth session');
      if (identity.assurance !== 'aal1' && identity.assurance !== 'aal2') {
        throw new TypeError('Invalid verified assurance');
      }
      return identity;
    } catch {
      throw new MembershipLaneError('Authentication required');
    }
  }

  async function bindVerifiedSubject(identity) {
    try {
      const { rows } = await pool.query(
        `WITH verified_context AS MATERIALIZED (
           SELECT pg_catalog.set_config('hirearchy.auth_subject_id', $1, true) AS subject_id,
                  pg_catalog.set_config('hirearchy.auth_session_id', $2, true) AS session_id,
                  pg_catalog.set_config('hirearchy.auth_assurance', $3, true) AS assurance
         )
         SELECT r22b.bind_principal($1::pg_catalog.uuid) AS principal_id
         FROM verified_context
         WHERE verified_context.subject_id = $1
           AND verified_context.session_id = $2
           AND verified_context.assurance = $3`,
        [identity.subjectId, identity.sessionId, identity.assurance],
      );
      return requiredUuid(rows[0]?.principal_id, 'application principal');
    } catch {
      throw new MembershipLaneError();
    }
  }

  async function withIdentityTransaction(
    identity,
    principalId,
    organizationId,
    query,
  ) {
    const context = {
      principalId,
      authSubjectId: identity.subjectId,
      authSessionId: identity.sessionId,
      assurance: identity.assurance,
      organizationId,
      correlationId: randomUUID(),
    };
    try {
      return await withTrustedEvaluatorTransaction(
        pool,
        context,
        async (client) => {
          const { rows } = await query(client);
          return resultRow(rows[0]);
        },
      );
    } catch {
      throw new MembershipLaneError();
    }
  }

  return Object.freeze({
    async bind(accessToken) {
      const identity = await verifiedIdentity(accessToken);
      return bindVerifiedSubject(identity);
    },

    async bootstrap(accessToken, { organizationId, permit } = {}) {
      const orgId = requiredUuid(organizationId, 'organization selection');
      const permitDigest = digestSecret(permit, 'bootstrap permit');
      const identity = await verifiedIdentity(accessToken);
      confirmedEmail(identity);
      const principalId = await bindVerifiedSubject(identity);
      return withIdentityTransaction(identity, principalId, orgId, (client) =>
        client.query(
          'SELECT * FROM r22b.bootstrap_organization($1::pg_catalog.text)',
          [permitDigest],
        ),
      );
    },

    async read(accessToken, organizationId) {
      const orgId = requiredUuid(organizationId, 'organization selection');
      const identity = await verifiedIdentity(accessToken);
      const principalId = await bindVerifiedSubject(identity);
      return withIdentityTransaction(identity, principalId, orgId, (client) =>
        client.query('SELECT * FROM r22b.read_membership()'),
      );
    },

    async acceptInvite(accessToken, { organizationId, inviteToken } = {}) {
      const orgId = requiredUuid(organizationId, 'organization selection');
      const inviteDigest = digestSecret(inviteToken, 'invitation token');
      const identity = await verifiedIdentity(accessToken);
      const email = confirmedEmail(identity);
      const principalId = await bindVerifiedSubject(identity);
      return withIdentityTransaction(identity, principalId, orgId, (client) =>
        client.query(
          `SELECT * FROM r22b.accept_invitation(
             $1::pg_catalog.text, $2::pg_catalog.text
           )`,
          [inviteDigest, email],
        ),
      );
    },

    async revoke(
      accessToken,
      { organizationId, principalId: targetPrincipalId } = {},
    ) {
      const orgId = requiredUuid(organizationId, 'organization selection');
      const targetId = requiredUuid(targetPrincipalId, 'membership target');
      const identity = await verifiedIdentity(accessToken);
      const principalId = await bindVerifiedSubject(identity);
      return withIdentityTransaction(identity, principalId, orgId, (client) =>
        client.query(
          'SELECT * FROM r22b.revoke_membership($1::pg_catalog.uuid)',
          [targetId],
        ),
      );
    },
  });
}
