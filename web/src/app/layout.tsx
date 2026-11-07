import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";


import { Analytics } from "@/components/Analytics";
import { VercelAnalyticsScrubbed } from "@/components/VercelAnalyticsScrubbed";
import { PasskeySuggestion } from "@/components/auth/PasskeySuggestion";
import { ReauthSheet } from "@/components/auth/ReauthSheet";
import { DeletionPrompt } from "@/components/auth/DeletionPrompt";
import { UserMenu } from "@/components/auth/UserMenu";
import { FeedbackLink } from "@/components/FeedbackLink";
import { LiveEvents } from "@/components/live/LiveEvents";
import { ProCheckoutHost } from "@/components/pro/ProCheckoutHost";
import { AppIcon } from "@/components/AppIcon";
import { HeaderPlans } from "@/components/plans/HeaderPlans";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { SettleProvider } from "@/components/pay/SettleSheet";
import { BalanceDialogsProvider } from "@/components/pay/BalanceDialogs";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { MswProvider } from "@/mocks/MswProvider";
import { messagesFor } from "@/lib/i18n/catalogs";
import { I18nProvider } from "@/lib/i18n/I18nProvider";
import { HlParamCleanup } from "@/lib/i18n/HlParamCleanup";
import { dirOf } from "@/lib/i18n/locales";
import { getRequestLocale, getServerTr } from "@/lib/i18n/server";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getServerTr();
  const description = t("meta.site.description", { site: SITE_NAME });
  const ogTitle = t("meta.site.ogTitle", { site: SITE_NAME });
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: t("meta.site.title", { site: SITE_NAME }),
      template: `%s — ${SITE_NAME}`,
    },
    description,
    applicationName: SITE_NAME,
    // which build is live: <meta name="build" content="8f2fe30"> (Vercel's
    // commit, read on the server; "local" in dev and tests)
    other: { build: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7) },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: t.intl.replace("-", "_"),
      title: ogTitle,
      description,
      images: [
        {
          url: "/landing/og.jpg",
          width: 1200,
          height: 630,
          alt: t("meta.site.ogImageAlt", { site: SITE_NAME }),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: ["/landing/og.jpg"],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // owner 2026-11-07: NEXT_LOCALE, then Accept-Language, then English
  const locale = await getRequestLocale();
  const t = await getServerTr();
  return (
    <html
      lang={locale}
      dir={dirOf(locale)}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-surface-0 font-sans text-sm leading-tight text-fg">
        <I18nProvider locale={locale} messages={messagesFor(locale)}>
        <HlParamCleanup />
        <AuthProvider>
          {/* BillingProvider sits inside MswProvider so its first
              GET /v1/billing waits for the mock worker in mock mode; the
              header is inside both for the plans link (owner 2026-11-04). */}
          <MswProvider>
          <BillingProvider>
          <header className="sticky top-0 z-40 border-b border-edge bg-surface-1 pointer-fine:bg-surface-1/95 pointer-fine:backdrop-blur">
            {/* owner 2026-11-07 (foldable): the header never makes the page
                wider than the screen (Safari then lays fixed sheets out on
                the wider page and they slide off the left edge) */}
            <nav className="mx-auto flex h-12 w-full max-w-[1700px] items-center gap-2 px-4 min-[400px]:gap-3 sm:gap-6">
              <Link
                href="/projects"
                className="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-fg"
              >
                <AppIcon className="size-6" />
                <span className="max-[379px]:sr-only">
                  Spatial Video&nbsp;
                  <span className="text-primary">Studio</span>
                </span>
              </Link>
              <Link
                href="/projects"
                className="hidden text-fg-muted transition-colors hover:text-fg sm:block"
              >
                {t("common.header.projects")}
              </Link>
              {/* plans canvas, Header B: Plans + "Save 15–25%" */}
              <HeaderPlans />
              {/* owner 2026-11-04: Feedback sits on the right, beside Sign in
                  (icon only on phones, labelled for screen readers) */}
              <div className="ms-auto flex min-w-0 items-center gap-2">
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
          {/* owner 2026-11-07: an account set to be deleted asks first */}
          <DeletionPrompt />
          {/* owner 2026-11-07: the one live status stream (lib/live) */}
          <LiveEvents />
          </BillingProvider>
          </MswProvider>
        </AuthProvider>
        </I18nProvider>
        <Analytics />
        {/* REV-15: pay links reach it as /pay/[token] */}
        <VercelAnalyticsScrubbed />
      </body>
    </html>
  );
}
