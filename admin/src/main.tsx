import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AdminApi } from "./lib/api";
import { createFirebaseAuth } from "./lib/firebaseAuth";
import "./styles.css";

const auth = createFirebaseAuth();
const api = new AdminApi({
  baseUrl: import.meta.env.VITE_GATEWAY_URL as string,
  getToken: (force) => auth.getToken(force),
  onSessionProblem: (p) => auth.reportProblem(p),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App auth={auth} api={api} />
  </StrictMode>,
);
