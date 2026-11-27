import type { Metadata } from 'next';
import { DemoClient } from './demo-client';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Interactive Evaluator Demo — Hirearchy Software',
  description:
    'Explore a real candidate code evaluation workspace without signing up. Inspect chronological file diffs, test runs, neutral workspace AI logs, and human-owned verdicts.',
};

export default function PublicDemoPage() {
  const selfServiceEnabled =
    process.env.HIREARCHY_SELF_SERVICE_ONBOARDING_ENABLED === 'true';
  const ctaHref = selfServiceEnabled ? '/r23/signup' : '/early-access';
  const ctaLabel = selfServiceEnabled
    ? 'Create free org workspace'
    : 'Request early access';

  return <DemoClient ctaHref={ctaHref} ctaLabel={ctaLabel} />;
}
