import { expect, it } from 'vitest';
import { assessmentWorkKinds } from '../../apps/web/src/assessments/assessment-options';
import { getAssessmentStructureGuidance } from '../../apps/web/src/scenarios/assessment-structure';

it('provides a distinct bounded family for every selectable work kind', () => {
  const values = assessmentWorkKinds.map(({ id }) =>
    getAssessmentStructureGuidance(id),
  );
  expect(new Set(values).size).toBe(assessmentWorkKinds.length);
  for (const guidance of values) {
    expect(guidance).toContain('Scenario family:');
    expect(guidance).toContain('README.md');
    expect(guidance).toContain('must not add hidden requirements');
  }
});
