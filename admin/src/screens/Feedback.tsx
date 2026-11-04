import { useState } from "react";

import { ErrorState, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { useServices } from "../lib/services";
import type { FeedbackItem } from "../lib/types";
import { useLoad } from "../lib/useLoad";

const KINDS: Record<string, string> = { idea: "Idea", problem: "Problem", other: "Something else" };
const PLATFORMS: Record<string, string> = { web: "Web", ios: "iPhone/iPad", macos: "Mac", visionos: "Vision Pro", app: "App" };

/** Feedback (owner 2026-11-04): what people sent from the web app and the
 * apps, read only, newest first. */
export function FeedbackPanel() {
  const { api } = useServices();
  const [days, setDays] = useState(30);
  const [platform, setPlatform] = useState("");
  const { state, retry } = useLoad(() => api.feedback(days, platform), [api, days, platform]);
  return (
    <>
      <div className="titlebar">
        <h1>Feedback</h1>
        <span className="muted small">From the web app and the apps · read only</span>
        <span className="grow" />
        <select className="fsel" aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">Web and app</option>
          <option value="web">Web</option>
          <option value="app">App</option>
        </select>
        <select className="fsel" aria-label="Days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the feedback." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <List items={state.data.items ?? []} />}
    </>
  );
}

function List({ items }: { items: FeedbackItem[] }) {
  if (items.length === 0) return <p className="muted pad">No feedback in this window.</p>;
  return (
    <section className="card">
      <div className="scroll-x">
        <table className="at" data-testid="feedback-list">
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Kind</th>
              <th>Message</th>
              <th>Contact</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id}>
                <td className="xs">{dateTime(f.created_at)}</td>
                <td>
                  {PLATFORMS[f.platform] ?? f.platform}
                  {f.app_version ? <span className="xs muted"> {f.app_version}</span> : null}
                </td>
                <td>{KINDS[f.kind] ?? f.kind}</td>
                <td style={{ whiteSpace: "pre-wrap", maxWidth: 480 }}>{f.message}</td>
                <td className="xs">
                  {f.email ?? "—"}
                  {f.email ? <span className="muted">{f.ok_to_contact ? " · OK to contact" : " · no contact"}</span> : null}
                </td>
                <td className="xs muted">
                  {[f.context?.route, f.context?.project_id && `project ${f.context.project_id}`, f.context?.run_id && `run ${f.context.run_id}`]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
