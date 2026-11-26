import type { Metadata } from 'next';
import {
  IBM_Plex_Mono,
  Plus_Jakarta_Sans,
  Public_Sans,
} from 'next/font/google';
import './globals.css';

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-jakarta-sans',
  display: 'swap',
});

const publicSans = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-public-sans',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'CRT Intelligence — XAUUSD Discretionary Market Monitor',
  description:
    'Stage 1 foundation shell for XAUUSD discretionary CRT market monitoring, diagnostics APIs, and isolated TradingView chart display.',
  openGraph: {
    title: 'CRT Intelligence',
    description:
      'Stage 1 foundation shell for XAUUSD discretionary CRT market monitoring, diagnostics APIs, and isolated TradingView chart display.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CRT Intelligence',
    description:
      'Stage 1 foundation shell for XAUUSD discretionary CRT market monitoring, diagnostics APIs, and isolated TradingView chart display.',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${plusJakartaSans.variable} ${publicSans.variable} ${ibmPlexMono.variable}`}
    >
      <body className="min-h-screen bg-[#0B0F14] font-sans text-[#E6EDF5] antialiased selection:bg-amber-500/25 selection:text-amber-100">
        {children}
      </body>
    </html>
  );
}
