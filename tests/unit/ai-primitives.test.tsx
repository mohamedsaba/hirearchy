// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AiReasoningDisclosure,
  AiStreamingBubble,
  CommonThreadSpark,
  HirearchyAiThinking,
  type AiReasoningTraceItem,
} from '../../apps/web/app/_components/ai';

describe('Common Thread 2.0 AI primitives', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const renderNode = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node);
    });
  };

  describe('<CommonThreadSpark />', () => {
    it('renders active, compact, idle, and completing check settle states', async () => {
      await renderNode(<CommonThreadSpark />);
      let spark = container.querySelector('.ct-ai-spark');
      let svg = container.querySelector('svg');
      expect(spark?.getAttribute('data-status')).toBe('active');
      expect(spark?.getAttribute('data-compact')).toBe('false');
      expect(spark?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('width')).toBe('28');
      expect(container.querySelectorAll('.ct-ai-spark-node')).toHaveLength(3);
      expect(container.querySelector('.ct-ai-spark-star')).not.toBeNull();

      await renderNode(
        <CommonThreadSpark compact status="idle" label="Idle" />,
      );
      spark = container.querySelector('.ct-ai-spark');
      svg = container.querySelector('svg');
      expect(spark?.getAttribute('data-status')).toBe('idle');
      expect(spark?.getAttribute('data-compact')).toBe('true');
      expect(spark?.getAttribute('role')).toBe('img');
      expect(spark?.getAttribute('aria-label')).toBe('Idle');
      expect(svg?.getAttribute('width')).toBe('16');

      await renderNode(<CommonThreadSpark status="completing" />);
      spark = container.querySelector('.ct-ai-spark');
      expect(spark?.getAttribute('data-status')).toBe('completing');
      expect(container.querySelector('.ct-ai-spark-check')).not.toBeNull();
      expect(container.querySelector('.ct-ai-spark-check-ring')).not.toBeNull();
      expect(container.querySelector('.ct-ai-spark-star')).toBeNull();
    });
  });

  describe('<HirearchyAiThinking />', () => {
    it('renders studio, inline, and advisory variants with appropriate badges', async () => {
      await renderNode(
        <HirearchyAiThinking
          variant="studio"
          status="active"
          headline="Drafting scenario workspace"
          sublabel="You can navigate elsewhere while this finishes."
          testId="studio-thinking"
        />,
      );

      const studioEl = container.querySelector(
        '[data-testid="studio-thinking"]',
      );
      expect(studioEl?.getAttribute('data-variant')).toBe('studio');
      expect(studioEl?.getAttribute('role')).toBe('status');
      expect(
        container.querySelector('.ct-ai-shimmer--active')?.textContent,
      ).toBe('Drafting scenario workspace');
      expect(container.textContent).toContain(
        'You can navigate elsewhere while this finishes.',
      );

      await renderNode(
        <HirearchyAiThinking
          variant="inline"
          status="active"
          headline="Thinking…"
          badge="Recorded context"
        />,
      );
      expect(
        container
          .querySelector('.ct-ai-thinking')
          ?.getAttribute('data-variant'),
      ).toBe('inline');
      expect(
        container.querySelector('.ct-ai-spark')?.getAttribute('data-compact'),
      ).toBe('true');
      expect(container.querySelector('.ct-ai-badge')?.textContent).toBe(
        'Recorded context',
      );

      await renderNode(
        <HirearchyAiThinking
          variant="advisory"
          status="active"
          headline="Synthesizing advisory summary"
        />,
      );
      expect(
        container
          .querySelector('.ct-ai-thinking')
          ?.getAttribute('data-variant'),
      ).toBe('advisory');
      expect(
        container.querySelector('.ct-ai-badge--advisory')?.textContent,
      ).toBe('AI advisory');
    });

    it('updates visual elapsed time without changing the announced status', async () => {
      vi.useFakeTimers();
      const baseNow = new Date('2026-11-27T18:00:00Z').getTime();
      vi.setSystemTime(baseNow);

      await renderNode(
        <HirearchyAiThinking
          variant="studio"
          status="active"
          headline="Generating assessment"
          startedAt={baseNow - 12_000}
        />,
      );

      expect(
        container.querySelector('[data-testid="ct-ai-timer"]')?.textContent,
      ).toBe('12s');

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(
        container.querySelector('[data-testid="ct-ai-timer"]')?.textContent,
      ).toBe('14s');
      expect(
        container
          .querySelector('[data-testid="ct-ai-timer"]')
          ?.closest('[aria-hidden="true"]'),
      ).not.toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        'Generating assessment',
      );
    });

    it('settles the spark on completion and announces the error state', async () => {
      await renderNode(
        <HirearchyAiThinking
          variant="studio"
          status="completing"
          headline="Scenario ready"
          showTimer={false}
        />,
      );

      expect(
        container.querySelector('.ct-ai-spark')?.getAttribute('data-status'),
      ).toBe('completing');
      expect(container.querySelector('.ct-ai-shimmer--active')).toBeNull();
      expect(container.querySelector('[data-testid="ct-ai-timer"]')).toBeNull();

      await renderNode(
        <HirearchyAiThinking
          variant="advisory"
          status="error"
          headline="Unable to draft synthesis"
        />,
      );
      expect(
        container.querySelector('.ct-ai-thinking')?.getAttribute('role'),
      ).toBe('alert');
    });
  });

  describe('<AiStreamingBubble />', () => {
    it('renders thinking state with testId passthrough and neutral framing', async () => {
      await renderNode(
        <AiStreamingBubble
          roleLabel="Recorded AI Assistant"
          status="thinking"
          testId="ai-loading-indicator"
          thinkingProps={{ headline: 'Reviewing your request…' }}
          renderContent={(text) => <p>{text}</p>}
        />,
      );

      const bubble = container.querySelector(
        '[data-testid="ai-loading-indicator"]',
      );
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute('data-status')).toBe('thinking');
      expect(bubble?.textContent).toContain('Recorded AI Assistant');
      expect(bubble?.textContent).toContain('Reviewing your request…');
      expect(container.querySelector('.ct-ai-caret')).toBeNull();
    });

    it('progressively reveals completed content within 900ms when animateReveal is enabled', async () => {
      vi.useFakeTimers();
      let nowMs = 0;
      const callbacks = new Map<number, FrameRequestCallback>();
      let nextFrameId = 1;

      vi.stubGlobal('matchMedia', () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        const id = nextFrameId++;
        callbacks.set(id, cb);
        return id;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        callbacks.delete(id);
      });

      const fullAnswer =
        'Check the cache key normalization before invalidating stale entries in the store.';

      await renderNode(
        <AiStreamingBubble
          roleLabel="AI Assistant"
          timestamp="10:14:02"
          status="complete"
          content={fullAnswer}
          animateReveal
          testId="ai-assistant-message"
          renderContent={(visibleText, isStreaming) => (
            <p data-streaming={String(isStreaming)}>{visibleText}</p>
          )}
        />,
      );

      const flushFrame = async (advanceMs: number) => {
        nowMs += advanceMs;
        const pending = Array.from(callbacks.entries());
        callbacks.clear();
        await act(async () => {
          for (const [, cb] of pending) {
            cb(nowMs);
          }
        });
      };

      // Mid-reveal frame shows partial text and active streaming caret
      await flushFrame(90);
      const midParagraph = container.querySelector('.ct-ai-bubble-body p');
      expect(midParagraph?.getAttribute('data-streaming')).toBe('true');
      expect((midParagraph?.textContent ?? '').length).toBeGreaterThan(0);
      expect((midParagraph?.textContent ?? '').length).toBeLessThan(
        fullAnswer.length,
      );
      expect(container.querySelector('.ct-ai-caret')).not.toBeNull();

      // Reaching 900ms settles completely and removes the streaming caret
      await flushFrame(900);
      const settledParagraph = container.querySelector('.ct-ai-bubble-body p');
      expect(settledParagraph?.getAttribute('data-streaming')).toBe('false');
      expect(settledParagraph?.textContent).toBe(fullAnswer);
      expect(container.querySelector('.ct-ai-caret')).toBeNull();
    });

    it('reveals immediately without caret when prefers-reduced-motion is reduce', async () => {
      vi.stubGlobal('matchMedia', () => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      await renderNode(
        <AiStreamingBubble
          roleLabel="AI Assistant"
          status="complete"
          content="Immediate reduced-motion reply."
          animateReveal
          renderContent={(visibleText, isStreaming) => (
            <p data-streaming={String(isStreaming)}>{visibleText}</p>
          )}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });

      const paragraph = container.querySelector('.ct-ai-bubble-body p');
      expect(paragraph?.textContent).toBe('Immediate reduced-motion reply.');
      expect(paragraph?.getAttribute('data-streaming')).toBe('false');
      expect(container.querySelector('.ct-ai-caret')).toBeNull();
    });

    it('renders complete historical messages immediately and failed messages as alerts', async () => {
      await renderNode(
        <AiStreamingBubble
          roleLabel="Weft"
          status="complete"
          content="Static historical reply."
          testId="ai-assistant-message"
          disclosure={<div>Context attached</div>}
          renderContent={(visibleText) => <p>{visibleText}</p>}
        />,
      );

      expect(
        container.querySelector('[data-testid="ai-assistant-message"]')
          ?.textContent,
      ).toContain('Static historical reply.');
      expect(container.textContent).toContain('Context attached');
      expect(container.querySelector('.ct-ai-caret')).toBeNull();

      await renderNode(
        <AiStreamingBubble
          roleLabel="Weft"
          status="failed"
          errorMessage="Assistant request timed out."
          testId="ai-failed-message"
          renderContent={(visibleText) => <p>{visibleText}</p>}
        />,
      );
      const errorAlert = container.querySelector('[role="alert"]');
      expect(errorAlert?.textContent).toBe('Assistant request timed out.');
    });
  });

  describe('<AiReasoningDisclosure />', () => {
    const traceItems: readonly AiReasoningTraceItem[] = [
      {
        label: 'Diff verified across 3 files',
        status: 'verified',
        detail: 'src/cache.ts, src/store.ts, tests/cache.test.ts',
      },
      {
        label: 'Observed 2 test executions',
        status: 'observed',
      },
      {
        label: 'Timeout edge case coverage',
        status: 'partial',
      },
    ];

    it('renders settled duration, advisory badge, items, and toggles open/closed', async () => {
      await renderNode(
        <AiReasoningDisclosure
          title="Evidence & requirement trace"
          status="settled"
          durationSeconds={4.2}
          badge="Advisory only"
          summaryText="Grounded in recorded repository diffs and test runs."
          items={traceItems}
          testId="advisory-disclosure"
        >
          <p data-testid="extra-trace">Provider metadata</p>
        </AiReasoningDisclosure>,
      );

      const disclosure = container.querySelector(
        '[data-testid="advisory-disclosure"]',
      );
      const trigger = disclosure?.querySelector(
        '.ct-ai-reasoning-trigger',
      ) as HTMLButtonElement | null;
      const body = disclosure?.querySelector('.ct-ai-reasoning-body');

      expect(disclosure?.getAttribute('data-open')).toBe('false');
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      expect(body?.getAttribute('aria-hidden')).toBe('true');
      expect(
        disclosure?.querySelector('.ct-ai-reasoning-duration')?.textContent,
      ).toBe('4.2s');
      expect(disclosure?.querySelector('.ct-ai-badge')?.textContent).toBe(
        'Advisory only',
      );

      await act(async () => {
        trigger?.click();
      });

      expect(disclosure?.getAttribute('data-open')).toBe('true');
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
      expect(body?.getAttribute('aria-hidden')).toBe('false');
      expect(
        Array.from(
          disclosure?.querySelectorAll('.ct-ai-reasoning-item') ?? [],
        ).map((el) => el.getAttribute('data-status')),
      ).toEqual(['verified', 'observed', 'partial']);
      expect(
        disclosure?.querySelector('[data-testid="extra-trace"]')?.textContent,
      ).toBe('Provider metadata');
    });

    it('defaults open with shimmer title when status is thinking', async () => {
      await renderNode(
        <AiReasoningDisclosure
          title="Analyzing evidence…"
          status="thinking"
          testId="thinking-disclosure"
        />,
      );

      const disclosure = container.querySelector(
        '[data-testid="thinking-disclosure"]',
      );
      expect(disclosure?.getAttribute('data-open')).toBe('true');
      expect(
        disclosure?.querySelector('.ct-ai-shimmer--active')?.textContent,
      ).toBe('Analyzing evidence…');
    });
  });
});
