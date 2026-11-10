import {
  isFounderUatEnabled,
  readFounderUatProfileConfiguration,
} from './profile';

export { isFounderUatEnabled };

export const FOUNDER_UAT_CONFIRMATION_SUBJECT =
  'Hirearchy account confirmation';
export const FOUNDER_UAT_RECOVERY_SUBJECT = 'Hirearchy password recovery';

export type FounderUatConfiguration = Readonly<{
  appOrigin: URL;
  authUrl: URL;
  authIssuer: string;
  authAudience: string;
  databaseUrl: string;
  mailpitApiUrl: URL;
}>;

export function readFounderUatConfiguration(): FounderUatConfiguration | null {
  const config = readFounderUatProfileConfiguration();
  if (!config) return null;
  return Object.freeze({
    ...config,
    databaseUrl: config.databaseUrl.toString(),
  });
}

export function founderUatMailInboxUrl(email: string): string | null {
  if (!isFounderUatEnabled() || !isValidFounderUatEmail(email)) return null;
  return `/r23/mail?email=${encodeURIComponent(email.trim().toLowerCase())}`;
}

export function getFounderUatAutomationRunId(): string | null {
  if (!isFounderUatEnabled()) return null;
  const runId = process.env.FOUNDER_UAT_AUTOMATION_RUN_ID;
  return runId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      runId,
    )
    ? runId
    : null;
}

export function isValidFounderUatEmail(email: string): boolean {
  const value = email.trim();
  return value.length <= 320 && /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/.test(value);
}

export function founderUatPostMatchesOrigin(
  request: Request,
  config: FounderUatConfiguration,
): boolean {
  return request.headers.get('origin') === config.appOrigin.origin;
}
