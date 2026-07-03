import { RequireAuth } from "@/components/auth/RequireAuth";
import { RequireBilling } from "@/components/billing/RequireBilling";
import ProjectsScreen from "@/screens/ProjectsScreen";

export default function ProjectsPage() {
  return (
    <RequireAuth>
      <RequireBilling>
        <ProjectsScreen />
      </RequireBilling>
    </RequireAuth>
  );
}
