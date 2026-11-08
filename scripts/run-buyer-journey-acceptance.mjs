import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runBuyerJourneyAcceptance } from '../tests/browser/buyer-journey-acceptance.mjs';

const PORT = 3003;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/early-access`);
      if (res.status === 200) {
        return;
      }
    } catch {
      // Server starting up
    }
    await delay(500);
  }
  throw new Error(`Server at ${url} failed to respond within ${timeoutMs}ms`);
}

async function verifyPublicPreviewBoundary() {
  const healthResponse = await fetch(`${BASE_URL}/api/health`);
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');
  assert.deepEqual(health.capabilities, {
    application: 'disabled',
    execution: 'disabled',
    ai: 'disabled',
  });

  const headResponse = await fetch(`${BASE_URL}/products/software`, {
    method: 'HEAD',
  });
  assert.equal(headResponse.status, 200);

  const deniedRoutes = [
    ['GET', '/r23/login'],
    ['POST', '/api/auth/signup'],
    ['GET', '/api/staging/readiness'],
    ['GET', '/r23/api/organizations/example/sessions'],
    ['GET', '/r26/candidate/example'],
    ['GET', '/r27/organizations/example/sessions/example'],
    ['GET', '/r27/api/organizations/example/sessions/example/evidence'],
    ['POST', '/api/candidate/sessions/example/terminal/exec'],
    ['POST', '/r26/api/candidate/example/execution'],
    ['POST', '/r26/api/candidate/example/ai'],
    ['POST', '/api/evaluator/assessments/generate'],
    ['POST', '/api/sessions'],
    ['POST', '/api/contact'],
  ];
  for (const [method, pathname] of deniedRoutes) {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }
        : {}),
    });
    assert.equal(response.status, 404, `${method} ${pathname} must be denied`);
    const body = await response.json();
    assert.equal(body.error.code, 'PREVIEW_ROUTE_UNAVAILABLE');
  }
  console.log(
    `Public-preview boundary passed: health and marketing GET/HEAD allowed; ${deniedRoutes.length} auth, product, candidate, evaluator, AI, execution, and contact routes denied.`,
  );
}

async function main() {
  const acceptanceStorage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hirearchy-buyer-acceptance-'),
  );
  const acceptanceStorageFile = path.join(
    acceptanceStorage,
    'early-access-requests.json',
  );
  console.log(`Starting Next.js development server on port ${PORT}...`);
  const server = spawn('npx', ['next', 'dev', 'apps/web', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
      HIREARCHY_RUNTIME_PROFILE: 'public-preview',
      EARLY_ACCESS_STORAGE_PATH: acceptanceStorageFile,
    },
  });

  let serverOutput = '';
  server.stdout.on('data', (d) => {
    serverOutput += d.toString();
  });
  server.stderr.on('data', (d) => {
    serverOutput += d.toString();
  });

  try {
    console.log('Waiting for Next.js server to be ready...');
    await waitForServer(BASE_URL);
    console.log(
      `Next.js server ready at ${BASE_URL}. Running buyer journey acceptance suite...`,
    );
    await verifyPublicPreviewBoundary();

    await runBuyerJourneyAcceptance({ baseUrl: BASE_URL });
    const contactResponse = await fetch(`${BASE_URL}/api/contact`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE_URL,
      },
      body: JSON.stringify({
        name: 'Synthetic Buyer',
        email: 'buyer@example.test',
        topic: 'Hirearchy Software',
        message: 'This is a local synthetic contact-route check.',
      }),
    });
    assert.equal(contactResponse.status, 404);
    assert.equal(
      (await contactResponse.json()).error.code,
      'PREVIEW_ROUTE_UNAVAILABLE',
    );

    const exported = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/export-early-access-requests.mjs',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          EARLY_ACCESS_STORAGE_PATH: acceptanceStorageFile,
        },
      },
    );
    const records = JSON.parse(exported);
    assert.equal(records.length, 1);
    assert.equal(records[0].email, 'alex.chen@acme-infrastructure.com');
    assert.equal(records[0].clientIp, undefined);
    assert.equal(records[0].userAgent, undefined);

    fs.writeFileSync(acceptanceStorageFile, '{');
    const corruptExport = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'scripts/export-early-access-requests.mjs',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          EARLY_ACCESS_STORAGE_PATH: acceptanceStorageFile,
        },
      },
    );
    assert.equal(corruptExport.status, 1);
    assert.match(corruptExport.stderr, /Unable to read early-access requests/);
    assert.equal(fs.readFileSync(acceptanceStorageFile, 'utf8'), '{');
    console.log('Buyer journey acceptance walkthrough completed successfully!');
  } catch (error) {
    console.error('Buyer journey acceptance failed:', error);
    console.error('Server output log:\n', serverOutput);
    process.exitCode = 1;
  } finally {
    console.log('Shutting down Next.js server...');
    if (server.exitCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      await stopped;
    }
    fs.rmSync(acceptanceStorage, { recursive: true, force: true });
  }
}

main();
