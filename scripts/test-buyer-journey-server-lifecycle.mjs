import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { stopBuyerJourneyServer } from './buyer-journey-server-process.mjs';

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const onExit = () => {
      child.off('exit', onExit);
      resolve();
    };
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function readReadyFile(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('Listener child did not become ready in time');
}

async function waitForPortClosed(port, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(100),
      });
    } catch {
      return true;
    }
    await delay(20);
  }
  return false;
}

async function waitForProcessGone(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    await delay(20);
  }
  return false;
}

async function main() {
  assert.notEqual(process.platform, 'win32');

  const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    detached: true,
    stdio: 'ignore',
  });
  await waitForExit(exitedChild);
  assert.equal(exitedChild.exitCode, 0);
  assert.deepEqual(await stopBuyerJourneyServer(exitedChild), {
    escalated: false,
  });

  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hirearchy-buyer-process-test-'),
  );
  const readyFile = path.join(tempDirectory, 'listener-ready.json');
  const listenerSource = [
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    "process.on('SIGTERM', () => {});",
    "const server = http.createServer((_request, response) => response.end('ready'));",
    `server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid, port: server.address().port })));`,
  ].join('\n');
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(listenerSource)}], { stdio: 'ignore' }).unref();`,
  ].join('\n');
  const controlServer = createServer((_request, response) =>
    response.end('control listener survived'),
  );
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', resolve);
  });
  let processGroup;

  try {
    processGroup = spawn(process.execPath, ['-e', parentSource], {
      detached: true,
      stdio: 'ignore',
    });
    const listener = await readReadyFile(readyFile);
    await waitForExit(processGroup);
    assert.equal(processGroup.exitCode, 0);
    const response = await fetch(`http://127.0.0.1:${listener.port}`);
    assert.equal(await response.text(), 'ready');

    const result = await stopBuyerJourneyServer(processGroup, {
      gracefulTimeoutMs: 120,
      killTimeoutMs: 2000,
      pollIntervalMs: 20,
    });
    assert.deepEqual(result, { escalated: true });
    assert.equal(await waitForPortClosed(listener.port), true);
    assert.equal(await waitForProcessGone(listener.pid), true);
    const controlResponse = await fetch(
      `http://127.0.0.1:${controlServer.address().port}`,
    );
    assert.equal(await controlResponse.text(), 'control listener survived');
  } finally {
    try {
      if (processGroup) {
        await stopBuyerJourneyServer(processGroup, {
          gracefulTimeoutMs: 100,
          killTimeoutMs: 2000,
          pollIntervalMs: 20,
        });
      }
    } finally {
      try {
        await new Promise((resolve, reject) => {
          controlServer.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      }
    }
  }

  console.log(
    'Buyer journey server lifecycle passed: exited-child handling, already-exited group leader with TERM-resistant descendant, KILL escalation, owned-listener cleanup, and unrelated-listener survival.',
  );
}

await main();
