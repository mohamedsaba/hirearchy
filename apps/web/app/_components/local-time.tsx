'use client';

import { useSyncExternalStore } from 'react';
import {
  formatLocalDateTime,
  formatRelativeTime,
} from '../../src/ui/relative-time';

const subscribe = () => () => undefined;

export function LocalTime({ timestamp }: Readonly<{ timestamp: string }>) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  return (
    <time
      dateTime={timestamp}
      title={hydrated ? formatLocalDateTime(timestamp) : undefined}
    >
      {hydrated ? formatRelativeTime(timestamp) : null}
    </time>
  );
}
