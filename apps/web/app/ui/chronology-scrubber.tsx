'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useId, useMemo } from 'react';
import type { EvidenceSource } from '../evaluator/sessions/[sessionId]/evidence-workbench';

/** Ephemeral navigation over authoritative evidence order; no event classification from text. */
export function ChronologyScrubber({
  sources,
  selectedKey,
  onSelect,
}: {
  sources: readonly EvidenceSource[];
  selectedKey: string | null;
  onSelect: (source: EvidenceSource) => void;
}) {
  const id = useId();
  const reduced = useReducedMotion();
  const ordered = useMemo(
    () =>
      [...sources]
        .filter((source) => source.timestamp !== null)
        .sort((a, b) => a.chronologyOrder - b.chronologyOrder),
    [sources],
  );
  if (!ordered.length) return null;
  const milestoneIndices =
    ordered.length <= 5
      ? ordered.map((_, index) => index)
      : Array.from({ length: 5 }, (_, index) =>
          Math.round((index * (ordered.length - 1)) / 4),
        );
  const selectedIndex = Math.max(
    0,
    ordered.findIndex((source) => source.key === selectedKey),
  );
  const selected = ordered[selectedIndex];
  const progress =
    ordered.length > 1 ? (selectedIndex / (ordered.length - 1)) * 100 : 0;
  return (
    <section
      className="editorial-chronology min-w-0 rounded-2xl border border-cream/[0.12] bg-plum-elevated p-5 text-cream"
      aria-labelledby={`${id}-heading`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-heading`} className="m-0 text-sm font-semibold">
          The work, in order.
        </h2>
        <span className="text-xs text-cream/65">
          {selectedIndex + 1} / {ordered.length} recorded moments
        </span>
      </div>
      <div className="relative mt-5 px-1">
        <div
          className="absolute inset-x-1 top-[13px] h-1 rounded-full bg-cream/10"
          aria-hidden="true"
        >
          <motion.div
            className="h-full rounded-full bg-mint"
            animate={{ width: `${progress}%` }}
            transition={reduced ? { duration: 0 } : undefined}
          />
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, ordered.length - 1)}
          step={1}
          value={selectedIndex}
          onChange={(event) => onSelect(ordered[Number(event.target.value)])}
          aria-label="Inspect session chronology"
          aria-valuetext={`${selectedIndex + 1} of ${ordered.length}: ${selected.title}`}
          className="relative m-0 h-7 w-full cursor-pointer accent-mint"
        />
      </div>
      <div
        className="mt-3 grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${milestoneIndices.length}, minmax(0, 1fr))`,
        }}
        aria-label="Chronological source jump points"
      >
        {milestoneIndices.map((index) => (
          <button
            key={ordered[index].key}
            type="button"
            aria-pressed={selected.key === ordered[index].key}
            aria-label={`Inspect ${ordered[index].title}`}
            onClick={() => onSelect(ordered[index])}
            className={`min-h-11 min-w-0 rounded-xl border-0 px-2 py-3 text-left ${selected.key === ordered[index].key ? 'bg-mint/10 text-mint' : 'bg-transparent text-cream/60 hover:bg-cream/5'}`}
          >
            <span
              className="mb-2 block h-2 w-2 rounded-full bg-mint"
              aria-hidden="true"
            />
            <span className="block truncate text-[10px]">
              {ordered[index].title}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-start justify-between gap-4">
        <p className="m-0 min-w-0 break-words text-sm">
          <span className="mr-2 text-mint" aria-hidden="true">
            ●
          </span>
          {selected.title}
        </p>
        <time
          className="shrink-0 font-mono text-xs text-cream/65"
          dateTime={selected.timestamp ?? undefined}
        >
          {selected.timestamp
            ? new Date(selected.timestamp).toISOString().slice(11, 19)
            : ''}{' '}
          UTC
        </time>
      </div>
      <p className="mb-0 mt-2 text-xs text-cream/65">
        Select a moment to inspect its source. Recorded results inform the
        review; the decision stays human.
      </p>
    </section>
  );
}
