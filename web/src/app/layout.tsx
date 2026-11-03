import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { Analytics as VercelAnalytics } from "@vercel/analytics/next";

import { Analytics } from "@/components/Analytics";
import { UserMenu } from "@/components/auth/UserMenu";
import { FeedbackLink } from "@/components/FeedbackLink";
import { Logo } from "@/components/Logo";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { SettleProvider } from "@/components/pay/SettleSheet";
import { SITE_TAGLINE, SITE_URL } from "@/lib/site";
import { MswProvider } from "@/mocks/MswProvider";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  `${SITE_TAGLINE}. Convert 2D videos to 3D: spatial video for Apple Vision Pro, side by side for Meta Quest, Pico and every 3D display. See the price before you start.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Stereo3D Studio — Convert 2D Video to 3D, the web version of Spatial Video Studio",
    template: "%s — Stereo3D Studio",
  },
  description,
  applicationName: "Stereo3D Studio",
  openGraph: {
    type: "website",
    siteName: "Stereo3D Studio",
    locale: "en_US",
    title: `Stereo3D Studio — ${SITE_TAGLINE}`,
    description,
    images: [
      {
        url: "/landing/og.jpg",
        width: 1200,
        height: 630,
        alt: "Stereo3D Studio: source footage next to its live depth map, with per-scene 3D controls",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `Stereo3D Studio — ${SITE_TAGLINE}`,
    description,
    images: ["/landing/og.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-surface-0 font-sans text-sm leading-tight text-fg">
        <AuthProvider>
          <header className="sticky top-0 z-40 border-b border-edge bg-surface-1/95 backdrop-blur">
            <nav className="mx-auto flex h-12 w-full max-w-[1700px] items-center gap-3 px-4 sm:gap-6">
              <Link
                href="/projects"
                className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-fg"
              >
                <Logo className="size-5" />
                <span>
                  Stereo3D&nbsp;
                  <span className="text-primary">Studio</span>
                </span>
              </Link>
              <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                Beta
              </span>
              <Link
                href="/projects"
                className="hidden text-fg-muted transition-colors hover:text-fg sm:block"
              >
                Projects
              </Link>
              <Link
                href="/pricing"
                className="hidden text-fg-muted transition-colors hover:text-fg sm:block"
              >
                Pricing
              </Link>
              <FeedbackLink />
              <UserMenu />
            </nav>
          </header>
          {/* The whole app is centered at one max width (wide enough that
              the NLE timeline breathes on big displays); narrower screens
              (max-w-7xl list pages) still center themselves inside it. The
              workspace stays viewport-height (Resolve-style) within it. */}
          <main className="mx-auto flex w-full max-w-[1700px] flex-1 flex-col">
            {/* BillingProvider sits inside MswProvider so its first
                GET /v1/billing waits for the mock worker in mock mode. */}
            <MswProvider>
              <BillingProvider>
                {/* P2: any "Pay $X" opens the settle sheet */}
                <SettleProvider>{children}</SettleProvider>
              </BillingProvider>
            </MswProvider>
          </main>
        </AuthProvider>
        <Analytics />
        <VercelAnalytics />
      </body>
    </html>
  );
}
