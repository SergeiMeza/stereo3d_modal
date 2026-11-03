import { ErrorState, PlainText, SkeletonRows } from "../components/ui";
import { errorMessage } from "../lib/api";
import { useServices } from "../lib/services";
import { useLoad } from "../lib/useLoad";

/** Every customer mail the cases send, rendered by the gateway with sample data. */
export function MailPreviews() {
  const { api } = useServices();
  const { state, retry } = useLoad(() => api.mailPreviews(), [api]);
  return (
    <>
      <div className="titlebar">
        <h1>Mail previews</h1>
        <span className="muted small">Sample data · plain text as sent</span>
      </div>
      {state.kind === "loading" && <SkeletonRows rows={4} cols={2} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the mail previews." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && (
        <>
          {(state.data.mails ?? []).map((m) => (
            <section className="card" key={m.id}>
              <div className="sh">
                <b>{m.id}</b>
                <span className="small">{m.subject}</span>
              </div>
              <pre className="plain mailtext pad">{m.text}</pre>
            </section>
          ))}
          {Object.keys(state.data.deny_templates ?? {}).length > 0 && (
            <section className="card">
              <div className="sh"><b>Deny templates (E10)</b></div>
              <dl className="kv pad">
                {Object.entries(state.data.deny_templates ?? {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="mono">{k}</dt>
                    <dd><PlainText text={v} className="inline" /></dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </>
  );
}
