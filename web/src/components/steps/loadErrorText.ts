/**
 * What a failed load says (owner 2026-11-04): never the gateway's raw "not
 * found"; on the finished sample every failure reads "The sample isn't
 * available right now."
 */

import { GatewayError } from "@/lib/api/client";
import { EN, type Tr } from "@/lib/i18n/t";

/** The sample line in English (kept for older callers). */
export const SAMPLE_UNAVAILABLE = EN("files.load.sampleUnavailable");

/** The words for a failed load: the sample line on the sample, the
 * fallback for a 404 or anything without a message, else the message. */
export function loadErrorText(
  e: unknown,
  sample: boolean,
  fallback: string,
  t: Tr = EN,
): string {
  if (sample) return t("files.load.sampleUnavailable");
  if (e instanceof GatewayError && e.status === 404) return fallback;
  if (e instanceof Error && e.message && !/not found/i.test(e.message))
    return e.message;
  return fallback;
}
