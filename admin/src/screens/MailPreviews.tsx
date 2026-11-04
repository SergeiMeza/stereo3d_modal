import { ErrorState, KV, PageHeader, Panel, PlainText, SkeletonRows, StateBox } from "@/components/common";
import { errorMessage } from "../lib/api";
import { useQuery } from "@/state/query";
import { mailPreviewsQuery } from "@/state/queries";

/** Every customer mail the cases send, rendered by the gateway with sample data. */
export function MailPreviews() {
  const { state, retry } = useQuery(mailPreviewsQuery, null);
  return (
    <>
      <PageHeader title="Mail previews">
        <span className="text-sm text-muted-foreground">Sample data · plain text as sent</span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={4} cols={2} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the mail previews." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && (
        <>
          {(state.data.mails ?? []).length === 0 && <StateBox title="No mail previews." />}
          {(state.data.mails ?? []).map((m) => (
            <Panel key={m.id} title={m.id} note={<span className="text-sm text-foreground">{m.subject}</span>}>
              <pre className="m-0 px-4 py-3 font-sans text-sm whitespace-pre-wrap text-foreground-2 [overflow-wrap:anywhere]">{m.text}</pre>
            </Panel>
          ))}
          {Object.keys(state.data.deny_templates ?? {}).length > 0 && (
            <Panel title="Deny templates (E10)">
              <KV>
                {Object.entries(state.data.deny_templates ?? {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono">{k}</dt>
                    <dd><PlainText text={v} inline /></dd>
                  </div>
                ))}
              </KV>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
