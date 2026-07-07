import { createContext, useContext, useEffect, useState } from "react";
import {
  RolesterSignInButton,
  RolesterUserButton,
  useRolesterUser,
} from "../auth/clerkControls.jsx";
import { IconButton } from "../components/Button.jsx";
import { ArrowLeftIcon, ArrowRightIcon, MoonIcon, SunIcon } from "../components/icons.jsx";
import { useTheme } from "../lib/theme.js";

const DEFAULT_STEP_COUNT = 8;
const PROGRESS_FOOTER_REVEAL_STORAGE_KEY = "rolester:onboarding-progress-footer-revealed";
let progressFooterRevealSeen = false;
const OnboardingCompletionContext = createContext(null);
const DEFAULT_PROGRESS_STEPS = [
  { id: "start", icon: "👋", label: "Start" },
  { id: "account", icon: "👤", label: "Account" },
  { id: "resume", icon: "📄", label: "Resume" },
  { id: "roles", icon: "🎯", label: "Roles" },
  { id: "companies", icon: "🏢", label: "Companies" },
  { id: "guardrails", icon: "🚫", label: "Guardrails" },
  { id: "prefs", icon: "🪪", label: "Quick facts" },
  { id: "track", icon: "📊", label: "Track" },
];

export function OnboardingShell({
  activeIndex = 0,
  stepCount = DEFAULT_STEP_COUNT,
  className = "",
  actions = null,
  onProgressSelect,
  completedIndexes = null,
  children,
}) {
  const progressVisible = activeIndex > 0;
  const contextCompletedIndexes = useContext(OnboardingCompletionContext);
  const resolvedCompletedIndexes = Array.isArray(completedIndexes)
    ? completedIndexes
    : contextCompletedIndexes;
  const [shouldAnimateProgressReveal] = useState(() => {
    return progressVisible && !hasProgressFooterRevealBeenSeen();
  });

  useEffect(() => {
    if (progressVisible) {
      markProgressFooterRevealSeen();
    }
  }, [progressVisible]);

  return (
    <div className={`onboarding-shell ${className}`.trim()}>
      <OnboardingTopBar />
      <main className="onboarding-shell__main">
        <div className="onboarding-shell__stage">
          <div className="onboarding-shell__frame">
            {children}
            {actions ? <div className="onboarding-shell__actions">{actions}</div> : null}
          </div>
        </div>
      </main>
      <footer
        className={getOnboardingProgressFooterClassName({
          activeIndex,
          shouldAnimateReveal: shouldAnimateProgressReveal,
        })}
        aria-hidden={progressVisible ? undefined : "true"}
      >
        <OnboardingProgressTrail
          activeIndex={activeIndex}
          stepCount={stepCount}
          onSelect={onProgressSelect}
          completedIndexes={resolvedCompletedIndexes}
        />
      </footer>
    </div>
  );
}

export function OnboardingCompletionProvider({ completedIndexes = [], children }) {
  return (
    <OnboardingCompletionContext.Provider value={completedIndexes}>
      {children}
    </OnboardingCompletionContext.Provider>
  );
}

export function getOnboardingProgressFooterClassName({
  activeIndex = 0,
  shouldAnimateReveal = false,
} = {}) {
  const progressVisible = activeIndex > 0;
  return [
    "onboarding-progress-footer",
    progressVisible ? "onboarding-progress-footer--visible" : "onboarding-progress-footer--hidden",
    progressVisible && shouldAnimateReveal ? "onboarding-progress-footer--reveal" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function hasProgressFooterRevealBeenSeen() {
  if (progressFooterRevealSeen) return true;
  try {
    return globalThis.localStorage?.getItem(PROGRESS_FOOTER_REVEAL_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markProgressFooterRevealSeen() {
  progressFooterRevealSeen = true;
  try {
    globalThis.localStorage?.setItem(PROGRESS_FOOTER_REVEAL_STORAGE_KEY, "1");
  } catch {
    // Storage can be unavailable in private or test contexts; memory still handles this app session.
  }
}

export function OnboardingTopBar() {
  const { theme, toggle } = useTheme();
  const { isSignedIn } = useRolesterUser();
  const themeLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <header className="onboarding-shell__header">
      <div className="onboarding-shell__brand-lockup">
        <div className="onboarding-shell__brand">Rolester</div>
      </div>
      <div className="onboarding-shell__right">
        <IconButton label={themeLabel} className="onboarding-shell__theme" onClick={toggle}>
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </IconButton>
        <div className="onboarding-shell__account">
          {isSignedIn ? (
            <RolesterUserButton afterSignOutUrl="/app/onboarding" />
          ) : (
            <RolesterSignInButton mode="modal">
              <button type="button" className="onboarding-shell__login">
                Log in
              </button>
            </RolesterSignInButton>
          )}
        </div>
      </div>
    </header>
  );
}

export function OnboardingNavButton({
  direction = "next",
  label,
  className = "",
  disabled = false,
  ...rest
}) {
  const isBack = direction === "back";
  const Icon = isBack ? ArrowLeftIcon : ArrowRightIcon;

  return (
    <button
      type="button"
      className={`onboarding-nav-button onboarding-nav-button--${isBack ? "back" : "next"} ${className}`.trim()}
      aria-label={label}
      title={label}
      disabled={disabled}
      {...rest}
    >
      <Icon className="onboarding-nav-button__icon" />
    </button>
  );
}

function normalizeProgressIndexes(values, { stepCount }) {
  const maxStep = Math.max(0, stepCount - 1);
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.min(maxStep, Math.trunc(value)))
  );
}

function OnboardingProgressTrail({ activeIndex, stepCount, onSelect, completedIndexes = null }) {
  const steps = Array.from({ length: stepCount }, (_, index) => {
    return (
      DEFAULT_PROGRESS_STEPS[index] ?? {
        id: `step-${index + 1}`,
        icon: "•",
        label: `Step ${index + 1}`,
      }
    );
  });
  const hasExplicitCompletion = Array.isArray(completedIndexes);
  const completedSet = normalizeProgressIndexes(completedIndexes, { stepCount });

  return (
    <div className="onboarding-progress">
      {steps.map((step, index) => {
        const completed = hasExplicitCompletion ? completedSet.has(index) : index < activeIndex;
        const active = index === activeIndex;
        const filled = hasExplicitCompletion ? completed || active : index <= activeIndex;
        const clickable = completed && !active && typeof onSelect === "function";
        const className =
          "onboarding-progress__case" +
          (filled ? " onboarding-progress__case--filled" : "") +
          (active ? " onboarding-progress__case--active" : "") +
          (clickable ? " onboarding-progress__case--clickable" : "");
        const content = (
          <>
            <span className="onboarding-progress__case-icon">{step.icon}</span>
            <span className="onboarding-progress__case-label">{step.label}</span>
          </>
        );

        if (clickable) {
          return (
            <button
              key={step.id}
              type="button"
              className={className}
              aria-label={`Go to ${step.label}`}
              title={`Go to ${step.label}`}
              data-step-index={index}
              onClick={() => onSelect(index)}
            >
              {content}
            </button>
          );
        }

        return (
          <span key={step.id} className={className}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
