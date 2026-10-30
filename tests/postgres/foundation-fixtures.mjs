import { randomUUID } from 'node:crypto';

export function createFoundationFixtures() {
  const ids = {
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    organizationC: randomUUID(),
    principalA: randomUUID(),
    principalB: randomUUID(),
    principalShared: randomUUID(),
    principalUnused: randomUUID(),
    subjectA: randomUUID(),
    subjectB: randomUUID(),
    subjectShared: randomUUID(),
    subjectUnused: randomUUID(),
    sessionA: 'r2-foundation-session-A',
    sessionB: 'r2-foundation-session-B',
    sessionTombstone: 'r2-foundation-session-tombstone',
  };
  return {
    ids,
    contextA: {
      principalId: ids.principalA,
      authSubjectId: ids.subjectA,
      authSessionId: randomUUID(),
      assurance: 'aal2',
      organizationId: ids.organizationA,
      correlationId: randomUUID(),
    },
    contextB: {
      principalId: ids.principalB,
      authSubjectId: ids.subjectB,
      authSessionId: randomUUID(),
      assurance: 'aal1',
      organizationId: ids.organizationB,
      correlationId: randomUUID(),
    },
  };
}

export async function seedFoundationFixtures(migrator, ids) {
  await migrator.query(
    'INSERT INTO hirearchy.organizations (id) VALUES ($1), ($2), ($3)',
    [ids.organizationA, ids.organizationB, ids.organizationC],
  );
  await migrator.query(
    `INSERT INTO hirearchy.application_principals (id, auth_user_id)
     VALUES ($1, $5), ($2, $6), ($3, $7), ($4, $8)`,
    [
      ids.principalA,
      ids.principalB,
      ids.principalShared,
      ids.principalUnused,
      ids.subjectA,
      ids.subjectB,
      ids.subjectShared,
      ids.subjectUnused,
    ],
  );
  await migrator.query(
    `INSERT INTO hirearchy.organization_memberships
       (organization_id, principal_id, role, status, joined_at, revoked_at, version)
     VALUES
       ($1, $4, 'recruiter', 'active', pg_catalog.clock_timestamp(), NULL, 1),
       ($1, $6, 'reviewer', 'active', pg_catalog.clock_timestamp(), NULL, 1),
       ($2, $5, 'recruiter', 'active', pg_catalog.clock_timestamp(), NULL, 1),
       ($2, $6, 'admin', 'active', pg_catalog.clock_timestamp(), NULL, 1),
       ($3, $4, 'recruiter', 'active', pg_catalog.clock_timestamp(), NULL, 1),
       ($3, $7, 'recruiter', 'active', pg_catalog.clock_timestamp(), NULL, 1)`,
    [
      ids.organizationA,
      ids.organizationB,
      ids.organizationC,
      ids.principalA,
      ids.principalB,
      ids.principalShared,
      ids.principalUnused,
    ],
  );
  await migrator.query(
    `INSERT INTO hirearchy.assessment_sessions (id, organization_id, issuer_principal_id)
     VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
    [
      ids.sessionA,
      ids.organizationA,
      ids.principalA,
      ids.sessionB,
      ids.organizationB,
      ids.principalB,
      ids.sessionTombstone,
      ids.organizationC,
      ids.principalUnused,
    ],
  );
}
