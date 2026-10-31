import { workspaceContext } from "../core/people/launcher.mjs";
import { listPeople } from "../core/people/roster.mjs";
import { sendJson } from "./skill-run-route.mjs";

// GET /api/people: who this server is running for, and who else has a workspace.
export function mountPeopleRoutes({ addRoute, repoRoot, env = process.env }) {
  addRoute("GET", "/api/people", (_req, res) => {
    const { current, startCommand } = workspaceContext({ repoRoot, env });
    sendJson(res, 200, {
      current,
      startCommand,
      people: listPeople({ repoRoot, env }),
    });
  });
}
