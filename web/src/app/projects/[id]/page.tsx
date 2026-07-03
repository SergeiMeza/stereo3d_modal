import { RequireAuth } from "@/components/auth/RequireAuth";
import { RequireBilling } from "@/components/billing/RequireBilling";
import WorkspaceScreen from "@/screens/WorkspaceScreen";

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireAuth>
      <RequireBilling>
        <WorkspaceScreen projectId={id} />
      </RequireBilling>
    </RequireAuth>
  );
}
