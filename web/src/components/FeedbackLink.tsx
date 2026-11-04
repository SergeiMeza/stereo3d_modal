"use client";

/**
 * Feedback in the app (owner 2026-11-04, like the SVS mobile app): the
 * header's Feedback button (an icon on phones) opens a dialog — kind,
 * message (required, up to 5000), email (prefilled when signed in,
 * required when signed out), "It's OK to contact me", and "Include this
 * page" (the route plus the project and run ids when there are any). It
 * posts to POST /v1/feedback, with the account's token when signed in.
 * Success says "Thanks, we read every message." and closes; a failure
 * (429 too) keeps every word and points to support. The draft also
 * survives a reload in this tab. Other places open it with
 * openFeedback().
 */

import { MessageSquare } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeedbackKind } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { SUPPORT_EMAIL } from "@/lib/contact";

const OPEN_EVENT = "svs:feedback";
const DRAFT_KEY = "svs-feedback-draft";
export const MESSAGE_MAX = 5000;

/** Open the feedback dialog from anywhere on the page. */
export function openFeedback(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const KINDS: readonly { id: FeedbackKind; label: string }[] = [
  { id: "idea", label: "Idea" },
  { id: "problem", label: "Problem" },
  { id: "other", label: "Something else" },
];

interface Draft {
  kind: FeedbackKind;
  message: string;
  email: string | null;
  ok: boolean;
  page: boolean;
}

const EMPTY: Draft = {
  kind: "idea",
  message: "",
  email: null,
  ok: true,
  page: true,
};

function loadDraft(): Draft {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function saveDraft(d: Draft): void {
  try {
    if (d.message === "" && d.email === null)
      window.sessionStorage.removeItem(DRAFT_KEY);
    else window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    // the text stays in the dialog while the page is open
  }
}

/** The page's context: route, plus project and run ids when present. */
export function pageContext(
  pathname: string,
  search: string,
  hash: string,
): {
  route: string;
  project_id?: string;
  run_id?: string;
} {
  const project = /^\/projects\/([^/?#]+)/.exec(pathname)?.[1];
  const params = new URLSearchParams(search);
  const run =
    params.get("run") ??
    params.get("conversion") ??
    params.get("conversion_id") ??
    /(?:^|[#&])run=([^&]+)/.exec(hash)?.[1] ??
    undefined;
  return {
    route: pathname,
    ...(project ? { project_id: decodeURIComponent(project) } : {}),
    ...(run ? { run_id: decodeURIComponent(run) } : {}),
  };
}

export function FeedbackLink(): JSX.Element {
  const gateway = useGateway();
  const { user } = useAuth();
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  // the dialog starts closed, so a restored draft never differs on hydration
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [state, setState] = useState<"idle" | "sending" | "failed" | "sent">(
    "idle",
  );

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const change = (patch: Partial<Draft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    saveDraft(next);
    if (state === "failed") setState("idle");
  };

  const email = draft.email ?? user?.email ?? "";
  const signedIn = user !== null;
  const message = draft.message.trim();
  const canSend =
    message.length > 0 &&
    draft.message.length <= MESSAGE_MAX &&
    (signedIn || /\S+@\S+\.\S+/.test(email)) &&
    state !== "sending";

  async function send(): Promise<void> {
    setState("sending");
    try {
      await gateway.sendFeedback(
        {
          kind: draft.kind,
          message,
          ...(email.trim() ? { email: email.trim() } : {}),
          ok_to_contact: draft.ok,
          context: {
            ...(draft.page
              ? pageContext(
                  pathname,
                  window.location.search,
                  window.location.hash,
                )
              : { route: "" }),
            locale: navigator.language || "en",
          },
        },
        { signedIn },
      );
      saveDraft(EMPTY);
      setDraft(EMPTY);
      setState("sent");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Send feedback"
        data-testid="feedback-open"
        onClick={() => {
          if (state === "sent") setState("idle");
          setOpen(true);
        }}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-primary/60 hover:text-fg"
      >
        <MessageSquare aria-hidden className="size-3.5" />
        <span className="hidden sm:inline">Feedback</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="feedback-dialog"
          className="sm:max-w-[480px]"
        >
          {state === "sent" ? (
            <>
              <DialogHeader>
                <DialogTitle>Thanks, we read every message.</DialogTitle>
                <DialogDescription className="sr-only">
                  Your feedback was sent.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSend) void send();
              }}
            >
              <DialogHeader>
                <DialogTitle>Send feedback</DialogTitle>
                <DialogDescription>
                  Ideas, problems, anything. A person reads it.
                </DialogDescription>
              </DialogHeader>
              <div
                role="radiogroup"
                aria-label="Kind"
                className="flex flex-wrap gap-2"
              >
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="radio"
                    aria-checked={draft.kind === k.id}
                    data-testid={`feedback-kind-${k.id}`}
                    onClick={() => change({ kind: k.id })}
                    className={`min-h-9 rounded-full border px-3.5 text-sm ${
                      draft.kind === k.id
                        ? "border-primary bg-primary/10 text-fg"
                        : "border-edge text-fg-muted hover:text-fg"
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Message
                <textarea
                  required
                  rows={5}
                  maxLength={MESSAGE_MAX}
                  data-testid="feedback-message"
                  value={draft.message}
                  onChange={(e) => change({ message: e.target.value })}
                  className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-fg"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                {signedIn ? "Email" : "Your email"}
                <input
                  type="email"
                  required={!signedIn}
                  data-testid="feedback-email"
                  value={email}
                  onChange={(e) => change({ email: e.target.value })}
                  className="rounded-md border border-edge bg-surface-2 px-3 py-2 text-sm text-fg"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  data-testid="feedback-ok"
                  checked={draft.ok}
                  onChange={(e) => change({ ok: e.target.checked })}
                  className="size-4 accent-primary"
                />
                It&apos;s OK to contact me
              </label>
              <label className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  data-testid="feedback-page"
                  checked={draft.page}
                  onChange={(e) => change({ page: e.target.checked })}
                  className="size-4 accent-primary"
                />
                Include this page
              </label>
              {state === "failed" ? (
                <p
                  role="alert"
                  data-testid="feedback-error"
                  className="text-sm text-destructive"
                >
                  Couldn&apos;t send. You can also write to{" "}
                  <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
                    {SUPPORT_EMAIL}
                  </a>
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="submit"
                  data-testid="feedback-send"
                  disabled={!canSend}
                >
                  {state === "sending" ? "Sending…" : "Send"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
