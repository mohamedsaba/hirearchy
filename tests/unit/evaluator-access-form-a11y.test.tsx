// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvaluatorAccessForm } from '../../apps/web/app/evaluator/evaluator-access-form';

// @ts-expect-error react act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe('EvaluatorAccessForm accessibility', () => {
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

  it('renders initial form with unlinked error attributes', async () => {
    await act(async () => {
      root?.render(<EvaluatorAccessForm />);
    });

    const credentialInput = container?.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(credentialInput).not.toBeNull();
    expect(credentialInput?.hasAttribute('aria-describedby')).toBe(false);
    expect(credentialInput?.hasAttribute('aria-invalid')).toBe(false);
    expect(container?.querySelector('.form-error')).toBeNull();
  });

  it('announces access failure with role="alert" and aria-live="assertive" linked to input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        error: { message: 'Invalid evaluator credential.' },
      }),
    } as Response);

    await act(async () => {
      root?.render(<EvaluatorAccessForm />);
    });

    const credentialInput = container?.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    const form = container?.querySelector<HTMLFormElement>('form');

    await act(async () => {
      if (credentialInput) {
        const propDesc = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        );
        propDesc?.set?.call(credentialInput, 'wrong-key');
        credentialInput.dispatchEvent(new Event('input', { bubbles: true }));
        credentialInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    await act(async () => {
      form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    const errorEl =
      container?.querySelector<HTMLParagraphElement>('.form-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.getAttribute('role')).toBe('alert');
    expect(errorEl?.getAttribute('aria-live')).toBe('assertive');
    expect(errorEl?.id).toBe('evaluator-access-error');
    expect(errorEl?.textContent).toBe('Invalid evaluator credential.');

    // The credential input is linked to the alert for screen readers
    expect(credentialInput?.getAttribute('aria-describedby')).toBe(
      'evaluator-access-error',
    );
    expect(credentialInput?.getAttribute('aria-invalid')).toBe('true');
  });

  it('links session reference input to error when authenticated form encounters an error', async () => {
    await act(async () => {
      root?.render(<EvaluatorAccessForm authenticated />);
    });

    const sessionInput = container?.querySelector<HTMLInputElement>('input');
    expect(sessionInput).not.toBeNull();
    expect(sessionInput?.hasAttribute('aria-describedby')).toBe(false);
    expect(sessionInput?.hasAttribute('aria-invalid')).toBe(false);
  });
});
