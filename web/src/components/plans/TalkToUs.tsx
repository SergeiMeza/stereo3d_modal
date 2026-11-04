"use client";

/**
 * Business nudge C (plans canvas, 2026-11-04): a "Talk to us" banner on
 * Projects, only for company email addresses (not gmail, outlook, icloud,
 * yahoo, qq, 163… — PERSONAL_DOMAINS), and not for Business or Studio.
 * Talk to us opens a small form (message, company, team size) that posts
 * to POST /v1/contact (gateway 00094); a person replies to the account's
 * email. A mailto with the same words only when the route itself fails
 * (network, 404, 5xx); 400 and 429 show the gateway's message. Dismissed
 * for 30 days (kept on the account).
 */

import { X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { FEEDBACK_EMAIL } from "@/lib/contact";
import { formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { usePricing } from "@/lib/api/usePricing";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";

import {
  isCompanyEmail,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

export function TalkToUs(): JSX.Element | null {
  const { user } = useAuth();
  const gateway = useGateway();
  const tier = usePlanTier();
  const biz = usePricing()?.plans?.business;
  const { dismissed, dismiss } = useDismissal("business_banner", 30);
  const [step, setStep] = useState<"banner" | "form" | "sent">("banner");
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const show =
    (tier === "none" || tier === "pro") &&
    dismissed === false &&
    isCompanyEmail(user?.email) &&
    !!biz;
  useViewEvent("business_banner", tier, show, {
    variant: "talk_to_us",
    reason: "company_email",
  });
  const send = usePaywallEvents("business_banner", tier, {
    variant: "talk_to_us",
    reason: "company_email",
  });
  if (!show || !biz) return null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    send("click", { target: "send" });
    try {
      await gateway.contactSales({
        topic: "business",
        message: message.trim(),
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(teamSize.trim() ? { team_size: teamSize.trim() } : {}),
      });
      setStep("sent");
    } catch (e) {
      if (e instanceof GatewayError && (e.status === 400 || e.status === 429)) {
        setError(
          e.status === 429
            ? e.message ||
                "Too many messages today. Please write to support instead."
            : "Please check the message and try again.",
        );
        return;
      }
      // the route itself failed: the person's own mail app, same words
      const body = [
        message.trim(),
        company.trim() && `Company: ${company.trim()}`,
        teamSize.trim() && `Team size: ${teamSize.trim()}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
        "Spatial Video Studio Business",
      )}&body=${encodeURIComponent(body)}`;
      setStep("sent");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="talk-to-us"
      className="flex flex-col gap-3 rounded-lg border border-edge bg-surface-1 px-4 py-3 text-sm"
    >
      {step === "banner" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-60 flex-1 text-fg">
            Using Spatial Video Studio at work? Business gives {biz.seats}{" "}
            people {formatCentsShort(biz.credit_cents)} of usage a month,
            commercial use and invoices.
          </p>
          <Button
            size="sm"
            data-testid="talk-to-us-open"
            onClick={() => {
              send("click", { target: "talk" });
              setStep("form");
            }}
          >
            Talk to us
          </Button>
          <Link
            href="/plans"
            onClick={() => send("click", { target: "/plans" })}
            className="text-primary hover:underline"
          >
            See Business
          </Link>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              send("dismiss");
              dismiss();
            }}
            className="rounded p-0.5 text-fg-muted hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : step === "form" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="font-medium text-fg">Talk to us</p>
          <p className="text-xs text-fg-muted">
            A person replies by email, usually within a working day. Your
            projects stay open while you wait.
          </p>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            What do you make, and how much a month?
            <textarea
              required
              rows={3}
              maxLength={2000}
              data-testid="talk-to-us-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="About 20 short music videos a month, 4K, for Vision Pro and Quest."
              className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-fg"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-muted">
              Company (optional)
              <input
                maxLength={120}
                data-testid="talk-to-us-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-fg"
              />
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-fg-muted">
              Team size (optional)
              <input
                maxLength={120}
                data-testid="talk-to-us-team"
                value={teamSize}
                onChange={(e) => setTeamSize(e.target.value)}
                placeholder="3 people"
                className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-fg"
              />
            </label>
          </div>
          {error ? (
            <p
              role="alert"
              data-testid="talk-to-us-error"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy || !message.trim()}
              data-testid="talk-to-us-send"
            >
              Send
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setStep("banner")}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <p data-testid="talk-to-us-sent" className="text-fg">
          Thanks. We&apos;ll reply to {user?.email ?? "your account email"}.
        </p>
      )}
    </section>
  );
}
