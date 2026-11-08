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
    assert.equal(contactResponse.status, 503);
    assert.match((await contactResponse.json()).error, /has not been sent/i);

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
