'use client';

import { useCallback, useEffect, useState } from 'react';

type MailKind =
  'confirmation' | 'recovery' | 'peer_review_request' | 'peer_review_response';
type MailMessage = {
  id: string;
  recipient: string;
  subject: string;
  receivedAt: string;
  kind: MailKind;
};

function isMailKind(value: unknown): value is MailKind {
  return (
    value === 'confirmation' ||
    value === 'recovery' ||
    value === 'peer_review_request' ||
    value === 'peer_review_response'
  );
}

function isMailMessage(value: unknown): value is MailMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === 'string' &&
    typeof message.recipient === 'string' &&
    typeof message.subject === 'string' &&
    typeof message.receivedAt === 'string' &&
    isMailKind(message.kind)
  );
}

function mailKindHeading(kind: MailKind): string {
  switch (kind) {
    case 'confirmation':
      return 'Account confirmation';
    case 'recovery':
      return 'Password recovery';
    case 'peer_review_request':
      return 'Peer review requested';
    case 'peer_review_response':
      return 'Peer review submitted';
  }
}

function mailKindActionLabel(kind: MailKind): string {
  switch (kind) {
    case 'confirmation':
      return 'Confirm email';
    case 'recovery':
      return 'Reset password';
    case 'peer_review_request':
      return 'Open peer review';
    case 'peer_review_response':
      return 'View peer review';
  }
}

export function FounderUatMailInbox({
  email,
  candidate,
  next,
}: Readonly<{ email: string; candidate: boolean; next: string | null }>) {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null);

  const fetchInbox = useCallback(async (targetEmail: string) => {
    try {
      const query = new URLSearchParams({ email: targetEmail });
      const response = await fetch(`/api/founder-uat/mail?${query}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Inbox unavailable');
      const result: unknown = await response.json();
      const items =
        result && typeof result === 'object' && 'messages' in result
          ? (result as { messages?: unknown }).messages
          : null;
      if (!Array.isArray(items)) throw new Error('Invalid inbox response');
      setMessages(items.filter(isMailMessage));
      setStatus('ready');
    } catch {
      setMessages([]);
      setError('The local inbox is unavailable. Try refreshing again shortly.');
      setStatus('error');
    }
  }, []);

  const visibleMessages = candidate
    ? messages.filter(
        (message) =>
          message.kind === 'confirmation' || message.kind === 'recovery',
      )
    : messages;

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    await fetchInbox(email);
  }, [email, fetchInbox]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchInbox(email);
  }, [email, fetchInbox]);

  const consume = async (
    event: React.FormEvent<HTMLFormElement>,
    messageId: string,
  ) => {
    event.preventDefault();
    setBusyMessageId(messageId);
    setError(null);

    try {
      const body = new URLSearchParams({ email, messageId });
      if (candidate) body.set('audience', 'candidate');
      if (next) body.set('next', next);
      const response = await fetch('/api/founder-uat/mail/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'same-origin',
        body,
      });
      const destination = new URL(response.url, window.location.href);
      if (destination.origin !== window.location.origin) {
        throw new Error('Unexpected redirect');
      }
      if (!response.ok) {
        setError(
          'We could not process this email. Refresh the inbox and try again.',
        );
        setBusyMessageId(null);
        return;
      }
      window.location.assign(destination.href);
    } catch {
      setError(
        'This email could not be opened. Refresh the inbox and try again.',
      );
      setBusyMessageId(null);
    }
  };

  return (
    <section
      className="software-mail-messages"
      aria-label={`Messages for ${email}`}
    >
      <div className="software-mail-toolbar">
        <p>
          <strong>Inbox:</strong> {email}
        </p>
        <button
          className="software-button software-button-secondary"
          disabled={status === 'loading' || busyMessageId !== null}
          onClick={() => void refresh()}
          type="button"
        >
          {status === 'loading' ? 'Checking inbox…' : 'Refresh inbox'}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {status === 'loading' ? (
        <p role="status">Checking for new messages…</p>
      ) : null}
      {status === 'ready' && visibleMessages.length === 0 ? (
        <p role="status">
          {candidate
            ? 'No messages yet. After requesting confirmation, refresh this inbox.'
            : 'No messages yet. Account confirmations, recovery emails, and team peer-review notifications appear here.'}
        </p>
      ) : null}
      {visibleMessages.length > 0 ? (
        <ul aria-label="Local email messages">
          {visibleMessages.map((message) => (
            <li key={message.id}>
              <p>
                <strong>{mailKindHeading(message.kind)}</strong>
              </p>
              <p>{message.subject}</p>
              <p>
                Sent to <strong>{message.recipient}</strong>
                {Number.isFinite(Date.parse(message.receivedAt)) ? (
                  <>
                    {' '}
                    <time dateTime={message.receivedAt}>
                      {new Date(message.receivedAt).toLocaleString()}
                    </time>
                  </>
                ) : null}
              </p>
              <form
                action="/api/founder-uat/mail/consume"
                method="post"
                onSubmit={(event) => void consume(event, message.id)}
              >
                <input name="email" type="hidden" value={email} />
                <input name="messageId" type="hidden" value={message.id} />
                {candidate ? (
                  <input type="hidden" name="audience" value="candidate" />
                ) : null}
                {next ? <input type="hidden" name="next" value={next} /> : null}
                <button
                  className="software-button software-button-primary"
                  disabled={busyMessageId !== null}
                  type="submit"
                >
                  {busyMessageId === message.id
                    ? 'Opening…'
                    : mailKindActionLabel(message.kind)}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
