'use client';

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface SlidingIndicatorOptions {
  readonly activeSelector?: string;
}

const DEFAULT_ACTIVE_SELECTOR =
  '[role="tab"][aria-selected="true"], [aria-pressed="true"], .is-active';

/**
 * Tracks the active tab button inside a container via ResizeObserver and
 * writes `--tab-indicator-x`, `--tab-indicator-y`, `--tab-indicator-w`, and
 * `--tab-indicator-h` onto the container without SSR layout shift.
 */
export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: string,
  options: SlidingIndicatorOptions = {},
): boolean {
  const [ready, setReady] = useState(false);
  const selector = options.activeSelector ?? DEFAULT_ACTIVE_SELECTOR;

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const activeEl = container.querySelector<HTMLElement>(selector);
      if (!activeEl) {
        container.removeAttribute('data-indicator-ready');
        setReady(false);
        return;
      }

      const x = activeEl.offsetLeft;
      const y = activeEl.offsetTop;
      const w = activeEl.offsetWidth;
      const h = activeEl.offsetHeight;

      container.style.setProperty('--tab-indicator-x', `${x}px`);
      container.style.setProperty('--tab-indicator-y', `${y}px`);
      container.style.setProperty('--tab-indicator-w', `${w}px`);
      container.style.setProperty('--tab-indicator-h', `${h}px`);
      container.setAttribute('data-indicator-ready', 'true');
      setReady(true);
    };

    measure();

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        measure();
      });
      observer.observe(container);
      const activeEl = container.querySelector<HTMLElement>(selector);
      if (activeEl) observer.observe(activeEl);
    }

    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [containerRef, activeKey, selector]);

  return ready;
}

export const useSlidingTabIndicator = useSlidingIndicator;
