import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { checkBrowserAcceptance } from './browser.mjs';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const statusPath = join(rootDir, '.data', 'local-staging', 'status.json');
const status = JSON.parse(await readFile(statusPath, 'utf8'));

console.log('Connecting to live PostgreSQL at port:', status.postgresPort);
const admin = new Client({
  host: '127.0.0.1',
  port: status.postgresPort,
  user: 'postgres',
  password: 'staging-local-password-123',
  database: 'postgres',
});
await admin.connect();

const users = [
  {
    email: status.users.recruiter.email,
    password: status.users.recruiter.password,
    role: status.users.recruiter.role,
  },
  {
    email: status.users.assignedReviewer.email,
    password: status.users.assignedReviewer.password,
    role: status.users.assignedReviewer.role,
  },
  {
    email: status.users.unassignedReviewer.email,
    password: status.users.unassignedReviewer.password,
    role: status.users.unassignedReviewer.role,
  },
];

const provisioned = {
  organizationId: status.organizationId,
  users: [
    {
      subjectId: status.users.recruiter.principalId,
      principalId: status.users.recruiter.principalId,
      role: 'recruiter',
      email: status.users.recruiter.email,
    },
    {
      subjectId: status.users.assignedReviewer.principalId,
      principalId: status.users.assignedReviewer.principalId,
      role: 'reviewer',
      email: status.users.assignedReviewer.email,
    },
    {
      subjectId: status.users.unassignedReviewer.principalId,
      principalId: status.users.unassignedReviewer.principalId,
      role: 'reviewer',
      email: status.users.unassignedReviewer.email,
    },
  ],
};

console.log(
  '\nRunning complete 8-phase browser acceptance verification on live local staging instance...\n',
);

await checkBrowserAcceptance({
  appUrl: status.appUrl,
  users,
  organizationId: status.organizationId,
  provisioned,
  stopApp: async () => {}, // Persistent instance stays running
  startApp: async () => status.appUrl,
  admin,
  source: { admin },
  authUrl: status.authUrl,
  submittedSessionId: status.sessions.submittedSessionId,
});

await admin.end();

console.log('\n======================================================');
console.log('LIVE BROWSER CLICK PATH VERIFICATION COMPLETED (PASS)');
console.log('======================================================\n');
