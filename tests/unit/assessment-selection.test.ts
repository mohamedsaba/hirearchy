import { describe, expect, it } from 'vitest';

import {
  assessmentDurations,
  isSupportedAssessmentSelection,
  supportedAssessmentSelection,
} from '../../apps/web/src/assessments/assessment-options';
import {
  parseAssessmentDraft,
  parseAssessmentSelection,
} from '../../apps/web/src/assessments/assessment-selection';

const ready = { ...supportedAssessmentSelection, integratedAi: false };

describe('assessment configuration catalog', () => {
  it('accepts the authored exact blueprint and preserves the AI tool choice', () => {
    expect(parseAssessmentSelection(ready)).toEqual(ready);
    expect(isSupportedAssessmentSelection(ready)).toBe(true);
    expect(
      isSupportedAssessmentSelection({ ...ready, integratedAi: true }),
    ).toBe(true);
  });

  it('supports only the published duration choices for the ready blueprint', () => {
    for (const durationMinutes of assessmentDurations) {
      const selection = { ...ready, durationMinutes };
      expect(parseAssessmentSelection(selection)).toEqual(selection);
      expect(isSupportedAssessmentSelection(selection)).toBe(true);
    }
    expect(
      parseAssessmentSelection({ ...ready, durationMinutes: 20 }),
    ).toBeNull();
  });

  it('parses the terminal capability separately from supported task selectors', () => {
    const selection = { ...ready, terminalEnabled: false };
    expect(parseAssessmentSelection(selection)).toEqual(selection);
    expect(isSupportedAssessmentSelection(selection)).toBe(true);
  });

  it('keeps valid but unsupported combinations as draft-only selections', () => {
    const unsupported = { ...ready, field: 'flutter', stack: 'flutter-dart' };
    expect(parseAssessmentSelection(unsupported)).toEqual(unsupported);
    expect(isSupportedAssessmentSelection(unsupported)).toBe(false);
  });

  it('rejects invented catalog values and extra client-controlled fields', () => {
    expect(
      parseAssessmentSelection({ ...ready, domain: 'made-up' }),
    ).toBeNull();
    expect(
      parseAssessmentSelection({
        ...ready,
        scenarioId: 'scenario-001-cache-staleness',
      }),
    ).toBeNull();
  });

  it('accepts an incomplete selector draft without creating implied defaults', () => {
    expect(parseAssessmentDraft({ field: 'backend' })).toEqual({
      field: 'backend',
    });
    expect(
      parseAssessmentDraft({ field: 'backend', title: 'custom' }),
    ).toBeNull();
  });
});
