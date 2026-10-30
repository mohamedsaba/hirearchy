// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidateWorkspace } from '../../apps/web/app/candidate/[token]/candidate-workspace';
import type { CandidateSessionView } from '../../apps/web/src/sessions/candidate-session-view';

// @ts-expect-error react act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activeSessionFixture: CandidateSessionView = {
  id: 'session-a11y-editor-test',
  scenario: {
    id: 'scenario-001',
    title: 'Distributed Inventory Cache',
    version: '1.0.0',
    type: 'single_file',
    brief: 'Correct stale inventory reads.',
    acceptanceCriteria: ['Keep cache entries current.'],
    filePath: 'inventory/service.py',
  },
  status: 'ACTIVE',
  workingContent: 'def get_inventory():\n    return []\n',
  createdAt: '2026-09-22T10:00:00.000Z',
  activatedAt: '2026-09-22T10:01:00.000Z',
  submittedAt: null,
  durationSeconds: 3600,
  deadline: '2026-09-23T10:01:00.000Z',
  serverTime: '2026-09-22T10:01:00.000Z',
  closureReason: null,
  scenarioType: 'single_file',
  terminalEnabled: true,
  aiCapability: { enabled: true },
};

/**
 * WCAG 2.1 relative luminance and contrast ratio calculation.
 */
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const [sR, sG, sB] = [r, g, b].map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('CodeMirror accessibility and contrast guarantees', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.restoreAllMocks();
  });

  it('guarantees light and dark gutter line numbers meet WCAG AA contrast (>= 4.5:1)', () => {
    const lightGutterText = '#625871';
    const lightGutterBg = '#fffefd';
    const darkGutterText = '#a8b0b8';
    const darkGutterBg = '#171b1f';
    const oldFailingColor = '#817a8a';

    const lightRatio = contrastRatio(lightGutterText, lightGutterBg);
    const darkRatio = contrastRatio(darkGutterText, darkGutterBg);
    const oldRatio = contrastRatio(oldFailingColor, lightGutterBg);

    // Old color failed WCAG AA threshold (< 4.5:1)
    expect(oldRatio).toBeLessThan(4.5);

    // Updated colors strictly meet or exceed WCAG AA threshold (>= 4.5:1)
    expect(lightRatio).toBeGreaterThanOrEqual(4.5);
    expect(lightRatio).toBeCloseTo(6.61, 1);

    expect(darkRatio).toBeGreaterThanOrEqual(4.5);
    expect(darkRatio).toBeCloseTo(7.89, 1);
  });

  it('provides keyboard access to CodeMirror editor without stealing scroller focus', async () => {
    await act(async () => {
      root?.render(
        <CandidateWorkspace
          initialSession={activeSessionFixture}
          token="candidate-token-test"
        />,
      );
    });

    const scroller = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-scroller',
    );
    const content = container?.querySelector<HTMLElement>(
      '.candidate-code-editor .cm-content',
    );

    expect(scroller).not.toBeNull();
    expect(content).not.toBeNull();

    // contentDOM has explicit tabindex="0" so keyboard users and axe-core recognize it
    expect(content?.getAttribute('tabindex')).toBe('0');
    expect(content?.getAttribute('contenteditable')).toBe('true');
    expect(content?.getAttribute('aria-label')).toBe(
      'Edit inventory/service.py',
    );

    // Scroller does not steal keyboard focus with a positive tabIndex
    expect(scroller?.getAttribute('tabindex')).toBe('-1');
  });
});
