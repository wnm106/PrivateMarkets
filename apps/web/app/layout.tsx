import type { Metadata } from 'next';
import { Inter, IBM_Plex_Mono } from 'next/font/google';
import { AppChrome } from '@/components/layout/AppChrome';
import { AuthSync } from '@/components/auth/AuthSync';
import { ErrorReporter } from '@/components/layout/ErrorReporter';
import { loadAppNav } from '@/lib/surface-access-server';
import 'katex/dist/katex.min.css';
import '../styles/globals.css';

// Single UI face: Inter has tabular numerals and stays legible at 11-13px in dense grids.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'tapestr.ai - Master Data Management',
  description: 'Bi-temporal financial Master Data Management platform for private markets investments',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nav = await loadAppNav();
  return (
    <html lang="en" className={`${inter.variable} ${ibmPlexMono.variable}`}>
      <body>
        <AuthSync />
        <ErrorReporter />
        <AppChrome surfaceLinks={nav.surfaceLinks} enabledToolHrefs={nav.enabledToolHrefs}>{children}</AppChrome>
      </body>
    </html>
  );
}
