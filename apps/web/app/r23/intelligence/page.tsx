import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import {
  loadLifecycleReport,
  loadProductIntelligenceReport,
} from '../../../src/telemetry/server';
import { ThemeToggle } from '../../_components/theme-toggle';
import { IntelligenceDashboardClient } from './intelligence-dashboard-client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const metadata = {
  title: 'Product Intelligence',
  robots: { index: false, follow: false },
};

export default async function ProductIntelligencePage() {
  if (
    !isFounderUatEnabled() &&
    process.env.HIREARCHY_OPERATOR_ANALYTICS_ENABLED !== 'true'
  ) {
    notFound();
  }

  const [initialReport, initialLifecycle] = await Promise.all([
    loadProductIntelligenceReport(30),
    loadLifecycleReport(),
  ]);

  return (
    <div className="software-product software-document-body intel-page-shell">
      <a className="software-skip-link" href="#intelligence-main">
        Skip to Product Intelligence
      </a>
      <header className="software-document-header">
        <Link
          href="/r23/organizations"
          className="software-document-wordmark"
          aria-label="Hirearchy Software workspaces"
        >
          <span>Hirearchy</span>
          <span className="software-document-product">Software</span>
        </Link>
        <div className="software-header-controls">
          <Link href="/r23/organizations" className="hiring-btn hiring-btn-sm">
            Workspaces
          </Link>
          <ThemeToggle variant="header" />
        </div>
      </header>
      <main className="intel-main" id="intelligence-main" tabIndex={-1}>
        <IntelligenceDashboardClient
          initialReport={initialReport}
          initialLifecycle={initialLifecycle}
        />
      </main>
    </div>
  );
}
