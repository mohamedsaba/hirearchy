import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECIPE,
  RECIPE_DIGEST,
} from '../../../packages/restricted-executor/recipes.mjs';

const templateRoot = join(
  process.cwd(),
  'docs/scenarios/examples/reservation-moves',
);
const paths = [
  'src/sender.py',
  'src/service.py',
  'src/state.py',
  'tests/test_moves.py',
];
const expectedWorkspaceDigest =
  'c1e172b193fd0c5e78f81ef5bf74ea95a07b6be3215829d5fa8e5116423b0694';
const expectedBriefDigest =
  '10d0bb112ad93c897c2801ad14059ece94f7139d181bc4d8f0ae6434e047e241';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function normalizeAssessmentTemplate(input) {
  const templateId = input?.templateId ?? 'custom';
  if (templateId === 'custom') return { ...input, templateId };
  if (templateId !== 'reservation-moves-v3')
    throw new TypeError('Unknown assessment template');

  const starterFiles = paths.map((path) => ({
    path,
    content: readFileSync(join(templateRoot, path), 'utf8'),
  }));
  const digest = sha256(
    JSON.stringify(
      starterFiles.map(({ path, content }) => [path, sha256(content)]),
    ),
  );
  const brief = readFileSync(join(templateRoot, 'README.md'), 'utf8');
  if (
    digest !== expectedWorkspaceDigest ||
    sha256(brief) !== expectedBriefDigest
  ) {
    throw new Error(
      'Approved assessment template files do not match the reviewed version',
    );
  }
  return {
    ...input,
    templateId,
    title: 'Reservation Moves',
    brief,
    expectedBehavior: [
      'Preserve booking capacity and accepted move history.',
      'Replay each accepted move without undoing later moves.',
    ],
    acceptanceCriteria: [
      'A rejected move preserves the original booking and capacity.',
      'Retries preserve each accepted move and do not undo later moves.',
    ],
    primaryFilePath: 'src/service.py',
    starterFiles,
    rubric: [
      {
        id: 'correctness',
        label: 'Reservation behavior',
        description: 'Evidence of capacity, move and replay behavior.',
        weight: 60,
        applicability: {
          kind: 'always',
          rule: 'Applies to the reservation task.',
        },
      },
      {
        id: 'verification',
        label: 'Verification',
        description: 'Evidence of checks and their observed outcomes.',
        weight: 40,
        applicability: {
          kind: 'always',
          rule: 'Applies to the reservation task.',
        },
      },
    ],
  };
}

export function reservationMovesBinding() {
  return {
    templateId: 'reservation-moves-v3',
    recipe: {
      id: RECIPE.recipeId,
      version: RECIPE.recipeVersion,
      digest: RECIPE_DIGEST,
    },
    starterWorkspaceDigest: expectedWorkspaceDigest,
  };
}
