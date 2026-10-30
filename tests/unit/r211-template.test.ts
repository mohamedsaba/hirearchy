import { describe, expect, it } from 'vitest';
import {
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from '../../database/postgres/r211/template.mjs';
import {
  computeCanonicalContentDigest,
  validateAssessmentDraft,
} from '../../apps/web/src/r211-builder/validation';

describe('Reservation Moves template', () => {
  it('uses server-owned content and binds the recipe to the validated digest', () => {
    const draft = normalizeAssessmentTemplate({
      templateId: 'reservation-moves-v3',
      title: 'Forged title',
      brief: 'Forged brief',
      expectedBehavior: [],
      acceptanceCriteria: [],
      primaryFilePath: 'forged.py',
      starterFiles: [{ path: 'forged.py', content: 'pass' }],
      durationMinutes: 30,
      terminalEnabled: true,
      integratedAi: false,
      rubric: [],
    });
    const binding = reservationMovesBinding();
    expect(draft.title).toBe('Reservation Moves');
    expect(draft.starterFiles.map((file) => file.path)).toEqual([
      'src/sender.py',
      'src/service.py',
      'src/state.py',
      'tests/test_moves.py',
    ]);
    expect(validateAssessmentDraft(draft).valid).toBe(true);
    expect(computeCanonicalContentDigest(draft, binding)).not.toBe(
      computeCanonicalContentDigest(draft),
    );
    expect(() =>
      normalizeAssessmentTemplate({ ...draft, templateId: 'forged' } as never),
    ).toThrow('Unknown assessment template');
  });
});
