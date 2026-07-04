import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { UserMenu } from "@/components/auth/UserMenu";
import { FeedbackLink } from "@/components/FeedbackLink";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { SITE_URL } from "@/lib/site";
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
  "Convert 2D video to true stereoscopic 3D — spatial video for Apple Vision Pro, SBS for Meta Quest and every 3D display. Pay per render with a binding quote.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Stereo3D Studio — Convert 2D Video to 3D for VR Headsets",
    template: "%s — Stereo3D Studio",
  },
  description,
  applicationName: "Stereo3D Studio",
  openGraph: {
    type: "website",
    siteName: "Stereo3D Studio",
    locale: "en_US",
    title: "Stereo3D Studio — VFX-studio 3D, without the VFX studio",
    description:
      "Upload a video, direct the depth scene by scene, and deliver true stereoscopic 3D to every headset.",
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
    title: "Stereo3D Studio — VFX-studio 3D, without the VFX studio",
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
