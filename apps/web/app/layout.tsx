import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono, Outfit } from 'next/font/google';
import { AppChrome } from '@/components/layout/AppChrome';
import { AuthSync } from '@/components/auth/AuthSync';
import { SignedOutGate } from '@/components/auth/SignedOutGate';
import '../styles/globals.css';

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
});

// Geometric display face that echoes the tapestr.ai wordmark
const brandDisplay = Outfit({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${ibmPlexSans.variable} ${brandDisplay.variable} ${ibmPlexMono.variable}`}>
      <body>
        <AuthSync />
        <SignedOutGate />
        <AppChrome>{children}</AppChrome>
      </body>
    </html>
  );
}
