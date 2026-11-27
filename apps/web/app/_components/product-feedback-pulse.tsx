'use client';

import { useEffect, useState } from 'react';
import { IconCheck, IconMessageStar, IconSend } from '@tabler/icons-react';

import type { ProductFeedbackSurface } from '../../src/telemetry/catalog';
import { submitProductFeedback } from '../../src/telemetry/client';

const RATING_LABELS = [
  { value: 1, label: '1 · Poor' },
  { value: 2, label: '2 · Rough' },
  { value: 3, label: '3 · Okay' },
  { value: 4, label: '4 · Good' },
  { value: 5, label: '5 · Great' },
] as const;

export interface ProductFeedbackPulseProps {
  readonly surface: ProductFeedbackSurface;
  readonly actorType: 'candidate' | 'team_member';
  readonly title: string;
  readonly privacyNote?: string;
  readonly tags: readonly string[];
  readonly organizationId?: string;
  readonly sessionId?: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  readonly storageKey: string;
}

export function ProductFeedbackPulse({
  surface,
  actorType,
  title,
  privacyNote,
  tags,
  organizationId,
  sessionId,
  context,
  storageKey,
}: ProductFeedbackPulseProps) {
  const [rating, setRating] = useState<number | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        if (window.sessionStorage.getItem(storageKey) === 'submitted') {
          setSubmitted(true);
        }
      } catch {
        // Ignore storage unavailability
      }
    });
    return () => {
      active = false;
    };
  }, [storageKey]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag)
        ? prev.filter((item) => item !== tag)
        : prev.length >= 6
          ? prev
          : [...prev, tag],
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!rating || submitting) return;
    setSubmitting(true);
    const res = await submitProductFeedback({
      actorType,
      surface,
      organizationId,
      sessionId,
      rating,
      tags: selectedTags,
      comment,
      context,
    });
    setSubmitting(false);
    if (res.ok) {
      setSubmitted(true);
      try {
        window.sessionStorage.setItem(storageKey, 'submitted');
      } catch {
        // Ignore storage errors
      }
    }
  };

  if (submitted) {
    return (
      <aside
        className="hiring-feedback-pulse hiring-feedback-pulse--done"
        role="status"
      >
        <IconCheck size={16} stroke={2.2} aria-hidden="true" />
        <span>Thank you — your feedback helps improve Hirearchy Software.</span>
      </aside>
    );
  }

  return (
    <aside
      className="hiring-feedback-pulse"
      aria-label={title}
      data-testid={`feedback-pulse-${surface}`}
    >
      <div className="hiring-feedback-pulse-header">
        <IconMessageStar size={16} aria-hidden="true" />
        <div>
          <strong>{title}</strong>
          {privacyNote ? (
            <p className="hiring-feedback-pulse-note">{privacyNote}</p>
          ) : null}
        </div>
      </div>

      <div
        className="hiring-feedback-rating-row"
        role="group"
        aria-label="Rating from 1 to 5"
      >
        {RATING_LABELS.map((item) => {
          const active = rating === item.value;
          return (
            <button
              key={item.value}
              type="button"
              className={`hiring-feedback-rate-btn${active ? ' is-selected' : ''}`}
              aria-pressed={active}
              onClick={() => setRating(item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {rating !== null ? (
        <form className="hiring-feedback-pulse-form" onSubmit={handleSubmit}>
          <div
            className="hiring-chip-group"
            role="group"
            aria-label="Quick tags"
          >
            {tags.map((tag) => {
              const active = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={`hiring-chip${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => toggleTag(tag)}
                >
                  {active ? (
                    <IconCheck size={13} stroke={2.4} aria-hidden="true" />
                  ) : null}
                  {tag}
                </button>
              );
            })}
          </div>
          <label className="hiring-field">
            <span className="hiring-field-label">Optional note</span>
            <textarea
              rows={2}
              maxLength={800}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Tell us what worked well or what slowed you down..."
            />
          </label>
          <div className="hiring-feedback-pulse-actions">
            <button
              type="submit"
              className="hiring-btn hiring-btn-primary hiring-btn-sm"
              disabled={submitting}
            >
              <IconSend size={14} aria-hidden="true" />{' '}
              {submitting ? 'Sending…' : 'Send feedback'}
            </button>
          </div>
        </form>
      ) : null}
    </aside>
  );
}
