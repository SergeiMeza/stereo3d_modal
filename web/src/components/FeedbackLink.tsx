/**
 * Global "Feedback" affordance for the beta: a mailto link in the app
 * header (rendered on every page via the root layout), so users can always
 * reach us. Plain <a> — no client JS needed.
 */

import { MessageSquare } from "lucide-react";
import type { JSX } from "react";

export const FEEDBACK_EMAIL = "sergei@spatial-ai-labs.com";

const MAILTO = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
  "Stereo3D Studio feedback",
)}`;

export function FeedbackLink(): JSX.Element {
  return (
    <a
      href={MAILTO}
      aria-label="Send feedback"
      className="ml-auto flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-primary/60 hover:text-fg"
    >
      <MessageSquare aria-hidden className="size-3.5" />
      <span className="hidden sm:inline">Feedback</span>
    </a>
  );
}
