"use client";

/**
 * /app's one button (WEB-02): "Open the web app", to the landing page.
 * The tap is an app_intro_open_click event carrying the app's utm_content
 * (which card: settings, intro, cloud_project, whats_new) and utm_term
 * (platform-version) when the address has them. The address itself is
 * left alone, so Vercel Analytics keeps the whole utm set.
 *
 * `start` skips the landing page (owner 2026-11-11, /vision-pro): the
 * button goes to /projects with a session and /signin without one, as the
 * landing page's own button does.
 */

import Link from "next/link";
import type { JSX } from "react";

import { track, type EventParams } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";

/** utm_content and utm_term from a query string, when present. */
export function appIntroParams(search: string): EventParams {
  const q = new URLSearchParams(search);
  const params: EventParams = {};
  for (const key of ["utm_content", "utm_term"]) {
    const v = q.get(key);
    if (v) params[key] = v;
  }
  return params;
}

export function OpenWebAppButton({
  label,
  start = false,
}: {
  label: string;
  start?: boolean;
}): JSX.Element {
  const { user } = useAuth();
  const href = !start ? "/" : user !== null ? "/projects" : "/signin";
  return (
    <Link
      href={href}
      data-testid="app-intro-open"
      onClick={() => track("app_intro_open_click", appIntroParams(window.location.search))}
      className="inline-flex min-h-14 w-full items-center justify-center rounded-lg bg-primary px-8 py-4 text-base font-medium text-primary-foreground transition-colors hover:bg-primary/80 sm:w-auto"
    >
      {label}
    </Link>
  );
}
