export const CANDIDATE_SUBMISSION_PATH =
  /^\/candidate\/submissions\/sess_[A-Za-z0-9_-]{1,128}$/;

export function candidateAssessmentPath(value: unknown): string | null {
  return typeof value === 'string' &&
    /^\/r26\/candidate\/sess_[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

export function candidateEntryPath(value: unknown): string | null {
  return (
    candidateAssessmentPath(value) ??
    (typeof value === 'string' && CANDIDATE_SUBMISSION_PATH.test(value)
      ? value
      : null)
  );
}

export type CandidateSignInOptions =
  | boolean
  | Readonly<{
      verified?: boolean;
      reset?: boolean;
    }>;

export function candidateSignInPath(
  next: unknown,
  verifiedOrOptions: CandidateSignInOptions = false,
): '/candidate/login' | `/candidate/login?${string}` {
  const options =
    typeof verifiedOrOptions === 'boolean'
      ? { verified: verifiedOrOptions, reset: false }
      : verifiedOrOptions;
  const query = new URLSearchParams();
  const entry = candidateEntryPath(next);
  if (entry) query.set('next', entry);
  if (options.verified) query.set('verified', '1');
  if (options.reset) query.set('reset', '1');
  return query.size ? `/candidate/login?${query}` : '/candidate/login';
}

export function candidateRecoveryPath(next: unknown): `/r23/recover?${string}` {
  const query = new URLSearchParams({ audience: 'candidate' });
  const entry = candidateEntryPath(next);
  if (entry) query.set('next', entry);
  return `/r23/recover?${query}`;
}

export function candidateResetPasswordPath(
  next: unknown,
  extra?: Readonly<{ error?: string }>,
): `/r23/reset-password?${string}` {
  const query = new URLSearchParams({ audience: 'candidate' });
  const entry = candidateEntryPath(next);
  if (entry) query.set('next', entry);
  if (extra?.error) query.set('error', extra.error);
  return `/r23/reset-password?${query}`;
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
