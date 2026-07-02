import { RequireAuth } from "@/components/auth/RequireAuth";
import ProjectsScreen from "@/screens/ProjectsScreen";

export default function ProjectsPage() {
  return (
    <RequireAuth>
      <ProjectsScreen />
    </RequireAuth>
  );
}
