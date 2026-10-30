// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssessmentChoice } from '../../apps/web/app/evaluator/assessments/new/assessment-choice';

describe('assessment choice', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows option briefs and supports keyboard selection and Escape', async () => {
    const onChange = vi.fn();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AssessmentChoice
          id="field"
          label="Technical field"
          value="backend"
          onChange={onChange}
          options={[
            { id: 'backend', label: 'Backend engineering', group: 'Web' },
            { id: 'frontend', label: 'Frontend engineering', group: 'Web' },
            { id: 'ios', label: 'iOS engineering', group: 'Mobile' },
          ]}
        />,
      );
    });

    const trigger = container.querySelector('button') as HTMLButtonElement;
    await act(async () => trigger.click());
    const listbox = container.querySelector(
      '[role="listbox"]',
    ) as HTMLDivElement;
    expect(listbox).not.toBeNull();
    expect(container.textContent).toContain('server behavior');
    expect(document.activeElement).toBe(listbox);

    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(container.textContent).toContain('browser interface');
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenCalledWith('frontend');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    const reopenedListbox = container.querySelector(
      '[role="listbox"]',
    ) as HTMLDivElement;
    await act(async () => {
      reopenedListbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
    });
    const activeOptionId = reopenedListbox.getAttribute(
      'aria-activedescendant',
    );
    expect(
      document.getElementById(activeOptionId ?? '')?.textContent,
    ).toContain('iOS engineering');
    expect(scrollIntoView.mock.contexts.at(-1)?.textContent).toContain(
      'iOS engineering',
    );
    await act(async () => {
      reopenedListbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('identifies disabled options with aria-disabled and prevents selection via pointer and keyboard', async () => {
    const onChange = vi.fn();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AssessmentChoice
          id="stack"
          label="Stack"
          value="python-flask"
          onChange={onChange}
          options={[
            { id: 'python-flask', label: 'Python · Flask' },
            {
              id: 'typescript-react',
              label: 'TypeScript · React (not yet available)',
              disabled: true,
            },
          ]}
        />,
      );
    });

    const trigger = container.querySelector('button') as HTMLButtonElement;
    await act(async () => trigger.click());
    const listbox = container.querySelector(
      '[role="listbox"]',
    ) as HTMLDivElement;
    expect(listbox).not.toBeNull();

    const options = Array.from(container.querySelectorAll('[role="option"]'));
    const availableOption = options[0];
    const disabledOption = options[1];

    expect(availableOption?.getAttribute('aria-disabled')).toBeNull();
    expect(availableOption?.getAttribute('data-disabled')).toBeNull();
    expect(disabledOption?.getAttribute('aria-disabled')).toBe('true');
    expect(disabledOption?.getAttribute('data-disabled')).toBe('true');

    // Pointer click on disabled option does not select it
    await act(async () => {
      disabledOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    // Keyboard navigation to disabled option and pressing Enter does not select it
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      disabledOption?.id,
    );
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    // Keyboard Space on disabled option does not select it
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();

    // Selecting available option still works
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      availableOption?.id,
    );
    await act(async () => {
      listbox.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onChange).toHaveBeenCalledWith('python-flask');
  });
});
