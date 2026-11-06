import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { Analytics as VercelAnalytics } from "@vercel/analytics/next";

import { Analytics } from "@/components/Analytics";
import { PasskeySuggestion } from "@/components/auth/PasskeySuggestion";
import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { UserMenu } from "@/components/auth/UserMenu";
import { FeedbackLink } from "@/components/FeedbackLink";
import { ProCheckoutHost } from "@/components/pro/ProCheckoutHost";
import { AppIcon } from "@/components/AppIcon";
import { HeaderPlans } from "@/components/plans/HeaderPlans";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { SettleProvider } from "@/components/pay/SettleSheet";
import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";
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
    default: "Spatial Video Studio on the web — Convert 2D Video to 3D",
    template: "%s — Spatial Video Studio",
  },
  description,
  applicationName: SITE_NAME,
  // which build is live: <meta name="build" content="8f2fe30"> (Vercel's
  // commit, read on the server; "local" in dev and tests)
  other: { build: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7) },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    title: `${SITE_TAGLINE}: turn any video into lifelike 3D`,
    description,
    images: [
      {
        url: "/landing/og.jpg",
        width: 1200,
        height: 630,
        alt: "Spatial Video Studio on the web: turn any video into lifelike 3D, up to 8K, for Vision Pro and every headset",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_TAGLINE}: turn any video into lifelike 3D`,
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
          {/* BillingProvider sits inside MswProvider so its first
              GET /v1/billing waits for the mock worker in mock mode; the
              header is inside both for the plans link (owner 2026-11-04). */}
          <MswProvider>
          <BillingProvider>
          <header className="sticky top-0 z-40 border-b border-edge bg-surface-1 pointer-fine:bg-surface-1/95 pointer-fine:backdrop-blur">
            <nav className="mx-auto flex h-12 w-full max-w-[1700px] items-center gap-3 px-4 sm:gap-6">
              <Link
                href="/projects"
                className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-fg"
              >
                <AppIcon className="size-6" />
                <span>
                  Spatial Video&nbsp;
                  <span className="text-primary">Studio</span>
                </span>
              </Link>
              <Link
                href="/projects"
                className="hidden text-fg-muted transition-colors hover:text-fg sm:block"
              >
                Projects
              </Link>
              {/* plans canvas, Header B: Plans + "Save 15–25%" */}
              <HeaderPlans />
              {/* owner 2026-11-04: Feedback sits on the right, beside Sign in
                  (icon only on phones, labelled for screen readers) */}
              <div className="ml-auto flex min-w-0 items-center gap-2">
                <FeedbackLink />
                <UserMenu />
              </div>
            </nav>
          </header>
          {/* The whole app is centered at one max width (wide enough that
              the NLE timeline breathes on big displays); narrower screens
              (max-w-7xl list pages) still center themselves inside it. The
              workspace stays viewport-height (Resolve-style) within it. */}
          <main className="mx-auto flex w-full max-w-[1700px] flex-1 flex-col">
            {/* ADR 0136: "Add a passkey" once after a sign-in */}
            <PasskeySuggestion />
            {/* P2: any "Pay $X" opens the settle sheet */}
            <SettleProvider>
              <BalanceDialogsProvider>{children}</BalanceDialogsProvider>
            </SettleProvider>
          </main>
          {/* owner 2026-11-04: web Pro's own checkout sheet (useBuyPro) */}
          <ProCheckoutHost />
          {/* owner 2026-11-06: "Confirm it's you" for sensitive requests */}
          <ReauthSheet />
          </BillingProvider>
          </MswProvider>
        </AuthProvider>
        <Analytics />
        <VercelAnalytics />
      </body>
    </html>
  );
}
