import { RequireAuth } from "@/components/auth/RequireAuth";
import WorkspaceScreen from "@/screens/WorkspaceScreen";

export default async function ProjectWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <RequireAuth>
      <WorkspaceScreen projectId={id} />
    </RequireAuth>
  );
}
