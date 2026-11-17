'use client';

import { useId } from 'react';

export function LineFollowUp({
  content,
  filePath,
  line,
  onLineChange,
}: {
  content: string;
  filePath: string;
  line: number | null;
  onLineChange: (line: number | null) => void;
}) {
  const id = useId();
  return (
    <div className="editorial-follow-up mb-4 min-w-0 rounded-2xl border border-cream/[0.12] bg-plum p-4 text-cream">
      <p id={id} className="m-0 text-sm font-semibold">
        Targeted follow-up question
      </p>
      <p className="mb-3 mt-1 text-xs text-cream/70">
        Choose a submitted line, then write your question below. It stays in
        your private review notes for a candidate conversation.
      </p>
      <div
        className="max-h-52 overflow-auto rounded-xl bg-plum-elevated p-2"
        role="group"
        aria-label={`Anchor a question to ${filePath}`}
      >
        {content.split('\n').map((text, index) => (
          <button
            type="button"
            key={index}
            aria-pressed={line === index + 1}
            tabIndex={(line ?? 1) === index + 1 ? 0 : -1}
            onKeyDown={(event) => {
              const lines = content.split('\n').length;
              const target =
                event.key === 'ArrowDown'
                  ? Math.min(lines, index + 2)
                  : event.key === 'ArrowUp'
                    ? Math.max(1, index)
                    : event.key === 'Home'
                      ? 1
                      : event.key === 'End'
                        ? lines
                        : null;
              if (target === null) return;
              event.preventDefault();
              onLineChange(target);
              (
                event.currentTarget.parentElement?.children[target - 1] as
                  HTMLButtonElement | undefined
              )?.focus();
            }}
            aria-label={`Ask about ${filePath} line ${index + 1}`}
            onClick={() => onLineChange(line === index + 1 ? null : index + 1)}
            className={`flex min-h-9 w-full items-start gap-4 rounded-lg border-0 px-3 py-2 text-left font-mono text-xs ${line === index + 1 ? 'bg-mint/10 text-mint' : 'bg-transparent text-cream hover:bg-cream/5'}`}
          >
            <span
              className="w-7 shrink-0 text-right text-cream/50"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <code className="whitespace-pre">{text || ' '}</code>
          </button>
        ))}
      </div>
      {line ? (
        <p className="mb-0 mt-3 break-all font-mono text-xs text-mint">
          {filePath}:{line} · submitted version
        </p>
      ) : (
        <p className="mb-0 mt-3 text-xs text-cream/65">
          Select a line to attach a precise reference.
        </p>
      )}
    </div>
  );
}
