"use client";

/**
 * Vercel Analytics with pay links scrubbed (REV-15): /pay/{token} is
 * reported as /pay/[token], so a token never reaches the dashboard.
 */

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import type { JSX } from "react";

import { scrubUrl } from "@/lib/analytics";

export function scrubEvent(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: scrubUrl(event.url) };
}

export function VercelAnalyticsScrubbed(): JSX.Element {
  return <Analytics beforeSend={scrubEvent} />;
}
