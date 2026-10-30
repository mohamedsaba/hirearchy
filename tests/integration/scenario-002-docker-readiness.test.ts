import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';
import { scenario001 } from '../../apps/web/src/scenarios/scenario-001';
import { scenario002 } from '../../apps/web/src/scenarios/scenario-002-booking-notification-retry';
import { SessionService } from '../../apps/web/src/sessions/session-service';
import { SqliteSessionStore } from '../../apps/web/src/sessions/sqlite-session-store';

const dockerTest =
  process.env.HIREARCHY_DOCKER_SCENARIO_TEST === '1' ? describe : describe.skip;

dockerTest('scenario 002 Docker runtime readiness', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(tmpdir(), 'hirearchy-scenario-002-docker-'),
    );
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each([
    {
      label: 'scenario 001',
      scenario: scenario001,
      included: ['inventory/service.py', 'tests/test_inventory.py'],
      excluded: 'bookings/service.py',
    },
    {
      label: 'scenario 002',
      scenario: scenario002,
      included: ['bookings/service.py', 'tests/test_bookings.py'],
      excluded: 'inventory/service.py',
    },
  ])(
    'starts $label and exposes its own repository',
    async ({ scenario, included, excluded }) => {
      const adapter = new DockerSandboxAdapter();
      const service = new SessionService(
        new SqliteSessionStore(path.join(directory, 'sessions.sqlite')),
        { sandboxAdapter: adapter },
      );
      const { candidateToken, session } = service.createSession({ scenario });

      try {
        const activated = await service.activate(candidateToken);
        expect(activated.status).toBe('ACTIVE');
        const paths = (await adapter.listFiles(session.id)).map(
          ({ path }) => path,
        );
        for (const path of included) expect(paths).toContain(path);
        expect(paths).not.toContain(excluded);
        const representativePath = scenario.id.includes('scenario-002')
          ? 'bookings/service.py'
          : 'inventory/service.py';
        const source = await adapter.readFile(session.id, representativePath);
        expect(source.length).toBeGreaterThan(0);
        const treeHash = await adapter.captureWorkspaceTree(session.id);
        expect(treeHash).toMatch(/^[a-f0-9]{40}$/);
        if (scenario.id === scenario002.id) {
          const baseline = await service.executeCommand(
            candidateToken,
            'pytest -q',
          );
          expect(baseline.exitCode).not.toBe(0);
          expect(baseline.stdoutPreview).toContain(
            'test_provider_retry_does_not_duplicate_booking_or_confirmation',
          );
          expect(baseline.stdoutPreview).toContain('2 passed');

          const original = await service.readWorkspaceFile(
            candidateToken,
            'bookings/service.py',
          );
          const corrected = original.replace(
            `        if booking is None:\n            cursor = connection.execute(\n                "INSERT INTO bookings (checkout_id, passenger_email, sailing) VALUES (?, ?, ?)",\n                (checkout_id, passenger_email, sailing),\n            )\n            booking_id = cursor.lastrowid\n        else:\n            booking_id = booking["id"]\n`,
            `        if booking is not None:\n            return booking\n\n        cursor = connection.execute(\n            "INSERT INTO bookings (checkout_id, passenger_email, sailing) VALUES (?, ?, ?)",\n            (checkout_id, passenger_email, sailing),\n        )\n        booking_id = cursor.lastrowid\n`,
          );
          expect(corrected).not.toBe(original);
          await service.saveWorkspaceFile(
            candidateToken,
            'bookings/service.py',
            corrected,
          );
          const reference = await service.executeCommand(
            candidateToken,
            'pytest -q',
          );
          expect(reference.exitCode).toBe(0);
          expect(reference.stdoutPreview).toContain('3 passed');
        }
      } finally {
        await adapter.teardown(session.id);
      }
    },
    120_000,
  );
});
