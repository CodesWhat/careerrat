import { Link } from "react-router-dom";

const READINESS_KEYS = ["search_ready", "gate_ready", "apply_ready", "deep_ingest_complete"];

// Deep-links each missing-string variant straight to the onboarding step (or
// dedicated page) that resolves it. Keyed on the lowercased raw string from
// setup.missing so wording drift in the backend just falls through to the
// generic default rather than throwing.
const SETUP_TODO_TARGETS = {
  "source resume": { label: "Add your resume", to: "/onboarding?step=resume" },
  "role titles": { label: "Add role titles", to: "/onboarding?step=targeting" },
  "search location or remote posture": {
    label: "Set location / remote",
    to: "/onboarding?step=prefs",
  },
  "location posture": { label: "Set location / remote", to: "/onboarding?step=prefs" },
  "compensation floor": { label: "Set compensation floor", to: "/onboarding?step=prefs" },
  "work authorization": { label: "Add work authorization", to: "/onboarding?step=prefs" },
  "candidate full name": { label: "Add your name", to: "/onboarding?step=resume" },
  "candidate email": { label: "Add your email", to: "/onboarding?step=resume" },
  "evidence claims": { label: "Add evidence claims", to: "/onboarding?step=resume" },
};

function isComplete(setup) {
  const readiness = setup?.readiness || {};
  return READINESS_KEYS.every((key) => readiness[key] === true);
}

function todoTarget(raw) {
  const text = String(raw || "").trim();
  return SETUP_TODO_TARGETS[text.toLowerCase()] || { label: text, to: "/onboarding" };
}

function collectMissing(missing) {
  const out = [];
  for (const key of ["search_ready", "gate_ready", "apply_ready"]) {
    for (const value of Array.isArray(missing?.[key]) ? missing[key] : []) {
      const text = String(value || "").trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function dedupeTodos(todos) {
  const out = [];
  const seen = new Set();
  for (const todo of todos) {
    const key = todo.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(todo);
  }
  return out;
}

function buildTodos(setup) {
  const readiness = setup.readiness || {};
  const todos = collectMissing(setup.missing).map(todoTarget);
  if (readiness.deep_ingest_complete !== true) {
    todos.push({ label: "Finish deep ingest", to: "/deep-ingest" });
  }
  return dedupeTodos(todos);
}

export function SetupReadinessCard({ setup }) {
  if (!setup || isComplete(setup)) return null;

  const readiness = setup.readiness || {};
  const todos = buildTodos(setup);
  const n = todos.length;

  return (
    <section className="setup-banner" role="status" aria-label="Finish setup">
      <span className="setup-banner__mark" aria-hidden="true">
        🪪
      </span>
      <div className="setup-banner__body">
        <p className="setup-banner__title">
          Finish setup — {n} quick thing{n === 1 ? "" : "s"} left
        </p>
        <p className="setup-banner__sub">
          {readiness.search_ready
            ? "Searching now. Gate and apply unlock as these fill in."
            : "Finish these to start searching."}
        </p>
      </div>
      <div className="setup-banner__todos">
        {todos.map((t) => (
          <Link key={t.label} className="setup-banner__todo" to={t.to}>
            {t.label}
          </Link>
        ))}
        <Link className="btn btn--secondary setup-banner__finish" to="/onboarding">
          Finish setup
        </Link>
      </div>
    </section>
  );
}
