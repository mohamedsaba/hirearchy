'use client';

import { useState } from 'react';
import Link from 'next/link';
import { IconArrowRight, IconCheck, IconCopy } from '@tabler/icons-react';

import {
  flushClientTelemetry,
  trackClientEvent,
} from '../../../../src/telemetry/client';

export function CandidateReceiptShare() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const handleExploreDemo = () => {
    trackClientEvent({
      eventName: 'candidate_receipt.demo_clicked',
      category: 'acquisition',
      actorType: 'candidate',
      route: '/candidate/submissions/:sessionId',
      properties: { source: 'candidate_receipt' },
    });
    flushClientTelemetry();
  };

  const handleCopyTeamLink = async () => {
    if (typeof window === 'undefined' || !navigator.clipboard) {
      setCopyError(true);
      return;
    }
    const productUrl = `${window.location.origin}/products/software`;
    const snippet = [
      'Hirearchy Software — real codebase engineering assessments with zero webcam proctoring and human-owned reviews.',
      productUrl,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setCopyError(false);
      trackClientEvent({
        eventName: 'candidate_receipt.team_link_copied',
        category: 'acquisition',
        actorType: 'candidate',
        route: '/candidate/submissions/:sessionId',
        properties: { source: 'candidate_receipt' },
      });
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <section
      className="hiring-card hiring-card-subtle hiring-mt-md"
      aria-labelledby="candidate-receipt-share-heading"
      data-testid="candidate-receipt-share"
    >
      <span className="hiring-eyebrow">For engineering teams</span>
      <h2 id="candidate-receipt-share-heading" className="hiring-mt-xs">
        Hiring engineers on your own team?
      </h2>
      <p className="hiring-muted-copy hiring-mt-xs">
        Enjoyed a realistic, proctor-free assessment? Share how Hirearchy works
        with your engineering manager or team. Links contain zero referral codes
        or personal submission details.
      </p>
      <div className="hiring-header-actions hiring-mt-sm">
        <Link
          href="/demo?src=candidate_receipt"
          className="hiring-btn hiring-btn-sm"
          onClick={handleExploreDemo}
        >
          Explore live evaluator demo{' '}
          <IconArrowRight size={14} aria-hidden="true" />
        </Link>
        <button
          type="button"
          className="hiring-btn hiring-btn-sm"
          onClick={() => void handleCopyTeamLink()}
        >
          {copied ? (
            <IconCheck size={14} aria-hidden="true" />
          ) : (
            <IconCopy size={14} aria-hidden="true" />
          )}
          {copied ? 'Link copied for your team' : 'Copy link for your team'}
        </button>
      </div>
      {copyError ? (
        <p className="hiring-muted-copy hiring-mt-xs">
          Unable to copy automatically — share <code>/products/software</code>{' '}
          directly.
        </p>
      ) : null}
    </section>
  );
}
