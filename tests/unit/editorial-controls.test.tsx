// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChoicePills,
  PolicySwitch,
} from '../../apps/web/app/ui/editorial-controls';
import { ChronologyScrubber } from '../../apps/web/app/ui/chronology-scrubber';
import { LineFollowUp } from '../../apps/web/app/ui/line-follow-up';
import type { EvidenceSource } from '../../apps/web/app/evaluator/sessions/[sessionId]/evidence-workbench';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function source(key: string, order: number): EvidenceSource {
  return {
    key,
    evidenceRef: key,
    evidenceRefs: [key],
    entry: null,
    item: null,
    kind: 'record',
    title: key,
    summary: key,
    timestamp: '2026-11-17T12:00:00.000Z',
    chronologyOrder: order,
    verificationRun: null,
    conversation: null,
  };
}

describe('editorial controls retain product boundaries', () => {
  it('a disabled AI policy cannot change its capability and exposes the candidate-facing rule', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <PolicySwitch
          checked={false}
          disabled
          label="Integrated AI"
          onChange={onChange}
          description="AI assistance is unavailable in local testing."
        />,
      ),
    );
    const input = container.querySelector('input')!;
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(false);
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    await act(async () => input.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'AI assistance is unavailable in local testing.',
    );
  });

  it('stack choices keep unsupported options disabled', async () => {
    const change = vi.fn();
    await act(async () =>
      root.render(
        <ChoicePills
          label="Stack"
          value="python"
          options={[
            { id: 'python', label: 'Python' },
            {
              id: 'node',
              label: 'Node.js (not yet available)',
              disabled: true,
            },
          ]}
          onChange={change}
        />,
      ),
    );
    const node =
      container.querySelector<HTMLInputElement>('input[value=node]')!;
    await act(async () => node.click());
    expect(node.disabled).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });

  it('the chronology follows authoritative ordering without mutating sources or inventing events', async () => {
    const later = source('Later recorded test', 20);
    const first = source('Recorded workspace change', 10);
    const missingTime = { ...source('No recorded time', 30), timestamp: null };
    const sources = [later, first, missingTime];
    const select = vi.fn();
    await act(async () =>
      root.render(
        <ChronologyScrubber
          sources={sources}
          selectedKey={first.key}
          onSelect={select}
        />,
      ),
    );
    const range =
      container.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(range.max).toBe('1');
    expect(range.getAttribute('aria-valuetext')).toContain(first.title);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(range, '1');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select).toHaveBeenCalledWith(later);
    expect(sources[0]).toBe(later);
    expect(container.textContent).not.toContain('No recorded time');
  });

  it('line follow-up selects exact submitted line numbers without creating a hiring judgment', async () => {
    function Harness() {
      const [line, setLine] = useState<number | null>(null);
      return (
        <LineFollowUp
          content={'const token = createToken();\nawait acquire(token);'}
          filePath="src/lock.ts"
          line={line}
          onLineChange={setLine}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    const target = container.querySelector<HTMLButtonElement>(
      '[aria-label="Ask about src/lock.ts line 2"]',
    )!;
    await act(async () => target.click());
    expect(target.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('src/lock.ts:2');
    expect(container.textContent).toContain('private review notes');
    await act(async () => target.click());
    expect(target.getAttribute('aria-pressed')).toBe('false');
  });
});
