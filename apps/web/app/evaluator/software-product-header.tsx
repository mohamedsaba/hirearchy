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

export const SoftwareProductHeader = ({
  active,
  tenantScope,
  readOnlyMode = false,
}: Readonly<{
  active: 'assessments' | 'reviews';
  tenantScope?: SoftwareProductHeaderTenantScope;
  readOnlyMode?: boolean;
}>) => {
  const allowIssuance = !readOnlyMode && !tenantScope;

  return (
    <header className="software-product-header">
      <Link
        className="software-wordmark"
        href={tenantScope ? tenantScope.switchOrganizationHref : '/evaluator'}
        aria-label="Hirearchy Software home"
      >
        <span>Hirearchy</span>
        <span className="software-product-capsule">Software</span>
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
