import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { UserMenu } from "@/components/auth/UserMenu";
import { FeedbackLink } from "@/components/FeedbackLink";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
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

/** Absolute base for OG/twitter image URLs. Vercel injects the prod
 * domain; NEXT_PUBLIC_SITE_URL can override (e.g. a custom domain). */
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Stereo3D Studio",
  description:
    "Studio-grade 2D-to-3D video conversion. Direct the depth scene by scene and deliver spatial video to Apple Vision Pro, Meta Quest, Samsung Galaxy XR and every 3D display — pay per render, with a binding quote up front.",
  openGraph: {
    title: "Stereo3D Studio — VFX-studio 3D, without the VFX studio",
    description:
      "Upload a video, direct the depth scene by scene, and deliver true stereoscopic 3D to every headset.",
    images: ["/landing/stereo-tab.webp"],
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
                className="shrink-0 font-semibold tracking-tight text-fg"
              >
                Stereo3D&nbsp;
                <span className="text-primary">Studio</span>
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
              <BillingProvider>{children}</BillingProvider>
            </MswProvider>
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
