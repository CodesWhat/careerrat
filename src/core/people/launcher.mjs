import { resolve } from "node:path";
import { currentPerson, peopleBase } from "../paths/people.mjs";
import { privateDataRoot } from "../paths/workspace.mjs";

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function startCommand(repoRoot, env) {
  const person = currentPerson(env);
  const assignments = [];
  if (!person && String(env.CAREERRAT_HOME || "").trim()) {
    assignments.push(`CAREERRAT_HOME=${shellQuote(privateDataRoot({ repoRoot, env }))}`);
  }
  if (person || String(env.CAREERRAT_PEOPLE_BASE || "").trim()) {
    assignments.push(
      `CAREERRAT_PEOPLE_BASE=${shellQuote(resolve(repoRoot, peopleBase({ repoRoot, env })))}`
    );
  }
  return [...assignments, "careerrat", ...(person ? ["--for", person] : []), "start", "codex"].join(
    " "
  );
}

export function workspaceContext({ repoRoot, env = process.env }) {
  return {
    id: privateDataRoot({ repoRoot, env }),
    current: currentPerson(env),
    startCommand: startCommand(repoRoot, env),
  };
}
