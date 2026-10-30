import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { DockerSandboxAdapter } from '../../apps/web/src/sandbox/docker-sandbox-adapter';
import {
  parseNewGeneratedAssessmentDraft,
  validateAndPersistGeneratedAssessment,
} from '../../apps/web/src/scenarios/generated-assessment';

const specimen = async () =>
  parseNewGeneratedAssessmentDraft(
    JSON.parse(
      await readFile(
        'docs/scenarios/specimens/duplicate-confirmations.json',
        'utf8',
      ),
    ),
  );

it('keeps the authoring specimen inside the existing executable draft contract', async () => {
  const draft = await specimen();
  expect(draft.starterFiles.map((file) => file.path)).toContain('README.md');
  expect(draft.referenceFixFiles.map((file) => file.path)).toEqual([
    'src/confirmations.py',
  ]);
  expect(
    draft.acceptanceCriteria.some((criterion) => criterion.includes('handoff')),
  ).toBe(true);
});

it.skipIf(process.env.HIREARCHY_STRUCTURE_SMOKE !== '1')(
  'proves ordinary starter failure and reference success in the real controlled runtime',
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'hirearchy-structure-'),
    );
    try {
      const result = await validateAndPersistGeneratedAssessment(
        new DockerSandboxAdapter(),
        directory,
        await specimen(),
      );
      expect(result.status, JSON.stringify(result)).toBe('VALIDATED');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
