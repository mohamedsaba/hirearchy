import Link from 'next/link';
import { ThemeToggle } from '../_components/theme-toggle';
import './software-product-header.css';

export interface SoftwareProductHeaderTenantScope {
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly membershipRole: string;
  readonly userEmail: string;
  readonly switchOrganizationHref: string;
  readonly signOutAction: string;
  readonly csrfToken?: string;
}

export interface SoftwareProductHeaderStagingReview {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly compact?: boolean;
}

export const SoftwareProductHeader = ({
  active,
  tenantScope,
  stagingReview,
  readOnlyMode = false,
}: Readonly<{
  active: 'assessments' | 'reviews';
  tenantScope?: SoftwareProductHeaderTenantScope;
  stagingReview?: SoftwareProductHeaderStagingReview;
  readOnlyMode?: boolean;
}>) => {
  const allowIssuance = !readOnlyMode && !tenantScope;
  const organizationHref = stagingReview
    ? `/r23/organizations/${encodeURIComponent(stagingReview.organizationId.toLowerCase())}`
    : null;
  const sessionSummaryHref =
    stagingReview && organizationHref
      ? `${organizationHref}/sessions/${encodeURIComponent(stagingReview.sessionId)}`
      : null;
  const workspaceHref =
    organizationHref && stagingReview?.compact
      ? `${organizationHref}/candidates`
      : (sessionSummaryHref ??
        tenantScope?.switchOrganizationHref ??
        '/evaluator');

  return (
    <header
      className="software-product-header"
      data-compact-review={stagingReview?.compact || undefined}
    >
      <Link
        className="software-wordmark"
        href={workspaceHref}
        aria-label="Hirearchy Software home"
      >
        <span>Hirearchy</span>
        <span className="software-product-capsule">
          {stagingReview?.compact ? 'Evaluator' : 'Software'}
        </span>
      </Link>
      {tenantScope ? (
        <div
          className="software-tenant-badge"
          role="region"
          aria-label="Active organization"
        >
          <span className="software-tenant-org">
            {tenantScope.organizationName}
          </span>{' '}
          <span className="software-tenant-slug">
            ({tenantScope.organizationSlug})
          </span>{' '}
          <span className="software-tenant-role">
            Role: {tenantScope.membershipRole}
          </span>{' '}
          <span className="software-tenant-email">{tenantScope.userEmail}</span>
        </div>
      ) : null}
      <nav
        aria-label={
          stagingReview?.compact
            ? 'Related review pages'
            : 'Evaluator workspace'
        }
      >
        {stagingReview && sessionSummaryHref ? (
          <>
            <Link
              className={
                stagingReview.compact
                  ? 'software-review-related-link'
                  : 'software-nav-link'
              }
              href={sessionSummaryHref}
            >
              {stagingReview.compact ? 'Session details' : 'Session summary'}
            </Link>
            {stagingReview.compact ? null : (
              <Link
                className="software-nav-link"
                href={`/r27/organizations/${encodeURIComponent(stagingReview.organizationId.toLowerCase())}/sessions/${encodeURIComponent(stagingReview.sessionId)}`}
                aria-current={active === 'reviews' ? 'page' : undefined}
              >
                Evidence review
              </Link>
            )}
          </>
        ) : (
          <>
            <Link
              className="software-nav-link"
              href="/evaluator/assessments"
              aria-current={active === 'assessments' ? 'page' : undefined}
            >
              Assessments
            </Link>
            <Link
              className="software-nav-link"
              href="/evaluator"
              aria-current={active === 'reviews' ? 'page' : undefined}
            >
              Reviews
            </Link>
          </>
        )}
        {tenantScope ? (
          <>
            <Link
              className="software-nav-link"
              href={tenantScope.switchOrganizationHref}
            >
              Switch organization
            </Link>
            <form
              action={tenantScope.signOutAction}
              method="post"
              className="software-header-signout-form"
            >
              {tenantScope.csrfToken ? (
                <input
                  type="hidden"
                  name="csrf"
                  value={tenantScope.csrfToken}
                />
              ) : null}
              <button
                type="submit"
                className="software-nav-link software-header-signout-btn"
              >
                Sign out
              </button>
            </form>
          </>
        ) : null}
        {allowIssuance ? null : null}
      </nav>
      <div className="software-header-controls">
        <ThemeToggle variant="header" />
      </div>
    </header>
  );
};
