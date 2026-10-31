import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

// Administrator-only; repeated provisioning never reactivates a revoked member.
export async function provisionStaging(client, authUrl, adminToken, input) {
  assert.match(
    input.organizationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  assert(Array.isArray(input.users) && input.users.length > 0);
  const users = [];
  for (const user of input.users) {
    assert(['recruiter', 'reviewer'].includes(user.role));
    assert(typeof user.email === 'string' && user.email.includes('@'));
    const existing = await client.query(
      'SELECT id FROM auth.users WHERE lower(email)=lower($1)',
      [user.email],
    );
    assert(existing.rows.length <= 1);
    let subjectId = existing.rows[0]?.id;
    if (!subjectId) {
      assert(typeof user.password === 'string' && user.password.length >= 12);
      const response = await fetch(new URL('/admin/users', authUrl), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          password: user.password,
          email_confirm: true,
        }),
      });
      if (!response.ok) throw new Error('GoTrue user provisioning failed');
      subjectId = (await response.json()).id;
      assert.match(
        subjectId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
    users.push({ subjectId, role: user.role });
  }
  await client.query('BEGIN');
  try {
    await client.query(
      'INSERT INTO hirearchy.organizations(id) VALUES($1) ON CONFLICT DO NOTHING',
      [input.organizationId],
    );
    for (const user of users) {
      await client.query(
        'INSERT INTO hirearchy.application_principals(id,auth_user_id) VALUES($1,$1) ON CONFLICT DO NOTHING',
        [user.subjectId],
      );
      const principal = await client.query(
        'SELECT id FROM hirearchy.application_principals WHERE auth_user_id=$1',
        [user.subjectId],
      );
      assert.equal(principal.rows.length, 1);
      user.principalId = principal.rows[0].id;
      await client.query(
        `INSERT INTO hirearchy.organization_memberships(organization_id,principal_id,role,status,joined_at,version) VALUES($1,$2,$3,'active',now(),1) ON CONFLICT DO NOTHING`,
        [input.organizationId, user.principalId, user.role],
      );
      const membership = await client.query(
        'SELECT role,status,revoked_at FROM hirearchy.organization_memberships WHERE organization_id=$1 AND principal_id=$2',
        [input.organizationId, user.principalId],
      );
      assert.deepEqual(
        membership.rows[0],
        { role: user.role, status: 'active', revoked_at: null },
        'Existing membership requires explicit administrator review',
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return { organizationId: input.organizationId, users };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const client = new Client({
    connectionString: process.env.STAGING_ADMIN_DATABASE_URL,
  });
  try {
    assert(
      process.env.STAGING_ADMIN_DATABASE_URL &&
        process.env.STAGING_AUTH_URL &&
        process.env.STAGING_AUTH_ADMIN_TOKEN &&
        process.argv[2],
    );
    const url = new URL(process.env.STAGING_AUTH_URL);
    assert(!url.username && !url.password && !url.search && !url.hash);
    assert(
      url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['127.0.0.1', '[::1]'].includes(url.hostname)),
    );
    const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
    await client.connect();
    console.log(
      JSON.stringify(
        await provisionStaging(
          client,
          url,
          process.env.STAGING_AUTH_ADMIN_TOKEN,
          input,
        ),
      ),
    );
  } catch {
    console.error(
      'Staging provisioning failed; inspect private administrator state. Revoked members are not reactivated.',
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
