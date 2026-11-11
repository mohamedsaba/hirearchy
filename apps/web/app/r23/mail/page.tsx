import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isFounderUatEnabled } from '../../../src/runtime/founder-uat';
import { FounderUatMailInbox } from './mail-inbox';
import '../../evaluator/evaluator-product.css';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function FounderUatMailPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ email?: string | string[] }>;
}>) {
  if (!isFounderUatEnabled()) notFound();

  const params = await searchParams;
  const email = typeof params.email === 'string' ? params.email.trim() : '';

  return (
    <main className="software-product evaluator-product-shell software-mail-page">
      <header className="software-product-header">
        <Link
          className="software-wordmark"
          href="/"
          aria-label="Hirearchy home"
        >
          <span className="software-brand-mark" aria-hidden="true" />
          <span>
            Hirearchy<span className="software-brand-period">.</span>
          </span>
        </Link>
      </header>
      <div className="evaluator-product-content">
        <section className="evaluator-page-intro" aria-labelledby="mail-title">
          <div>
            <p className="software-eyebrow">Local email</p>
            <h1 id="mail-title">Check your inbox</h1>
            <p>
              Confirm your account or recover access. Messages stay on this
              machine during local testing.
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
          {email ? <FounderUatMailInbox email={email} /> : null}
        </section>
        <p>
          <Link href="/r23/login">Return to sign in</Link>
        </p>
      </div>
    </main>
  );
}
