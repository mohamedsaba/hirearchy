export function r29IsEnabled(): boolean {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_HIREARCHY_R29_DISPOSABLE !== '0';
  }
  return (
    process.env.HIREARCHY_R29_DISPOSABLE === '1' ||
    process.env.NEXT_PUBLIC_HIREARCHY_R29_DISPOSABLE === '1' ||
    process.env.NODE_ENV === 'test'
  );
}
