export function candidateAssessmentPath(value: unknown): string | null {
  return typeof value === 'string' &&
    /^\/r26\/candidate\/sess_[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

export function candidateSignInPath(
  next: unknown,
  verified = false,
): '/candidate/login' | `/candidate/login?${string}` {
  const query = new URLSearchParams();
  const assessment = candidateAssessmentPath(next);
  if (assessment) query.set('next', assessment);
  if (verified) query.set('verified', '1');
  return query.size ? `/candidate/login?${query}` : '/candidate/login';
}

export function candidateConfirmationParams(
  email: string,
  next: unknown,
): URLSearchParams {
  const query = new URLSearchParams({ email, audience: 'candidate' });
  const assessment = candidateAssessmentPath(next);
  if (assessment) query.set('next', assessment);
  return query;
}
