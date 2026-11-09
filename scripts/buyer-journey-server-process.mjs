import { setTimeout as delay } from 'node:timers/promises';

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function observeExit(child) {
  let resolveExit;
  const exit = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const finish = () => {
    child.off('exit', finish);
    child.off('error', finish);
    resolveExit();
  };

  if (!hasExited(child)) {
    child.once('exit', finish);
    child.once('error', finish);
    // The child can exit between the first state check and listener setup.
    if (hasExited(child)) finish();
  } else {
    resolveExit();
  }
  return exit;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForGroupExit(pid, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
  return true;
}

async function waitForExit(exit, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stops only the detached POSIX process group created for the buyer journey.
 * Returns whether SIGKILL escalation was needed.
 */
export async function stopBuyerJourneyServer(
  child,
  { gracefulTimeoutMs = 5000, killTimeoutMs = 2000, pollIntervalMs = 50 } = {},
) {
  if (process.platform === 'win32') {
    throw new Error(
      'Buyer journey server cleanup requires POSIX process groups',
    );
  }

  const exit = observeExit(child);
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    if (!(await waitForExit(exit, gracefulTimeoutMs))) {
      throw new Error('Buyer journey server failed to start or exit in time');
    }
    return { escalated: false };
  }

  signalGroup(pid, 'SIGTERM');
  if (await waitForGroupExit(pid, gracefulTimeoutMs, pollIntervalMs)) {
    if (!(await waitForExit(exit, killTimeoutMs))) {
      throw new Error(
        'Buyer journey server leader did not exit after its group stopped',
      );
    }
    return { escalated: false };
  }

  signalGroup(pid, 'SIGKILL');
  if (!(await waitForGroupExit(pid, killTimeoutMs, pollIntervalMs))) {
    throw new Error('Buyer journey server process group survived SIGKILL');
  }
  if (!(await waitForExit(exit, killTimeoutMs))) {
    throw new Error('Buyer journey server leader did not exit after SIGKILL');
  }
  return { escalated: true };
}
