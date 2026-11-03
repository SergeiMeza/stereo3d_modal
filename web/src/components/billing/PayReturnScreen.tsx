"use client";

/**
 * Where a pay-now payment page (Alipay) sends the browser back (S3D-61):
 * polls the run until its payment is in, then returns to the project's
 * Make 3D page, where the tracker carries on.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { useGateway } from "@/lib/api/useGateway";

const POLL_MS = 2000;
/** give up after this long without the payment */
const GIVE_UP_MS = 30 * 60 * 1000;

export function PayReturnScreen(): JSX.Element {
  const gateway = useGateway();
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("conversion");
  const project = params.get("project");
  const [state, setState] = useState<"waiting" | "paid" | "failed">("waiting");

  useEffect(() => {
    if (!id) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) {
        clearInterval(t);
        setState("failed");
        return;
      }
      gateway.getConversion(id).then(
        (c) => {
          if (c.state === "created") return;
          clearInterval(t);
          if (c.state === "canceled" || c.state === "expired" || c.state === "failed") {
            setState("failed");
            return;
          }
          setState("paid");
          if (project) router.replace(`/projects/${project}#tab=make`);
        },
        () => {},
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [gateway, id, project, router]);

  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">
        {state === "failed" ? "The payment didn't go through" : "Confirming your payment…"}
      </h1>
      <p data-testid="pay-return-state" className="text-sm text-fg-muted">
        {state === "failed"
          ? "Nothing was charged. You can try again from the project."
          : state === "paid"
            ? "Paid. Your run is starting."
            : "This takes a few seconds."}
      </p>
      {project ? (
        <Link href={`/projects/${project}#tab=make`} className="text-sm text-primary hover:underline">
          Back to the project
        </Link>
      ) : null}
    </section>
  );
}
