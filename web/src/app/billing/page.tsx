/**
 * The gateway's plan checkout returns to /billing?plan=… (hosted page);
 * Billing lives at /account/billing.
 */

import { redirect } from "next/navigation";

export default async function BillingRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") q.set(k, v);
  }
  const s = q.toString();
  redirect(`/account/billing${s ? `?${s}` : ""}`);
}
