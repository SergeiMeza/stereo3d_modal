"use client";

/**
 * The sales contact form (gateway 00094 POST /v1/contact): message,
 * company and team size (optional questions, not promises). 400/429 show
 * the gateway's words; a mailto with the same words only when the route
 * itself fails. Used by the Talk to us banner and the Business setup.
 */

import { useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { FEEDBACK_EMAIL } from "@/lib/contact";

export function ContactSalesForm({
  onSent,
  onCancel,
  onSend,
}: {
  onSent: () => void;
  onCancel: () => void;
  /** tracking, when Send is pressed */
  onSend?: () => void;
}): JSX.Element {
  const gateway = useGateway();
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    onSend?.();
    try {
      await gateway.contactSales({
        topic: "business",
        message: message.trim(),
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(teamSize.trim() ? { team_size: teamSize.trim() } : {}),
      });
      onSent();
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
      onSent();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="font-medium text-fg">Talk to us</p>
      <p className="text-xs text-fg-muted">
        A person replies by email, usually within a working day. Your projects
        stay open while you wait.
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
            placeholder="e.g. 4"
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
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
