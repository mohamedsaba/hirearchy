export function r28IsEnabled(): boolean {
  return (
    process.env.HIREARCHY_R28_DISPOSABLE === '1' ||
    process.env.HIREARCHY_R27_DISPOSABLE === '1'
  );
}
