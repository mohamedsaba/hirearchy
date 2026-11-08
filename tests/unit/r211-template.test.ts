import { describe, expect, it } from 'vitest';
import {
  APPROVED_ASSESSMENT_TEMPLATES,
  expectedBriefDigest,
  expectedWorkspaceDigest,
  getApprovedTemplate,
  listApprovedTemplates,
  normalizeAssessmentTemplate,
  reservationMovesBinding,
} from '../../database/postgres/r211/template.mjs';
import {
  computeCanonicalContentDigest,
  validateAssessmentDraft,
} from '../../apps/web/src/r211-builder/validation';

describe('Reservation Moves template', () => {
  it('exposes approved template catalog with reviewed digests and contracts', () => {
    expect(APPROVED_ASSESSMENT_TEMPLATES).toHaveLength(1);
    expect(listApprovedTemplates()).toEqual(APPROVED_ASSESSMENT_TEMPLATES);
    const template = getApprovedTemplate('reservation-moves-v3');
    expect(template).not.toBeNull();
    expect(template?.templateId).toBe('reservation-moves-v3');
    expect(template?.scenarioId).toBe('reservation-moves');
    expect(template?.scenarioVersion).toBe('v3');
    expect(template?.recipeId).toBe('reservation-moves.pytest');
    expect(template?.starterWorkspaceDigest).toBe(expectedWorkspaceDigest);
    expect(template?.starterFilePaths).toEqual([
      'src/sender.py',
      'src/service.py',
      'src/state.py',
      'tests/test_moves.py',
    ]);
    expect(expectedBriefDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedWorkspaceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(getApprovedTemplate('non-existent')).toBeNull();
  });

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
