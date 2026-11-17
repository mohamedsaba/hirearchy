'use client';

import { MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';

export function EditorialMotion({ children }: { children: ReactNode }) {
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      {children}
    </MotionConfig>
  );
}
