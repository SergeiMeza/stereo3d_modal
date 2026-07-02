import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { UserMenu } from "@/components/auth/UserMenu";
import { AuthProvider } from "@/lib/auth";
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

export const metadata: Metadata = {
  title: "Stereo3D Studio",
  description: "Professional 2D-to-3D conversion workspace",
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
            <nav className="flex h-12 w-full items-center gap-6 px-4">
              <Link
                href="/projects"
                className="font-semibold tracking-tight text-fg"
              >
                Stereo3D&nbsp;
                <span className="text-primary">Studio</span>
              </Link>
              <Link
                href="/projects"
                className="text-fg-muted transition-colors hover:text-fg"
              >
                Projects
              </Link>
              <UserMenu />
            </nav>
          </header>
          {/* Screens own their container: the workspace is a full-bleed,
              viewport-height page (Resolve-style); list pages center
              themselves with mx-auto max-w-*. */}
          <main className="flex w-full flex-1 flex-col">
            <MswProvider>{children}</MswProvider>
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
