import { CheckIcon } from "../components/icons.jsx";

// WizardRail — a glanceable, wrapping pill row (never a giant table). Every
// step is always clickable: progress is DERIVED from GET /api/onboard/state
// (see OnboardingPage.jsx's computeInitialStep), not a locked linear
// sequence — a returning user can jump straight back to any step, the same
// freedom SettingsPage.jsx already gives every section.
export function WizardRail({ steps, activeIndex, doneFlags, onSelect }) {
  return (
    <ol className="wizard-rail">
      {steps.map((step, i) => {
        const isActive = i === activeIndex;
        const isDone = !!doneFlags[i];
        return (
          <li key={step.key}>
            <button
              type="button"
              className={
                "wizard-rail__step" +
                (isActive ? " wizard-rail__step--active" : "") +
                (isDone ? " wizard-rail__step--done" : "")
              }
              onClick={() => onSelect(i)}
            >
              <span className="wizard-rail__index">{isDone ? <CheckIcon /> : i + 1}</span>
              <span className="wizard-rail__label">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
