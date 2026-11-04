import { useEffect, useState } from "react";

import { ErrorState, FilterSelect, PageHeader, Panel, SkeletonRows, StateBox } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "../lib/api";
import { dateTime } from "../lib/format";
import { useAttention } from "../lib/attention";
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
  const { markFeedbackSeen } = useAttention();
  // opening Feedback clears the "new" badge (per browser)
  useEffect(() => markFeedbackSeen(), [markFeedbackSeen]);
  return (
    <>
      <PageHeader
        title="Feedback"
        actions={
          <>
            <FilterSelect
              label="Platform"
              allLabel="Web and app"
              value={platform}
              onChange={setPlatform}
              options={[
                { value: "web", label: "Web" },
                { value: "app", label: "App" },
              ]}
            />
            <FilterSelect
              label="Days"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={[
                { value: "7", label: "Last 7 days" },
                { value: "30", label: "Last 30 days" },
                { value: "90", label: "Last 90 days" },
              ]}
            />
          </>
        }
      >
        <span className="text-sm text-muted-foreground">From the web app and the apps · read only</span>
      </PageHeader>
      {state.kind === "loading" && <SkeletonRows rows={6} cols={4} />}
      {state.kind === "error" && (
        <ErrorState title="Couldn't load the feedback." message={errorMessage(state.error)} onRetry={retry} />
      )}
      {state.kind === "loaded" && <List items={state.data.items ?? []} />}
    </>
  );
}

function List({ items }: { items: FeedbackItem[] }) {
  if (items.length === 0) return <StateBox title="No feedback in this window." />;
  return (
    <Panel>
        <Table data-testid="feedback-list">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Page</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="text-xs">{dateTime(f.created_at)}</TableCell>
                <TableCell>
                  {PLATFORMS[f.platform] ?? f.platform}
                  {f.app_version ? <span className="text-xs text-muted-foreground"> {f.app_version}</span> : null}
                </TableCell>
                <TableCell>{KINDS[f.kind] ?? f.kind}</TableCell>
                <TableCell className="max-w-120 min-w-60 whitespace-pre-wrap [overflow-wrap:anywhere]">{f.message}</TableCell>
                <TableCell className="text-xs">
                  {f.email ?? "—"}
                  {f.email ? <span className="text-muted-foreground">{f.ok_to_contact ? " · OK to contact" : " · no contact"}</span> : null}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {[f.context?.route, f.context?.project_id && `project ${f.context.project_id}`, f.context?.run_id && `run ${f.context.run_id}`]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
    </Panel>
  );
}
