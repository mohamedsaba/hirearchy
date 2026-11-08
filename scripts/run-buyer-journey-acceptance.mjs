import { spawn } from 'node:child_process';
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
  console.log(`Starting Next.js development server on port ${PORT}...`);
  const server = spawn('npx', ['next', 'dev', 'apps/web', '-p', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'development',
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
    console.log('Buyer journey acceptance walkthrough completed successfully!');
  } catch (error) {
    console.error('Buyer journey acceptance failed:', error);
    console.error('Server output log:\n', serverOutput);
    process.exitCode = 1;
  } finally {
    console.log('Shutting down Next.js server...');
    server.kill('SIGTERM');
  }
}

main();
