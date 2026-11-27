'use client';

import { useSyncExternalStore } from 'react';
import {
  formatLocalDateTime,
  formatRelativeTime,
  formatUtcDateTime,
} from '../../src/ui/relative-time';

const subscribe = () => () => undefined;

export function LocalTime({
  timestamp,
  absolute = false,
}: Readonly<{
  timestamp: string;
  absolute?: boolean;
}>) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const exact = hydrated
    ? formatLocalDateTime(timestamp)
    : formatUtcDateTime(timestamp);

  return (
    <time dateTime={timestamp} title={absolute ? undefined : exact}>
      {absolute ? exact : hydrated ? formatRelativeTime(timestamp) : null}
    </time>
  );
}
