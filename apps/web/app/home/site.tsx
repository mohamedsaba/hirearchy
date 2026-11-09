import type { ReactNode } from 'react';
import Link from 'next/link';
import { Motion } from './motion';
import { PageNavigator } from './page-navigator';

export function Arrow() {
  return (
    <svg
      className="ct-arrow"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 12h15m-6-6 6 6-6 6"
        pathLength="1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function Icon({ type = 'task' }: { type?: string }) {
  return (
    <svg
      className={`ct-symbol ct-symbol--${type}`}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {type === 'task' ? (
        <>
          <path d="M8 3h11l6 6v20H8zM19 3v7h6M12 15h9M12 20h9M12 25h6" />
        </>
      ) : type === 'software' ? (
        <>
          <path className="ct-code-left" d="m10 8-7 8 7 8" />
          <path className="ct-code-right" d="m22 8 7 8-7 8" />
          <path className="ct-code-caret" d="m18 5-4 22" />
        </>
      ) : type === 'it' ? (
        <>
          <path
            className="ct-network-trace"
            pathLength="1"
            d="M16 10v6M16 16H6v6M16 16h10v6"
          />
          <rect x="11" y="3" width="10" height="7" rx="2" />
          <rect x="2" y="22" width="8" height="7" rx="2" />
          <rect x="22" y="22" width="8" height="7" rx="2" />
          <circle
            className="ct-network-node"
            cx="16"
            cy="16"
            r="2"
            fill="currentColor"
            stroke="none"
          />
        </>
      ) : type === 'marketing' ? (
        <>
          <path d="M4 12h7L23 5v22l-12-7H4zM8 20l3 8h5l-3-7M11 12v8" />
          <path className="ct-campaign-wave" d="M27 11q4 5 0 10" />
          <path className="ct-campaign-spark" d="m28 4 2-2m-2 26 2 2" />
        </>
      ) : type === 'work' ? (
        <path d="m6 25 2-7L23 3l6 6-15 15-8 1zm3-8 6 6M20 6l6 6" />
      ) : type === 'record' ? (
        <path d="M5 6h22M5 11h15M5 16h22M5 21h12M5 26h18" />
      ) : type === 'discussion' ? (
        <path d="M5 5h22v17H13l-8 6zM10 11h12M10 16h8" />
      ) : (
        <>
          <circle cx="16" cy="10" r="5" />
          <path d="M6 28c0-12 20-12 20 0z" />
        </>
      )}
    </svg>
  );
}
export function ProductCaption({
  children,
  action,
}: {
  children: ReactNode;
  action: string;
}) {
  return (
    <small className="ct-product-caption">
      <span>{children}</span>
      <span aria-hidden="true">{action}</span>
    </small>
  );
}
export function Button({
  href,
  children,
  light = false,
}: {
  href: string;
  children: ReactNode;
  light?: boolean;
}) {
  return (
    <Link
      className={`ct-button${light ? ' ct-button--light' : ''}`}
      href={href}
      prefetch={false}
    >
      {children}
      <Arrow />
    </Link>
  );
}
export function Kicker({ children }: { children: ReactNode }) {
  return <p className="ct-kicker">{children}</p>;
}
export function Header() {
  return (
    <header className="ct-header">
      <Link
        className="ct-wordmark"
        href="/"
        aria-label="Hirearchy home"
        prefetch={false}
      >
        Hirearchy
      </Link>
      <nav className="ct-nav" aria-label="Main navigation">
        <Link href="/products" prefetch={false}>
          Products
        </Link>
        <Link href="/thinking" prefetch={false}>
          Our thinking
        </Link>
        <Link href="/about" prefetch={false}>
          About
        </Link>
        <Link className="ct-mobile-contact" href="/contact" prefetch={false}>
          Contact
        </Link>
      </nav>
      <Link className="ct-start" href="/products/software" prefetch={false}>
        Explore Software
      </Link>
    </header>
  );
}
export function Footer() {
  return (
    <footer className="ct-footer" id="site-footer" data-chapter="Explore">
      <div className="ct-footer-brand">
        <Link href="/" aria-label="Hirearchy home" prefetch={false}>
          Hirearchy
        </Link>
        <p>Real work. In context.</p>
      </div>
      <nav aria-label="Footer navigation">
        <Link href="/products" prefetch={false}>
          Products
        </Link>
        <Link href="/thinking" prefetch={false}>
          Our thinking
        </Link>
        <Link href="/about" prefetch={false}>
          About
        </Link>
        <Link href="/contact" prefetch={false}>
          Contact
        </Link>
      </nav>
      <p className="ct-motto">
        A clearer
        <br />
        tomorrow
        <br />
        through work.
        <span />
      </p>
      <small>
        © {new Date().getFullYear()} Hirearchy. All rights reserved.
      </small>
      <div className="ct-legal">
        <Link href="/privacy" prefetch={false}>
          Privacy
        </Link>
        <Link href="/terms" prefetch={false}>
          Terms
        </Link>
      </div>
    </footer>
  );
}
export function Site({
  children,
  home = false,
  dark = false,
}: {
  children: ReactNode;
  home?: boolean;
  dark?: boolean;
}) {
  return (
    <div
      className={`ct-site${home ? ' ct-home' : ' ct-inner'}${dark || home ? ' ct-dark-header' : ''}`}
    >
      <a href="#main" className="ct-skip">
        Skip to content
      </a>
      <Header />
      <main id="main">{children}</main>
      <Footer />
      <Motion />
      <PageNavigator />
    </div>
  );
}
export function Path({
  d,
  color = 'mint',
  className = '',
  width = 20,
}: {
  d: string;
  color?: string;
  className?: string;
  width?: number;
}) {
  return (
    <path
      className={`ct-thread ct-thread--${color} ${className}`}
      d={d}
      pathLength="1"
      fill="none"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}
export function ContactCta({
  title = 'Evaluate real engineering work with Hirearchy.',
}: {
  title?: string;
}) {
  return (
    <section className="ct-contact-cta ct-reveal">
      <Kicker>Early access interest</Kicker>
      <h2>{title}</h2>
      <p>
        Tell us you are interested in early access. A request records interest
        only; it does not create an account or guarantee access.
      </p>
      <div
        className="ct-contact-links"
        style={{ justifyContent: 'center', marginTop: '20px' }}
      >
        <Button href="/early-access">Request early access</Button>
      </div>
    </section>
  );
}
