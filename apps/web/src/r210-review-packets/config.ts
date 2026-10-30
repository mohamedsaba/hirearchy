export function r210IsEnabled(): boolean {
  if (typeof window !== 'undefined') {
    return (
      process.env.NEXT_PUBLIC_R210_ENABLE_REVIEW_PACKETS !== 'false' &&
      process.env.R210_ENABLE_REVIEW_PACKETS !== 'false'
    );
  }
  return (
    process.env.R210_ENABLE_REVIEW_PACKETS !== 'false' &&
    process.env.NEXT_PUBLIC_R210_ENABLE_REVIEW_PACKETS !== 'false'
  );
}
