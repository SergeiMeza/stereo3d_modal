"use client";

/**
 * P7 Pay on another device (spec v6 B17/G2): a headset (or a phone in
 * China mode, for WeChat Pay) hands the run's payment to a phone or
 * computer. One code per run (POST /v1/conversions/{id}/handoff): the
 * short link in big type, Email me the link, a small QR, the countdown,
 * and Pay here instead. The sheet follows the link through the live feed
 * (handoff.state, and the run itself) and closes once it's paid.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import type { HandoffStart } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useFallbackTick, useLiveHandoff, useLiveRunById } from "@/lib/live/useLive";

import { StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { EXPIRED, PAID_STARTING, WAITING_FOR_PAYMENT } from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

/** "stereo3d.studio/p/K7M2-QX9P" from the link. */
export function shortLink(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** "29:41" */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function HandoffSheet({
  conversionId,
  computerOnly = false,
  onPayHere,
  onClose,
}: {
  conversionId: string;
  /** China mode on a phone: WeChat Pay needs a computer */
  computerOnly?: boolean;
  /** back to paying on this device */
  onPayHere: () => void;
  onClose: (paid: boolean) => void;
}): JSX.Element {
  const gateway = useGateway();
  const big = useSheetFrame() === "headset";
  const [start, setStart] = useState<HandoffStart | null>(null);
  const [state, setState] = useState<"loading" | "open" | "paying" | "paid" | "expired" | "error">("loading");
  const [email, setEmail] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [masked, setMasked] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    gateway.createHandoff(conversionId).then(
      (h) => {
        if (!live) return;
        setStart(h);
        setState("open");
      },
      () => live && setState("error"),
    );
    return () => {
      live = false;
    };
  }, [gateway, conversionId]);

  // owner 2026-11-07: the link's state comes from the live feed
  // (handoff.state; the run leaving "created" means it's paid). A link
  // that closed (used or expired) is read once to say which; while the
  // stream is down its slow poll reads it again. Only the countdown ticks.
  const handoff = useLiveHandoff(start?.code ?? "");
  const run = useLiveRunById(conversionId);
  const settled = state === "paid" || state === "expired";
  if (!settled && start && run?.state !== undefined && run.state !== "created") setState("paid");
  else if (!settled && start && handoff?.state === "paying" && state !== "paying") setState("paying");
  const fallback = useFallbackTick();
  const closed = handoff?.state === "closed";
  useEffect(() => {
    if (!start || settled || (!closed && fallback === 0)) return;
    let live = true;
    gateway.getHandoff(start.code).then(
      (h) => {
        if (!live) return;
        if (h.state === "paid") setState("paid");
        else if (h.state === "expired") setState("expired");
        else if (h.state === "paying") setState("paying");
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // a closed link, or each slow poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, fallback, start]);
  useEffect(() => {
    if (!start || settled) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [start, settled]);

  useEffect(() => {
    if (state !== "paid") return;
    closing.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
    return () => {
      if (closing.current) clearTimeout(closing.current);
    };
  }, [state, onClose]);

  const left = start ? Date.parse(start.expires_at) - now : 0;
  const expired = state === "expired" || (start !== null && left <= 0);
  const title = computerOnly ? "Pay on a computer" : "Pay on your phone or computer";

  return (
    <SheetFrame
      open
      onClose={() => onClose(state === "paid")}
      testId="handoff-sheet"
      title={title}
      footer={
        expired ? (
          <Button size="lg" className="h-14 w-full text-xl" onClick={onPayHere}>
            Start again
          </Button>
        ) : state === "paid" ? null : (
          <button type="button" onClick={onPayHere} className={`w-full text-center text-primary hover:underline ${big ? "py-3 text-xl" : "text-sm"}`}>
            Pay here instead
          </button>
        )
      }
    >
      {state === "paid" ? (
        <Success text={PAID_STARTING} />
      ) : expired ? (
        <StateLine testId="handoff-expired" text={EXPIRED} />
      ) : state === "error" ? (
        <StateLine text="Payment isn't available in this region yet." />
      ) : !start ? (
        <div className="h-40 animate-pulse rounded-lg bg-surface-2" />
      ) : (
        <div className="flex flex-col items-center gap-5 text-center">
          <p className={big ? "text-xl text-fg-muted" : "text-sm text-fg-muted"}>Open this link:</p>
          <p data-testid="handoff-link" className="font-mono text-[40px] leading-tight tracking-tight break-all text-fg">
            {shortLink(start.url)}
          </p>
          <Button
            variant="outline"
            size="lg"
            className={big ? "h-14 text-xl" : "h-11"}
            disabled={email === "sending"}
            onClick={async () => {
              setEmail("sending");
              try {
                const h = await gateway.createHandoff(conversionId, true);
                setMasked(h.email_masked ?? null);
                setEmail("sent");
              } catch {
                setEmail("failed");
              }
            }}
          >
            Email me the link
          </Button>
          {email === "sent" ? (
            <p data-testid="handoff-email" className="text-sm text-fg">
              Sent to {masked ?? "your email"}.
            </p>
          ) : email === "failed" ? (
            <p className="text-sm text-red-400">Couldn&apos;t send the email. Try again.</p>
          ) : null}
          {start.qr_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={start.qr_image_url} alt="" className="size-28 rounded-md bg-white p-2" />
          ) : null}
          <p data-testid="handoff-state" className="flex items-center gap-2 text-sm text-fg">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-primary" />
            {state === "paying" ? "Paying on your other device…" : WAITING_FOR_PAYMENT}
          </p>
          <p data-testid="handoff-expires" className="text-xs text-fg-muted tabular-nums">
            Expires in {countdown(left)}
          </p>
        </div>
      )}
    </SheetFrame>
  );
}
