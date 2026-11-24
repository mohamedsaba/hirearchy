import Link from 'next/link';
import {
  candidateEntryPath,
  candidateSignInPath,
} from '../../../src/hiring/candidate-entry';
import { isHiringPlatformEnabled } from '../../../src/runtime/profile';
import { notFound } from 'next/navigation';
import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { ThemeToggle } from '../../_components/theme-toggle';
import { FounderUatMailInbox } from './mail-inbox';
import '../../evaluator/evaluator-product.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function FounderUatMailPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{
    email?: string | string[];
    audience?: string;
    next?: string;
  }>;
}>) {
  if (!isFounderUatEnabled()) notFound();

  const params = await searchParams;
  const email = typeof params.email === 'string' ? params.email.trim() : '';

  const candidate =
    isHiringPlatformEnabled() && params.audience === 'candidate';
  const next = candidate ? candidateEntryPath(params.next) : null;
  const signInPath = candidate ? candidateSignInPath(next) : '/r23/login';

  return (
    <main className="software-product evaluator-product-shell software-mail-page">
      <a className="software-skip-link" href="#mail-title">
        Skip to inbox
      </a>
      <header className="software-product-header">
        <Link
          className="software-wordmark"
          href={candidate ? signInPath : '/'}
          aria-label="Hirearchy home"
        >
          <span>Hirearchy</span>
          <span className="software-product-capsule">Software</span>
        </Link>
        <ThemeToggle variant="header" />
      </header>
      <div className="evaluator-product-content">
        <section className="evaluator-page-intro" aria-labelledby="mail-title">
          <div>
            <p className="software-eyebrow">Local email</p>
            <h1 id="mail-title">Check your inbox</h1>
            <p>
              {candidate
                ? 'Confirm your account. Messages stay on this machine during local testing.'
                : 'Confirm your account, recover access, or open team peer-review notifications. Messages stay on this machine during local testing.'}
            </p>
          </div>
        </section>
        <section
          className="evaluator-queue-panel"
          aria-labelledby="inbox-title"
        >
          <h2 id="inbox-title">Find your messages</h2>
          <form
            className="software-mail-open-form"
            action="/r23/mail"
            method="get"
          >
            {candidate ? (
              <input type="hidden" name="audience" value="candidate" />
            ) : null}
            {next ? <input type="hidden" name="next" value={next} /> : null}
            <label htmlFor="inbox-email">Email address</label>
            <input
              autoComplete="email"
              defaultValue={email}
              id="inbox-email"
              name="email"
              required
              type="email"
            />
            <button
              className="software-button software-button-primary"
              type="submit"
            >
              Open inbox
            </button>
          </form>
          {email ? (
            <FounderUatMailInbox
              email={email}
              candidate={candidate}
              next={next}
            />
          ) : null}
        </section>
        <p>
          <Link href={signInPath}>Return to sign in</Link>
        </p>
      </div>
    </main>
  );
}
