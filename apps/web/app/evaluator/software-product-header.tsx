import { SoftwareMark } from '../../src/ui/software-mark';
import Link from 'next/link';
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
  const sessionSummaryHref = stagingReview
    ? `/r23/organizations/${encodeURIComponent(stagingReview.organizationId.toLowerCase())}/sessions/${encodeURIComponent(stagingReview.sessionId)}`
    : null;
  const reviewHref = stagingReview
    ? `/r27/organizations/${encodeURIComponent(stagingReview.organizationId.toLowerCase())}/sessions/${encodeURIComponent(stagingReview.sessionId)}`
    : null;

  return (
    <header className="software-product-header">
      <Link
        className="software-wordmark software-document-wordmark"
        href={
          sessionSummaryHref ??
          (tenantScope ? tenantScope.switchOrganizationHref : '/evaluator')
        }
        aria-label="Hirearchy Software home"
      >
        <SoftwareMark />
        <span>Hirearchy</span>
        <span className="software-document-product">Software</span>
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
      <nav aria-label="Evaluator workspace">
        {stagingReview && reviewHref && sessionSummaryHref ? (
          <>
            <Link
              className="software-nav-link"
              href={reviewHref}
              aria-current={active === 'reviews' ? 'page' : undefined}
            >
              Review
            </Link>
            <Link className="software-nav-link" href={sessionSummaryHref}>
              Session summary
            </Link>
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
    </header>
  );
};
