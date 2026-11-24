export function candidateAssessmentPath(value: unknown): string | null {
  return typeof value === 'string' &&
    /^\/r26\/candidate\/sess_[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

export function candidateEntryPath(value: unknown): string | null {
  return (
    candidateAssessmentPath(value) ??
    (typeof value === 'string' &&
    /^\/candidate\/submissions\/sess_[A-Za-z0-9_-]{1,128}$/.test(value)
      ? value
      : null)
  );
}

export function candidateSignInPath(
  next: unknown,
  verified = false,
): '/candidate/login' | `/candidate/login?${string}` {
  const query = new URLSearchParams();
  const entry = candidateEntryPath(next);
  if (entry) query.set('next', entry);
  if (verified) query.set('verified', '1');
  return query.size ? `/candidate/login?${query}` : '/candidate/login';
}

export function candidateConfirmationParams(
  email: string,
  next: unknown,
): URLSearchParams {
  const query = new URLSearchParams({ email, audience: 'candidate' });
  const entry = candidateEntryPath(next);
  if (entry) query.set('next', entry);
  return query;
}
