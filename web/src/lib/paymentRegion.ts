/**
 * Whether payments take the China path (S3D-61): no payment-form script,
 * Alipay and WeChat Pay through the gateway. Its own module so the
 * payment UI can be tested in China mode without switching the rest.
 */

import { currentRegion } from "@/lib/region";

export function chinaPayments(): boolean {
  return currentRegion() === "cn";
}
