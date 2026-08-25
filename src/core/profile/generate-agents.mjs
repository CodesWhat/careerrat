// Generate the personalized AGENTS.md content from template + profile + targeting.

/**
 * renderLocalAgents({ template, profile, targeting }) → string.
 *
 * Appends a "## Candidate Context" section to the template with personalized
 * job-search context derived from profile and targeting.  Current compensation
 * values are NEVER included in the output.
 *
 * @param {object} opts
 * @param {string} opts.template   - Full text of templates/AGENTS.md
 * @param {object} opts.profile    - CareerRat candidate profile
 * @param {object} opts.targeting  - CareerRat targeting config
 * @returns {string}
 */
export function renderLocalAgents({ template, profile, targeting }) {
  const lines = [];

  // --- Candidate name ---
  const candidate = profile.candidate ?? {};
  const name = candidate.preferred_name || candidate.full_name;
  if (name) {
    lines.push(`- Candidate: ${name}`);
  }

  // --- Target roles ---
  const buckets = targeting.role_buckets ?? [];
  if (buckets.length > 0) {
    lines.push("- Target roles:");
    for (const bucket of buckets) {
      const titles = (bucket.titles ?? []).join(", ");
      lines.push(`  - ${bucket.name} (${bucket.priority}): ${titles}`);
    }
  }

  // --- Compensation floor (never current comp) ---
  const comp = profile.compensation ?? {};
  const currency = comp.currency ?? "USD";
  if (comp.minimum_base != null) {
    lines.push(`- Minimum base: ${currency} ${comp.minimum_base}`);
  }
  if (comp.target_base != null) {
    lines.push(`- Target base: ${currency} ${comp.target_base}`);
  }

  // --- Location ---
  const loc = profile.location ?? {};
  const locParts = [];
  if (loc.remote) {
    locParts.push(
      loc.remote_scope === "worldwide" ? "remote (worldwide)" : "remote (home-country)"
    );
  }
  if (loc.hybrid) locParts.push("hybrid");
  if (loc.onsite) locParts.push("onsite");
  if (loc.home) locParts.push(`home: ${loc.home}`);
  if (locParts.length > 0) {
    lines.push(`- Location: ${locParts.join(", ")}`);
  }

  // --- Keep signals ---
  const keepSignals = targeting.keep_signals ?? [];
  if (keepSignals.length > 0) {
    lines.push("- Keep signals:");
    for (const signal of keepSignals) {
      lines.push(`  - ${signal}`);
    }
  }

  // --- Cut signals ---
  const cutSignals = targeting.cut_signals ?? [];
  if (cutSignals.length > 0) {
    lines.push("- Cut signals:");
    for (const signal of cutSignals) {
      lines.push(`  - ${signal}`);
    }
  }

  // --- Excluded companies ---
  const excluded = targeting.excluded_companies ?? [];
  if (excluded.length > 0) {
    lines.push("- Excluded companies:");
    for (const company of excluded) {
      lines.push(`  - ${company}`);
    }
  }

  const section = `\n## Candidate Context\n\n${lines.join("\n")}\n`;
  return template + section;
}
