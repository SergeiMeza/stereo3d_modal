/**
 * Billing lives at /account/billing. The plan checkout returns there
 * directly since gateway 00083; this stays for mails and other returns
 * that still point at /billing.
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
