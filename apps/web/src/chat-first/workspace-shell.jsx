import {
  CalendarIcon,
  ChevronDownIcon,
  FolderIcon,
  KanbanIcon,
  PeopleIcon,
  PickaxeIcon,
  PulseIcon,
  SearchIcon,
  SendUpIcon,
  SettingsIcon,
} from "./chat-first-icons.jsx";
import "./chat-first.css";

const EMPTY_LIST = [];

function activityHeading(agentName) {
  return `WHAT ${String(agentName || "Paul").toUpperCase()} DID TODAY`;
}

function Dot({ label = "Needs action" }) {
  return <span className="chat-first-dot" role="img" aria-label={label} />;
}

function RailIcon({ kind }) {
  const icons = {
    search: SearchIcon,
    pipeline: KanbanIcon,
    files: FolderIcon,
    people: PeopleIcon,
    schedule: CalendarIcon,
  };
  const Glyph = icons[kind];
  return (
    <span className={`chat-first-rail-icon chat-first-rail-icon--${kind}`} aria-hidden="true">
      {Glyph ? <Glyph /> : "◇"}
    </span>
  );
}

export function TopBar({
  agentName = "Paul",
  activityItems = EMPTY_LIST,
  activityOpen = false,
  missionLive = false,
  showActivity = true,
  onOpenProfile,
  onToggleActivity,
}) {
  return (
    <header className="chat-first-topbar">
      <span className="chat-first-topbar__brand">CareerRat</span>
      <div className="chat-first-topbar__actions">
        <button className="chat-first-topbar__profile" type="button" onClick={onOpenProfile}>
          <SettingsIcon />
          Profile &amp; settings
        </button>
        {showActivity ? (
          <div className="chat-first-activity">
            <button
              className="chat-first-activity__trigger"
              type="button"
              aria-label={activityOpen ? "Close activity" : "Open activity"}
              aria-expanded={activityOpen}
              aria-controls="chat-first-activity-menu"
              onClick={onToggleActivity}
            >
              <PulseIcon />
              {missionLive ? "activity · mission live" : "activity"}
              <ChevronDownIcon />
            </button>
            {activityOpen ? (
              <div
                className="chat-first-activity__menu"
                id="chat-first-activity-menu"
                role="status"
                aria-live="polite"
              >
                <div className="chat-first-eyebrow">{activityHeading(agentName)}</div>
                <div className="chat-first-activity__rows">
                  {activityItems.map((item) => (
                    <div className="chat-first-activity__row" key={item.id}>
                      <time>{item.time}</time>
                      <span
                        className={`chat-first-activity__mark chat-first-activity__mark--${item.tone || "done"}`}
                      >
                        {item.mark}
                      </span>
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
                <div className="chat-first-activity__footer">
                  Every step is logged. The full history lives in your local files.
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function ThreadRail({
  agentName = "Paul",
  activeThread = "today",
  needsAction = false,
  threads = EMPTY_LIST,
  browserLaunchers = EMPTY_LIST,
  archiveThreads = EMPTY_LIST,
  archiveTotal,
  archiveOpen = false,
  onSelectThread,
  onOpenBrowser,
  onToggleArchive,
}) {
  const closedCount = archiveTotal ?? archiveThreads.length;

  return (
    <nav className="chat-first-thread-rail" aria-label="Conversation threads">
      <button
        className={`chat-first-thread-card chat-first-thread-card--paul${activeThread === "today" ? " is-active" : ""}`}
        type="button"
        aria-current={activeThread === "today" ? "page" : undefined}
        onClick={() => onSelectThread?.("today")}
      >
        <span className="chat-first-thread-card__title">
          <span className="chat-first-avatar chat-first-avatar--small" aria-hidden="true">
            🐀
          </span>
          <span>{agentName}</span>
          {needsAction ? <Dot /> : null}
        </span>
        <span className="chat-first-thread-card__subtitle">
          main chat · briefs, missions, questions
        </span>
      </button>

      <div
        className={`chat-first-eyebrow chat-first-thread-rail__heading${threads.length ? "" : " chat-first-thread-rail__heading--empty"}`}
      >
        JOB CONVERSATIONS{threads.length ? ` · ${threads.length}` : ""}
      </div>
      {threads.length === 0 ? (
        <div className="chat-first-thread-rail__empty">
          threads appear when a recruiter replies or an interview lands
        </div>
      ) : null}
      {threads.map((thread) => {
        const active = activeThread === thread.id;
        return (
          <button
            className={`chat-first-thread-card${active ? " is-active" : ""}`}
            type="button"
            key={thread.id}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelectThread?.(thread.id)}
          >
            <span className="chat-first-thread-card__title">
              <span>{thread.title}</span>
              {thread.needsAction ? <Dot /> : null}
            </span>
            <span className="chat-first-thread-card__subtitle">{thread.subtitle}</span>
          </button>
        );
      })}

      <div className="chat-first-eyebrow chat-first-thread-rail__heading chat-first-thread-rail__browse-heading">
        BROWSE
      </div>
      {browserLaunchers.map((launcher) => (
        <button
          className={`chat-first-browser-launcher chat-first-browser-launcher--${launcher.tone || "plain"}`}
          type="button"
          key={launcher.id}
          onClick={() => onOpenBrowser?.(launcher.id)}
        >
          <RailIcon kind={launcher.id} />
          <span className="chat-first-browser-launcher__label">{launcher.label}</span>
          {launcher.meta ? (
            <span className="chat-first-browser-launcher__meta">{launcher.meta}</span>
          ) : null}
          <span className="chat-first-browser-launcher__arrow" aria-hidden="true">
            ›
          </span>
        </button>
      ))}

      <button
        className="chat-first-archive-toggle"
        type="button"
        aria-expanded={archiveOpen}
        aria-controls="chat-first-archive-list"
        onClick={onToggleArchive}
      >
        <span aria-hidden="true">{archiveOpen ? "▾" : "▸"}</span>
        Archive · {closedCount} closed {closedCount === 1 ? "thread" : "threads"}
      </button>
      {archiveOpen ? (
        <div className="chat-first-archive" id="chat-first-archive-list">
          {archiveThreads.map((thread) => (
            <button
              className="chat-first-archive__row"
              type="button"
              key={thread.id}
              onClick={() => onSelectThread?.(thread.id)}
            >
              <span>{thread.title}</span>
              <small>{thread.subtitle}</small>
            </button>
          ))}
          <div className="chat-first-archive__note">
            auto-archived on close · nothing is deleted
          </div>
        </div>
      ) : null}
    </nav>
  );
}

export function Composer({
  agentName = "Paul",
  value = "",
  placeholder,
  disabled = false,
  chips = EMPTY_LIST,
  onChange,
  onSubmit,
  onRemoveChip,
  onClearChips,
}) {
  const inputPlaceholder = placeholder || `tell ${agentName} what to do…`;

  function submit(event) {
    event.preventDefault();
    onSubmit?.(value);
  }

  return (
    <form className="chat-first-composer" onSubmit={submit}>
      {chips.length ? (
        <ul className="chat-first-composer__chips" aria-label="Message context">
          {chips.map((chip) => (
            <li className="chat-first-context-chip" key={chip.id}>
              ◇ {chip.label}
              {onRemoveChip ? (
                <button
                  type="button"
                  aria-label={`Remove ${chip.label} from context`}
                  onClick={() => onRemoveChip(chip.id)}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
          <button className="chat-first-composer__clear" type="button" onClick={onClearChips}>
            clear
          </button>
        </ul>
      ) : null}
      <div className="chat-first-composer__field">
        <input
          aria-label={`Message ${agentName}`}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          placeholder={inputPlaceholder}
          disabled={disabled}
        />
        <kbd>⌘K</kbd>
        <button
          className="chat-first-composer__send"
          type="submit"
          aria-label="Send message"
          disabled={disabled}
        >
          <SendUpIcon />
        </button>
      </div>
    </form>
  );
}

export function NeedsYouPanel({
  items = EMPTY_LIST,
  deepIngestPrompt = { visible: true },
  onStartIngest,
  onDismissIngest,
}) {
  return (
    <aside className="chat-first-needs" aria-label="Needs you">
      <div className="chat-first-needs__queue">
        <div className="chat-first-eyebrow chat-first-needs__heading">
          NEEDS YOU · {items.length}
        </div>
        {items.map((item) => (
          <section
            className={`chat-first-need-card chat-first-need-card--${item.tone || "plain"}`}
            key={item.id}
          >
            {item.eyebrow ? (
              <div className="chat-first-eyebrow chat-first-need-card__eyebrow">{item.eyebrow}</div>
            ) : null}
            <div className="chat-first-need-card__title">{item.title}</div>
            {item.detail ? <div className="chat-first-need-card__detail">{item.detail}</div> : null}
            <div className="chat-first-need-card__actions">
              {item.primaryLabel ? (
                <button
                  className={`chat-first-pill chat-first-pill--${item.tone === "attention" ? "ink" : "lime"}`}
                  type="button"
                  onClick={item.onPrimary}
                >
                  {item.primaryLabel}
                </button>
              ) : null}
              {item.secondaryLabel ? (
                <button
                  className="chat-first-pill chat-first-pill--outline"
                  type="button"
                  onClick={item.onSecondary}
                >
                  {item.secondaryLabel}
                </button>
              ) : null}
            </div>
          </section>
        ))}
        <div className="chat-first-dashed-note">
          Decisions queue here so they never get buried in chat. Expiring ones interrupt.
        </div>
      </div>
      {deepIngestPrompt?.visible !== false ? (
        <div className="chat-first-deep-dock">
          <div className="chat-first-deep-dock__heading">
            <div className="chat-first-eyebrow chat-first-needs__deeper-heading">GO DEEPER</div>
            <button
              className="chat-first-deep-card__dismiss"
              type="button"
              aria-label="Dismiss deep ingest prompt"
              onClick={onDismissIngest}
            >
              Dismiss
            </button>
          </div>
          <section className="chat-first-deep-card">
            <div className="chat-first-deep-card__title">
              <PickaxeIcon /> Deep ingest your history
            </div>
            <p>
              old resumes, reviews, project docs · tailoring and matches sharpen. ~15 min chat,
              pause anytime.
            </p>
            <button
              className="chat-first-pill chat-first-pill--lime"
              type="button"
              onClick={onStartIngest}
            >
              Start
            </button>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

export function ChatFirstWorkspace({ topBar, rail, conversation, context, overlays }) {
  return (
    <div className="chat-first-workspace">
      {topBar}
      <div className="chat-first-workspace__body">
        <div className="chat-first-workspace__rail">{rail}</div>
        <div className="chat-first-workspace__conversation">{conversation}</div>
        <div className="chat-first-workspace__context">{context}</div>
      </div>
      {overlays}
    </div>
  );
}
