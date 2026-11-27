// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navState = vi.hoisted(() => ({
  pathname: '/r23/organizations/org-1/candidates',
  search: '',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

import {
  BrandToastViewport,
  clearToasts,
  emitToast,
} from '../../apps/web/app/_components/brand-toast';
import { CopyActionButton } from '../../apps/web/app/_components/copy-action-button';
import { HorizontalTabs } from '../../apps/web/app/_components/horizontal-tabs';
import { KbdHint } from '../../apps/web/app/_components/kbd-hint';
import { RouteProgressBar } from '../../apps/web/app/_components/route-progress-bar';
import {
  EvaluatorWorkbenchSkeleton,
  SkeletonBlock,
  SkeletonText,
  WorkspaceSkeletonShell,
} from '../../apps/web/app/_components/skeleton';
import { SmoothDisclosure } from '../../apps/web/app/_components/smooth-disclosure';

describe('Common Thread 2.0 design kit primitives', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    clearToasts();
    navState.pathname = '/r23/organizations/org-1/candidates';
    navState.search = '';
    window.history.replaceState(
      null,
      '',
      '/r23/organizations/org-1/candidates',
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    clearToasts();
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('BrandToastViewport and emitToast', () => {
    it('stacks at most 3 toasts, renders description and action, and auto-dismisses', async () => {
      await act(async () => root.render(<BrandToastViewport />));
      const onAction = vi.fn();

      await act(async () => {
        emitToast({ message: 'First notice', tone: 'info' });
        emitToast({ message: 'Second notice', tone: 'warning' });
        emitToast({
          message: 'Third notice',
          description: 'Saved draft details',
          tone: 'success',
          actionLabel: 'Undo',
          onAction,
        });
        emitToast({
          message: 'Fourth notice',
          tone: 'error',
          durationMs: 2000,
        });
      });

      const items = container.querySelectorAll('.ct-toast');
      expect(items).toHaveLength(3);
      expect(container.textContent).not.toContain('First notice');
      expect(container.textContent).toContain('Second notice');
      expect(container.textContent).toContain('Third notice');
      expect(container.textContent).toContain('Saved draft details');
      expect(container.textContent).toContain('Fourth notice');

      const errorToast = container.querySelector('.ct-toast--error');
      expect(errorToast?.getAttribute('role')).toBe('alert');
      expect(errorToast?.getAttribute('aria-live')).toBe('assertive');

      const actionBtn = container.querySelector(
        '.ct-toast-action',
      ) as HTMLButtonElement;
      await act(async () => actionBtn.click());
      expect(onAction).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(160);
      });
      expect(container.querySelectorAll('.ct-toast')).toHaveLength(2);

      // Fourth toast expires at 2000ms + 160ms exit
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(container.textContent).not.toContain('Fourth notice');
    });

    it('pauses auto-dismiss while hovered or focused and resumes on leave', async () => {
      await act(async () => root.render(<BrandToastViewport />));
      await act(async () => {
        emitToast({
          message: 'Hoverable toast',
          tone: 'success',
          durationMs: 1000,
        });
      });

      const toast = container.querySelector('.ct-toast') as HTMLElement;
      expect(toast).not.toBeNull();

      await act(async () => {
        toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(container.textContent).toContain('Hoverable toast');

      await act(async () => {
        toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(1200);
      });
      expect(container.textContent).not.toContain('Hoverable toast');
    });
  });

  describe('CopyActionButton', () => {
    it('copies text, morphs to copied state with aria-live and toast, and resets after 2s', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      await act(async () =>
        root.render(
          <>
            <CopyActionButton
              value="https://hirearchy.test/invite/123"
              label="Copy link"
              copiedLabel="Link copied"
              toastMessage="Invite link copied"
              testId="copy-invite"
            />
            <BrandToastViewport />
          </>,
        ),
      );

      const button = container.querySelector(
        '[data-testid="copy-invite"]',
      ) as HTMLButtonElement;
      expect(button.getAttribute('data-copied')).toBe('false');
      expect(button.textContent).toContain('Copy link');

      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(writeText).toHaveBeenCalledWith(
        'https://hirearchy.test/invite/123',
      );
      expect(button.getAttribute('data-copied')).toBe('true');
      expect(button.textContent).toContain('Link copied');
      expect(button.querySelector('[aria-live="polite"]')?.textContent).toBe(
        'Link copied',
      );
      expect(container.textContent).toContain('Invite link copied');

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(button.getAttribute('data-copied')).toBe('false');
      expect(button.textContent).toContain('Copy link');

      Reflect.deleteProperty(navigator, 'clipboard');
    });

    it('handles unavailable clipboard gracefully without throwing', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      });

      await act(async () =>
        root.render(
          <>
            <CopyActionButton
              value="secret"
              toastMessage="Copied"
              testId="copy-fail"
            />
            <BrandToastViewport />
          </>,
        ),
      );

      const button = container.querySelector(
        '[data-testid="copy-fail"]',
      ) as HTMLButtonElement;
      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(button.getAttribute('data-copy-status')).toBe('error');
      expect(button.querySelector('[aria-live="polite"]')?.textContent).toBe(
        'Clipboard unavailable',
      );
      expect(container.textContent).toContain('Clipboard unavailable');

      Reflect.deleteProperty(navigator, 'clipboard');
    });
  });

  describe('Skeleton primitives', () => {
    it('renders SkeletonBlock, SkeletonText, WorkspaceSkeletonShell, and EvaluatorWorkbenchSkeleton', async () => {
      await act(async () =>
        root.render(
          <div>
            <SkeletonBlock
              width="12rem"
              height="1.5rem"
              tone="accent"
              index={2}
            />
            <SkeletonText lines={3} lastLineWidth="55%" />
            <WorkspaceSkeletonShell
              activeSection="candidates"
              title="Candidates"
              subtitle="Review submissions"
            />
            <EvaluatorWorkbenchSkeleton withOrgBreadcrumb />
          </div>,
        ),
      );

      const accentBlock = container.querySelector(
        '.ct-skel[data-skel-tone="accent"]',
      ) as HTMLElement;
      expect(accentBlock).not.toBeNull();
      expect(accentBlock.style.width).toBe('12rem');
      expect(accentBlock.style.getPropertyValue('--skel-index')).toBe('2');

      const textLines = container
        .querySelector('.ct-skel-text')!
        .querySelectorAll('.ct-skel');
      expect(textLines).toHaveLength(3);
      expect((textLines[2] as HTMLElement).style.width).toBe('55%');

      const workspace = container.querySelector(
        '[data-loading-section="candidates"]',
      );
      expect(workspace?.getAttribute('aria-busy')).toBe('true');
      expect(workspace?.querySelector('h1')?.textContent).toBe('Candidates');

      const workbench = container.querySelector('.skeleton-workbench');
      expect(workbench).not.toBeNull();
      expect(workbench?.getAttribute('data-hiring-review')).toBe('true');
      expect(
        workbench?.querySelector('.skeleton-workbench-breadcrumb'),
      ).not.toBeNull();
      expect(
        workbench?.querySelector('.evaluator-workbench-shell'),
      ).not.toBeNull();
    });
  });

  describe('SmoothDisclosure', () => {
    it('toggles open state, aria-expanded, inert, and data-open', async () => {
      const onOpenChange = vi.fn();
      await act(async () =>
        root.render(
          <SmoothDisclosure
            summary="Evidence breakdown"
            badge="3 files"
            onOpenChange={onOpenChange}
            testId="ev-disclosure"
          >
            <p>Detailed file diff summary</p>
          </SmoothDisclosure>,
        ),
      );

      const wrapper = container.querySelector('[data-testid="ev-disclosure"]')!;
      const trigger = wrapper.querySelector(
        '.ct-disclosure-trigger',
      ) as HTMLButtonElement;
      const panel = wrapper.querySelector(
        '.ct-disclosure-panel',
      ) as HTMLElement;

      expect(wrapper.getAttribute('data-open')).toBe('false');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(panel.getAttribute('data-open')).toBe('false');
      expect(panel.hasAttribute('inert')).toBe(true);

      await act(async () => trigger.click());

      expect(onOpenChange).toHaveBeenCalledWith(true);
      expect(wrapper.getAttribute('data-open')).toBe('true');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(panel.getAttribute('data-open')).toBe('true');
      expect(panel.hasAttribute('inert')).toBe(false);
    });
  });

  describe('KbdHint', () => {
    it('renders single key or key array chips with .ct-kbd', async () => {
      await act(async () =>
        root.render(
          <div>
            <KbdHint keys="Esc" label="Close" />
            <KbdHint keys={['⌘', 'K']} label="Quick switcher" />
          </div>,
        ),
      );

      const kbds = container.querySelectorAll('kbd.ct-kbd');
      expect(kbds).toHaveLength(3);
      expect(kbds[0].textContent).toBe('Esc');
      expect(kbds[1].textContent).toBe('⌘');
      expect(kbds[2].textContent).toBe('K');
    });
  });

  describe('HorizontalTabs and gliding indicator', () => {
    it('renders sliding indicator, handles keyboard navigation, and sets indicator CSS vars', async () => {
      const onSelect = vi.fn();
      await act(async () =>
        root.render(
          <HorizontalTabs
            id="review-tabs"
            label="Review sections"
            active="summary"
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'code', label: 'Code & Tests' },
              { id: 'decision', label: 'Decision' },
            ]}
            onSelect={onSelect}
            className="hiring-builder-tabs"
            tabClassName="hiring-builder-tab"
          />,
        ),
      );

      const tablist = container.querySelector(
        '[role="tablist"]',
      ) as HTMLElement;
      expect(tablist.classList.contains('ct-tabs-root')).toBe(true);
      expect(tablist.querySelector('.ct-tab-indicator')).not.toBeNull();
      expect(tablist.getAttribute('data-indicator-ready')).toBe('true');
      expect(tablist.style.getPropertyValue('--tab-indicator-x')).toMatch(
        /px$/,
      );

      const summaryTab = container.querySelector(
        '#review-tabs-summary',
      ) as HTMLButtonElement;
      expect(summaryTab.getAttribute('aria-selected')).toBe('true');

      await act(async () => {
        summaryTab.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        );
      });
      expect(onSelect).toHaveBeenCalledWith('code');

      await act(async () => {
        summaryTab.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
        );
      });
      expect(onSelect).toHaveBeenCalledWith('decision');
    });
  });

  describe('RouteProgressBar', () => {
    it('does not flash under 140ms, shows after 140ms on internal link click, and completes on route change', async () => {
      await act(async () =>
        root.render(
          <div>
            <RouteProgressBar />
            <a href="/r23/organizations/org-1/builder">Builder</a>
            <a
              href="https://external.example.com"
              target="_blank"
              rel="noreferrer"
            >
              External
            </a>
          </div>,
        ),
      );

      const internalLink = container.querySelector(
        'a[href="/r23/organizations/org-1/builder"]',
      ) as HTMLAnchorElement;
      const externalLink = container.querySelector(
        'a[href="https://external.example.com"]',
      ) as HTMLAnchorElement;

      // External link should never trigger progress
      await act(async () => {
        externalLink.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        vi.advanceTimersByTime(200);
      });
      expect(
        container.querySelector('[data-testid="route-progress-bar"]'),
      ).toBeNull();

      // Internal link click stays hidden before 140ms
      await act(async () => {
        internalLink.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        vi.advanceTimersByTime(100);
      });
      expect(
        container.querySelector('[data-testid="route-progress-bar"]'),
      ).toBeNull();

      // Appears after 140ms threshold
      await act(async () => {
        vi.advanceTimersByTime(60);
      });
      const bar = container.querySelector(
        '[data-testid="route-progress-bar"]',
      ) as HTMLElement;
      expect(bar).not.toBeNull();
      expect(bar.getAttribute('data-completing')).toBe('false');

      // Completes and fades out when pathname changes
      navState.pathname = '/r23/organizations/org-1/builder';
      await act(async () =>
        root.render(
          <div>
            <RouteProgressBar />
            <a href="/r23/organizations/org-1/builder">Builder</a>
          </div>,
        ),
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        container
          .querySelector('[data-testid="route-progress-bar"]')
          ?.getAttribute('data-completing'),
      ).toBe('true');

      await act(async () => {
        vi.advanceTimersByTime(240);
      });
      expect(
        container.querySelector('[data-testid="route-progress-bar"]'),
      ).toBeNull();
    });
  });
});
