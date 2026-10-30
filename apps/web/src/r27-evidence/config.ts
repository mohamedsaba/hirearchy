import { r26IsEnabled } from '../r26-candidate/config';

export function r27IsEnabled(): boolean {
  return process.env.HIREARCHY_R27_DISPOSABLE === '1' && r26IsEnabled();
}
