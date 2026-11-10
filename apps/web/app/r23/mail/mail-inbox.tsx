'use client';

import { useCallback, useEffect, useState } from 'react';

type MailKind = 'confirmation' | 'recovery';
type MailMessage = {
  id: string;
  recipient: string;
  subject: string;
  receivedAt: string;
  kind: MailKind;
};

function isMailMessage(value: unknown): value is MailMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === 'string' &&
    typeof message.recipient === 'string' &&
    typeof message.subject === 'string' &&
    typeof message.receivedAt === 'string' &&
    (message.kind === 'confirmation' || message.kind === 'recovery')
  );
}

export function FounderUatMailInbox({ email }: Readonly<{ email: string }>) {
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const query = new URLSearchParams({ email });
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
  }, [email]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const consume = async (
    event: React.FormEvent<HTMLFormElement>,
    messageId: string,
  ) => {
    event.preventDefault();
    setBusyMessageId(messageId);
    setError(null);

    try {
      const response = await fetch('/api/founder-uat/mail/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'same-origin',
        body: new URLSearchParams({ email, messageId }),
      });
      const destination = new URL(response.url, window.location.href);
      if (destination.origin !== window.location.origin) {
        throw new Error('Unexpected redirect');
      }
      if (!response.ok) {
        setError(
          'This email has expired or was already used. Refresh the inbox for the current message.',
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
    <section aria-label={`Messages for ${email}`}>
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
      {error ? <p role="alert">{error}</p> : null}
      {status === 'loading' ? (
        <p role="status">Checking for new messages…</p>
      ) : null}
      {status === 'ready' && messages.length === 0 ? (
        <p role="status">
          No messages yet. After requesting confirmation or recovery, refresh
          this inbox.
        </p>
      ) : null}
      {messages.length > 0 ? (
        <ul aria-label="Local email messages">
          {messages.map((message) => (
            <li key={message.id}>
              <p>
                <strong>
                  {message.kind === 'confirmation'
                    ? 'Account confirmation'
                    : 'Password recovery'}
                </strong>
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
                <button
                  className="software-button software-button-primary"
                  disabled={busyMessageId !== null}
                  type="submit"
                >
                  {busyMessageId === message.id
                    ? 'Opening…'
                    : message.kind === 'confirmation'
                      ? 'Confirm email'
                      : 'Reset password'}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
