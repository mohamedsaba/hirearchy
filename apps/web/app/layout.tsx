import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './styles.css';
import './software-ui.css';
import './workspace.css';
import './home.css';
import { IntentPrefetch } from './home/intent-prefetch';
const dmSans = localFont({
  src: '../public/fonts/dm-sans-latin.woff2',
  weight: '100 1000',
  variable: '--font-dm-sans',
  display: 'swap',
});
export const metadata: Metadata = {
  title: { default: 'Hirearchy', template: '%s | Hirearchy' },
  description:
    'A family of tools for seeing work clearly. Evidence informs. People decide.',
};
export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className={dmSans.variable}>
        {children}
        <IntentPrefetch />
      </body>
    </html>
  );
}
