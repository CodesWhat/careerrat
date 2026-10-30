import { currentPerson } from "../core/paths/people.mjs";
import { listPeople } from "../core/people/roster.mjs";
import { sendJson } from "./skill-run-route.mjs";

// GET /api/people: who this server is running for, and who else has a workspace.
export function mountPeopleRoutes({ addRoute, repoRoot, env = process.env }) {
  addRoute("GET", "/api/people", (_req, res) => {
    sendJson(res, 200, {
      current: currentPerson(env),
      people: listPeople({ repoRoot, env }),
    });
  });
}
