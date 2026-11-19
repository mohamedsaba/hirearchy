import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './styles.css';
import '../public/software-ui.css';
import '../public/hiring-platform.css';
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
const THEME_BOOTSTRAP_SCRIPT = `(() => {
  try {
    var m = document.cookie.match(/(?:^|;\\s*)hirearchy-theme=(dark|light)/);
    var t = (m && m[1]) || window.localStorage.getItem('hirearchy-theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
      document.documentElement.style.colorScheme = t;
    }
  } catch (e) {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className={dmSans.variable}>
        {children}
        <IntentPrefetch />
      </body>
    </html>
  );
}
