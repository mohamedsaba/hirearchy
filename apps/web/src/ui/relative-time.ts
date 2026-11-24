const localDateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const localDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '—';
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 45 && diffSec >= -15) return 'Just now';
  if (diffSec >= 45 && diffSec < 3600) {
    const mins = Math.max(1, Math.round(diffSec / 60));
    return `${mins}m ago`;
  }
  if (diffSec >= 3600 && diffSec < 86400) {
    const hrs = Math.round(diffSec / 3600);
    return `${hrs}h ago`;
  }
  if (diffSec >= 86400 && diffSec < 7 * 86400) {
    const days = Math.round(diffSec / 86400);
    return `${days}d ago`;
  }
  return localDateFormatter.format(new Date(ts));
}

export function formatLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  return localDateTimeFormatter.format(new Date(ts));
}
