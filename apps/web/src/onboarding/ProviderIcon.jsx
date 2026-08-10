// ProviderIcon — the small brand mark rendered before a runtime's name on
// the engine picker's ready/sign-in-needed cards and its not-installed chip
// strip. Looked up purely by the runtime's own `id` field (whatever
// GET /api/settings/ai-runtimes returns) — this file never hardcodes which
// providers exist. Any id this map doesn't recognize (a future registry
// addition, or a probe result this build predates) falls back to a flat,
// ink-colored monogram square built from the runtime's own display name, so
// removing an adapter server-side (e.g. the retired Grok one) or adding a
// new one never requires a matching change here.
//
// Claude Code and OpenAI Codex marks are copied verbatim from the marketing
// site's own inline SVGs (website/src/app/page.tsx's .ai-chip icons) rather
// than re-sourced, so the two surfaces stay visually identical. The rest are
// adapted from the simple-icons brand-icon set (already a declared
// dependency) — their path data is copied in directly rather than imported
// at runtime, the same "paste the mark, don't wire up a live import" choice
// the marketing site already made for Claude/Codex.
//
// The Codex mark's gradient fill is a sanctioned brand-mark exception: it
// must stay here, in JSX, and never move into app.css — the repo's root
// guard rejects any "gradient(" string in that file.
//
// No <title> element in any of these — the adjacent runtime name is the
// accessible label, and an SVG <title>'s text content otherwise gets picked
// up by anything that walks the render tree for text (including this repo's
// own hand-rolled test-tree walkers), silently duplicating the name. Each
// <svg> carries its own literal aria-hidden="true" (the ProviderIcon wrapper
// below also spreads the same value, but biome's a11y lint can't see through
// that prop spread — it needs the attribute written here to know the
// title-less svg is intentional).
const ICONS = {
  claude: function ClaudeIcon(props) {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
        <path
          d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
          fill="#D97757"
        />
      </svg>
    );
  },
  codex: function CodexIcon({ id = "onboarding-engine-codex-gradient", ...props }) {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
        <path
          d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
          fill="#fff"
        />
        <path
          d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
          fill={`url(#${id})`}
        />
        <defs>
          <linearGradient id={id} x1="12" x2="12" y1="3" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#B1A7FF" />
            <stop offset=".5" stopColor="#7A9DFF" />
            <stop offset="1" stopColor="#3941FF" />
          </linearGradient>
        </defs>
      </svg>
    );
  },
  gemini: function GeminiIcon(props) {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
        <path
          d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
          fill="#8E75B2"
        />
      </svg>
    );
  },
  copilot: function CopilotIcon(props) {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
        <path
          d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"
          fill="currentColor"
        />
      </svg>
    );
  },
  qwen: function QwenIcon(props) {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
        <path
          d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z"
          fill="#6950EF"
        />
      </svg>
    );
  },
  opencode: function OpenCodeIcon(props) {
    return (
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
        <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill="currentColor" />
      </svg>
    );
  },
};

export function ProviderIcon({ runtimeId, name, size = 20, className }) {
  const Icon = ICONS[runtimeId];
  if (Icon) {
    return (
      <Icon
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        className={`onboarding-engine__provider-icon${className ? ` ${className}` : ""}`}
      />
    );
  }
  const letter =
    String(name || runtimeId || "")
      .trim()
      .charAt(0)
      .toUpperCase() || "?";
  return (
    <span
      className={`onboarding-engine__provider-icon onboarding-engine__provider-icon--monogram${
        className ? ` ${className}` : ""
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
