/**
 * What a failed load says (owner 2026-11-04): never the gateway's raw "not
 * found"; on the finished sample every failure reads "The sample isn't
 * available right now."
 */

import { GatewayError } from "@/lib/api/client";

export const SAMPLE_UNAVAILABLE = "The sample isn't available right now.";

/** The words for a failed load: the sample line on the sample, the
 * fallback for a 404 or anything without a message, else the message. */
export function loadErrorText(
  e: unknown,
  sample: boolean,
  fallback: string,
): string {
  if (sample) return SAMPLE_UNAVAILABLE;
  if (e instanceof GatewayError && e.status === 404) return fallback;
  if (e instanceof Error && e.message && !/not found/i.test(e.message))
    return e.message;
  return fallback;
}
