import { dbExists } from "../db/connection.mjs";
import { candidateConfigGet } from "../db/verbs/candidate.mjs";
import { listPersonNames, peopleBase, personRoot } from "../paths/people.mjs";

// "Ready" means the person's own setup is search-ready, the same readiness the
// candidate setup reports. A person with no database yet is simply not ready.
function personReady({ repoRoot, base, name }) {
  const env = { CAREERRAT_HOME: personRoot(base, name) };
  try {
    if (!dbExists({ repoRoot, env })) return false;
    return candidateConfigGet({ repoRoot, env }).setup?.readiness?.search_ready === true;
  } catch {
    return false;
  }
}

export function listPeople({ repoRoot, env = process.env } = {}) {
  const base = peopleBase({ repoRoot, env });
  return listPersonNames(base).map((name) => ({
    name,
    ready: personReady({ repoRoot, base, name }),
  }));
}
