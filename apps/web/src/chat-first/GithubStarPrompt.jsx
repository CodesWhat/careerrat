import { StarIcon } from "./chat-first-icons.jsx";

export const GITHUB_STAR_URL = "https://github.com/CodesWhat/careerrat";
const GITHUB_STAR_PROMPT_KEY = "careerrat.github-star-prompt.v1";
const HANDLED_VALUE = "handled";

function promptStorage(storage) {
  try {
    return storage === undefined ? globalThis.localStorage : storage;
  } catch {
    return null;
  }
}

export function githubStarPromptWasHandled(storage) {
  const resolved = promptStorage(storage);
  if (!resolved) return true;
  try {
    return resolved.getItem(GITHUB_STAR_PROMPT_KEY) === HANDLED_VALUE;
  } catch {
    return true;
  }
}

export function markGithubStarPromptHandled(storage) {
  try {
    promptStorage(storage)?.setItem(GITHUB_STAR_PROMPT_KEY, HANDLED_VALUE);
  } catch {
    // A storage failure should not turn a small thank-you prompt into an app error.
  }
}

export function shouldOfferGithubStarPrompt({
  desktop = false,
  handled = true,
  searchStatus,
  matchCount = 0,
  searchLanes = {},
  searchRetry = null,
} = {}) {
  const hasIncompleteLane = Object.values(searchLanes).some(
    (lane) => lane?.status === "failed" || lane?.partial === true
  );
  return (
    desktop &&
    !handled &&
    searchStatus === "complete" &&
    matchCount > 0 &&
    !hasIncompleteLane &&
    !searchRetry
  );
}

export function GithubStarPrompt({ visible = false, onDismiss }) {
  if (!visible) return null;
  return (
    <aside
      className="chat-first-star-prompt"
      role="dialog"
      aria-labelledby="chat-first-star-prompt-title"
    >
      <span className="chat-first-star-prompt__icon" aria-hidden="true">
        <StarIcon />
      </span>
      <div className="chat-first-star-prompt__copy">
        <strong id="chat-first-star-prompt-title">CareerRat helping?</strong>
        <span>A GitHub star helps other job seekers find it.</span>
      </div>
      <div className="chat-first-star-prompt__actions">
        <a href={GITHUB_STAR_URL} target="_blank" rel="noreferrer" onClick={() => onDismiss?.()}>
          Star on GitHub
        </a>
        <button type="button" onClick={() => onDismiss?.()}>
          Not now
        </button>
      </div>
    </aside>
  );
}
