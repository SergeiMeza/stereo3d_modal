import { Chip, ErrorState, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { money, pct, words } from "../lib/format";
import { useServices } from "../lib/services";
import { useLoad } from "../lib/useLoad";

/** The refund policy in force (C12). Read-only: it's edited in Firestore. */
export function PolicyPage() {
  const { api } = useServices();
  const { state, retry } = useLoad(() => api.policy(), [api]);
  return (
    <>
      <div className="titlebar">
        <h1>Refund policy</h1>
        {state.kind === "loaded" && (
          <span className="muted small">
            Read-only · edit in Firestore <span className="mono">{state.data.edit_in}</span> (changes are logged)
          </span>
        )}
      </div>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={2} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the policy." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && (() => {
        const p = state.data.policy;
        const exempt = new Set(p.cap_exempt ?? []);
        return (
          <div className="two">
            <section className="card">
              <div className="sh"><b>Reasons</b><span className="xs muted">unknown reasons are manual</span></div>
              <table className="at">
                <thead><tr><th>Reason</th><th>Mode</th><th>Cap</th></tr></thead>
                <tbody>
                  {Object.entries(p.reasons ?? {})
                    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
                    .map(([r, m]) => (
                      <tr key={r}>
                        <td className="mono">{r}</td>
                        <td><Chip tone={m === "auto" ? "green" : "amber"}>{m}</Chip></td>
                        <td className="muted">{exempt.has(r) ? "exempt" : m === "auto" ? `manual over ${money(p.manual_above_cents)}` : "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <div className="sh"><b>Settings</b></div>
              <dl className="kv pad">
                <dt>Manual above</dt><dd>{money(p.manual_above_cents)}</dd>
                <dt>Deadline</dt><dd>{p.deadline_business_days} business days</dd>
                <dt>Reminders</dt><dd>after {p.reminder_hours} h</dd>
                <dt>Time zone</dt><dd>{p.timezone}</dd>
                <dt>Dispute line</dt><dd>{pct(p.dispute_alert_pct)}</dd>
                <dt>Slack</dt><dd>{p.notify?.slack_channel || "gateway default"}</dd>
                <dt>Owner mails</dt><dd>{(p.notify?.owner_emails ?? []).join(", ") || "gateway default"}</dd>
                <dt>Cap exempt</dt><dd>{[...exempt].map(words).join(", ") || "—"}</dd>
              </dl>
            </section>
          </div>
        );
      })()}
    </>
  );
}
