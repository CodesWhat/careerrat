// search/ai-rerank.mjs — opt-in AI pass over the top of a scan's kept list (CR115j).
//
// It only annotates. Every kept offer stays in `kept`, in the order the scorer
// gave it; the top N get a short fit note and a suggested rank from the model.
// Nothing is filtered, hidden or reordered here, so a bad model answer costs a
// note, never a job. Off unless targeting.yml sets
// `search_preferences.ai_rerank.enabled: true`. Field-neutral: the prompt is
// built from the candidate's own targeting, with no built-in preference.
import { runBoundedAI } from "../ai/bounded-ai.mjs";

const AI_RERANK_DEFAULT_TOP_N = 20;
const AI_RERANK_MAX_TOP_N = 50;
const NOTE_MAX = 160;
const EXCERPT_MAX = 500;

export const NO_AI_ROUTE_MESSAGE =
  "AI rerank is turned on, but no AI route is configured, so results keep their scored order. Sign in to a supported AI CLI or add an API key, or turn it off with search_preferences.ai_rerank.enabled: false.";

const AI_LABELS = Object.freeze({
  skill: "search-jobs",
  action: "rerank-results",
  operation: "search:ai-rerank",
});

const MANUAL_FALLBACK = Object.freeze({
  available: true,
  reason: "Results are already ranked by score.",
  action: "Review the results in the order shown.",
});

export function resolveAiRerankSetting(targeting) {
  const raw = targeting?.search_preferences?.ai_rerank;
  const enabled = raw?.enabled === true;
  const n = Number(raw?.top_n);
  const topN =
    Number.isInteger(n) && n > 0 ? Math.min(n, AI_RERANK_MAX_TOP_N) : AI_RERANK_DEFAULT_TOP_N;
  return { enabled, topN };
}

function clean(value, max) {
  const text = String(value ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function rerankSchema(count) {
  return {
    type: "object",
    required: ["ranking"],
    additionalProperties: false,
    properties: {
      ranking: {
        type: "array",
        maxItems: count,
        items: {
          type: "object",
          required: ["id", "note"],
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 20 },
            note: { type: "string", minLength: 1, maxLength: NOTE_MAX },
          },
        },
      },
    },
  };
}

function candidateContext(config = {}) {
  const targeting = config.targeting || {};
  return {
    headline: clean(config.profile?.candidate?.headline, 200),
    targetTitles: (targeting.role_buckets || [])
      .flatMap((bucket) => bucket?.titles || [])
      .map((title) => clean(title, 80))
      .slice(0, 20),
    keepSignals: (targeting.keep_signals || []).map((s) => clean(s, 80)).slice(0, 12),
    cutSignals: (targeting.cut_signals || []).map((s) => clean(s, 80)).slice(0, 12),
  };
}

function skipped(status, message) {
  return { status, message, annotated: 0, suggestedOrder: [] };
}

/**
 * @returns {Promise<{kept:Array, aiRerank:{status:string, message:string, annotated:number, suggestedOrder:string[]}}>}
 *   `kept` is the same offers in the same order; the top N carry `aiNote` and
 *   `aiRank`, and the note is appended to `ratingReason`.
 */
export async function annotateTopResults({
  kept,
  config = {},
  repoRoot,
  env = process.env,
  call,
  runAI = runBoundedAI,
  signal,
} = {}) {
  const offers = Array.isArray(kept) ? kept : [];
  const setting = resolveAiRerankSetting(config.targeting);
  if (!setting.enabled) return { kept: offers, aiRerank: skipped("disabled", "") };
  if (!offers.length) return { kept: offers, aiRerank: skipped("empty", "No results to rerank.") };

  const top = offers.slice(0, setting.topN);
  const ids = new Map(top.map((offer, index) => [`o${index + 1}`, index]));
  const payload = top.map((offer, index) => ({
    id: `o${index + 1}`,
    title: clean(offer.title, 120),
    company: clean(offer.company, 80),
    location: clean(offer.location, 80),
    score: offer.score,
    excerpt: clean(offer.bodyText || offer.description, EXCERPT_MAX),
  }));

  let result;
  try {
    result = await runAI({
      labels: AI_LABELS,
      schema: rerankSchema(top.length),
      manual: MANUAL_FALLBACK,
      structuredMode: "native-preferred",
      maxRetries: 0,
      outputName: "search_rerank",
      maxTokens: 400 + top.length * 90,
      root: repoRoot,
      env,
      call,
      aiOperation: "structured.extraction",
      signal,
      system:
        "You help a job seeker order search results. Judge each posting only against the candidate's own targets and signals. Do not assume any field or seniority preference the candidate did not state. Return only the requested structured response.",
      messages: [
        {
          role: "user",
          content: [
            "Order these postings from best to worst fit for the candidate. For each, give a fit note of one short sentence. Use only the ids supplied; list every posting you can judge, best first.",
            JSON.stringify({ candidate: candidateContext(config), postings: payload }),
          ].join("\n\n"),
        },
      ],
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      kept: offers,
      aiRerank: skipped(
        "failed",
        `AI rerank failed (${clean(error?.message, 120)}), so results keep their scored order.`
      ),
    };
  }

  const body = result?.body;
  if (!body?.ok) {
    if (body?.code === "NO_AI_ROUTE") {
      return { kept: offers, aiRerank: skipped("no-ai-route", NO_AI_ROUTE_MESSAGE) };
    }
    return {
      kept: offers,
      aiRerank: skipped(
        "failed",
        `AI rerank failed (${clean(body?.error?.message || body?.code || "unknown", 120)}), so results keep their scored order.`
      ),
    };
  }

  const notes = new Map();
  const suggestedOrder = [];
  for (const entry of body.data?.ranking || []) {
    const index = ids.get(entry?.id);
    const note = clean(entry?.note, NOTE_MAX);
    if (index === undefined || !note || notes.has(index)) continue;
    notes.set(index, { note, rank: notes.size + 1 });
    suggestedOrder.push(top[index].url);
  }

  const annotated = offers.map((offer, index) => {
    const hit = notes.get(index);
    if (!hit) return offer;
    return {
      ...offer,
      aiNote: hit.note,
      aiRank: hit.rank,
      ratingReason: [offer.ratingReason, `AI note: ${hit.note}`].filter(Boolean).join("; "),
    };
  });
  return {
    kept: annotated,
    aiRerank: {
      status: "ok",
      message: notes.size
        ? `AI added fit notes to ${notes.size} of the top ${top.length} results.`
        : "The AI returned no usable notes, so results keep their scored order.",
      annotated: notes.size,
      suggestedOrder,
    },
  };
}
