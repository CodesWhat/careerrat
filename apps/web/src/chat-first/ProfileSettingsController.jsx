import { useEffect, useRef, useState } from "react";
import * as ReactRouter from "react-router-dom";
import { inlineErrorMessage } from "../lib/errorCopy.js";
import { emptyAnnualCashWorksheet } from "./annual-cash-worksheet.js";
import { profileSettingsApi } from "./api.js";
import { useDesktopUpdate } from "./desktop-update.js";
import { firstRunRuntimeChoices } from "./first-run-controller.js";
import { ProfileSettings } from "./ProfileSettings.jsx";
import {
  buildProfileSettingsModel,
  PROFILE_SETTINGS_EDITOR_SECTIONS,
  permissionPatch,
  profileSectionSavePlan,
  profileSettingsLocation,
  profileSettingsRoute,
} from "./profile-settings-controller.js";

function buildSettingsModel(input = {}) {
  const model = buildProfileSettingsModel(input);
  return {
    ...model,
    draftContext: normalizeDraftContext(input.onboard?.draftContext),
    aiPreferences: {
      quality: input.aiPreferences?.quality || "automatic",
      reasoning: input.aiPreferences?.reasoning || "automatic",
      source: input.aiPreferences?.source || "default",
      updatedAt: input.aiPreferences?.updatedAt || null,
    },
    engine: {
      ...model.engine,
      choices: firstRunRuntimeChoices(input.runtimes),
      guidedSetupAvailable: input.runtimes?.guidedSetupAvailable === true,
    },
  };
}

const PROFILE_EDITOR_DRAFT_PREFIX = "careerrat:profile-editor-draft:";
const SOURCE_DRAFT_PREFIX = "careerrat:source-draft:";
const SETTINGS_DRAFT_LIMIT = 16_000;
const LEGACY_UNOWNED_DRAFT_OWNER = "current-workspace:current-candidate";
const DRAFT_TOO_LARGE =
  "That draft is too large to save for recovery. Shorten it before leaving this page.";
const DRAFT_STORAGE_UNAVAILABLE =
  "CareerRat couldn't save that draft for recovery. Keep this page open, then try again.";
const SETTINGS_BASE_CHANGED =
  "Your profile changed while you were editing. CareerRat reloaded the latest version and kept your draft open. Review it, then save again.";
const useDataRouterBlocker =
  "useBlocker" in ReactRouter && typeof ReactRouter.useBlocker === "function"
    ? ReactRouter.useBlocker
    : () => null;
const EMPTY_MODEL = buildSettingsModel();

function profileEditorValues(editor) {
  return Object.fromEntries(
    (editor?.fields || []).map((field) => [
      field.id,
      field.type === "checkbox" ? field.checked === true : (field.value ?? ""),
    ])
  );
}

function hydrateProfileEditorDraft(editor, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return values;
  const hasAnnualCashWorksheet = (editor?.fields || []).some(
    (field) => field.id === "annualCashWorksheet"
  );
  if (
    !hasAnnualCashWorksheet ||
    Object.hasOwn(values, "annualCashWorksheet") ||
    !Object.hasOwn(values, "minimumAnnualEarnings")
  ) {
    return values;
  }
  const { minimumAnnualEarnings, ...currentValues } = values;
  return {
    ...currentValues,
    annualCashWorksheet: emptyAnnualCashWorksheet(minimumAnnualEarnings),
  };
}

function fieldValuesMatch(left, right) {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

function profileEditorValuesMatch(editor, left, right) {
  return (editor?.fields || []).every((field) =>
    fieldValuesMatch(left?.[field.id], right?.[field.id])
  );
}

function normalizeDraftContext(context) {
  const workspaceId = String(context?.owner?.workspaceId || "").trim();
  const candidateId = String(context?.owner?.candidateId || "").trim();
  const revision = String(
    context?.base?.revision ||
      [context?.base?.version, context?.base?.lastUpdatedAt]
        .filter((value) => value != null)
        .join(":")
  ).trim();
  if (!workspaceId || !candidateId || !revision) return null;
  return { owner: { workspaceId, candidateId }, base: { revision } };
}

function draftContextId(context) {
  if (!context) return null;
  return `${context.owner.workspaceId}:${context.owner.candidateId}:${context.base.revision}`;
}

function draftOwnerId(context) {
  if (!context) return null;
  return `${context.owner.workspaceId}:${context.owner.candidateId}`;
}

function storedDraftKey(prefix, context, scope = "") {
  if (!context) return null;
  return `${prefix}${draftOwnerId(context)}${scope ? `:${scope}` : ""}`;
}

function sameDraftContext(left, right) {
  if (!left || !right) return false;
  return draftContextId(left) === draftContextId(right);
}

function removeStoredDraft(key) {
  if (!key) return null;
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // The in-memory draft can still be cleared when storage is unavailable.
  }
  return null;
}

function readStoredDraft(key, context) {
  if (!key || !context) return null;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    if (raw.length > SETTINGS_DRAFT_LIMIT) return removeStoredDraft(key);
    const draft = JSON.parse(raw);
    if (
      !draft ||
      typeof draft !== "object" ||
      !sameDraftContext(normalizeDraftContext(draft), context) ||
      !Number.isFinite(Date.parse(draft.savedAt))
    ) {
      return removeStoredDraft(key);
    }
    return draft.value;
  } catch {
    return removeStoredDraft(key);
  }
}

function writeStoredDraft(key, context, value) {
  if (!key || !context) return "unowned";
  let raw;
  try {
    raw = JSON.stringify({ ...context, savedAt: new Date().toISOString(), value });
  } catch {
    return "unavailable";
  }
  if (raw.length > SETTINGS_DRAFT_LIMIT) {
    return "too-large";
  }
  try {
    if (!globalThis.localStorage?.setItem) return "unavailable";
    globalThis.localStorage.setItem(key, raw);
    return "saved";
  } catch {
    return "unavailable";
  }
}

function clearLegacyUnownedDrafts() {
  removeStoredDraft(`${SOURCE_DRAFT_PREFIX}${LEGACY_UNOWNED_DRAFT_OWNER}`);
  for (const section of PROFILE_SETTINGS_EDITOR_SECTIONS) {
    removeStoredDraft(`${PROFILE_EDITOR_DRAFT_PREFIX}${LEGACY_UNOWNED_DRAFT_OWNER}:${section}`);
  }
}

function profileEditorDraftKey(section, context) {
  return typeof section === "string" && section
    ? storedDraftKey(PROFILE_EDITOR_DRAFT_PREFIX, context, section)
    : null;
}

function sourceDraftKey(context) {
  return storedDraftKey(SOURCE_DRAFT_PREFIX, context);
}

function settingsLocationUrl(location) {
  return `${location?.pathname || "/settings"}${location?.search || ""}`;
}

function canonicalSettingsLocationUrl(location) {
  const pathname = location?.pathname || "/settings";
  return pathname === "/settings"
    ? profileSettingsLocation(location?.search || "").route
    : settingsLocationUrl(location);
}

export function profileSettingsErrorMessage(error, fallback) {
  return inlineErrorMessage(error, fallback);
}

export function ProfileSettingsController({ api = profileSettingsApi }) {
  const navigate = ReactRouter.useNavigate();
  const location = ReactRouter.useLocation();
  const currentRoute = profileSettingsLocation(location.search);
  const currentLocationUrl = currentRoute.route;
  const actualLocationUrl = settingsLocationUrl(location);
  const [acceptedLocationUrl, setAcceptedLocationUrl] = useState(currentLocationUrl);
  const [model, setModel] = useState(EMPTY_MODEL);
  const [error, setError] = useState(null);
  const [draftStorageWarning, setDraftStorageWarning] = useState(null);
  const [enginePickerBusy, setEnginePickerBusy] = useState(false);
  const [engineSignInId, setEngineSignInId] = useState(null);
  const [guidedSetup, setGuidedSetup] = useState(null);
  const [sourceDialogBusy, setSourceDialogBusy] = useState(false);
  const [sourceDraftState, setSourceDraftState] = useState({ contextId: null, value: "" });
  const [browserProviderBusy, setBrowserProviderBusy] = useState(false);
  const [publicSyncBusy, setPublicSyncBusy] = useState(false);
  const [aiPreferencesBusy, setAiPreferencesBusy] = useState(false);
  const [aiPreferencesStatus, setAiPreferencesStatus] = useState("");
  const [editorDraftState, setEditorDraftState] = useState({ contextId: null, values: {} });
  const [editorBusy, setEditorBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const permittedNavigationRef = useRef(null);
  const desktopUpdate = useDesktopUpdate();
  const draftContext = model.draftContext;
  const contextId = draftContextId(draftContext);
  const acceptedRoute = profileSettingsLocation(
    new URL(acceptedLocationUrl, "http://careerrat.local").search
  );
  const acceptedEditingSection = acceptedRoute.panel === "editor" ? acceptedRoute.section : null;
  const acceptedEditor = acceptedEditingSection
    ? model.profile?.editors?.[acceptedEditingSection]
    : null;
  const acceptedDefaultValues = profileEditorValues(acceptedEditor);
  const editorDrafts = editorDraftState.contextId === contextId ? editorDraftState.values : {};
  const acceptedEditorValues = acceptedEditingSection
    ? hydrateProfileEditorDraft(
        acceptedEditor,
        editorDrafts[acceptedEditingSection] ??
          (draftContext
            ? readStoredDraft(
                profileEditorDraftKey(acceptedEditingSection, draftContext),
                draftContext
              )
            : null)
      )
    : null;
  const acceptedVisibleEditorValues = acceptedEditorValues ?? acceptedDefaultValues;
  const editorDirty = Boolean(
    acceptedEditor &&
      !profileEditorValuesMatch(acceptedEditor, acceptedVisibleEditorValues, acceptedDefaultValues)
  );
  const sourceDraft =
    sourceDraftState.contextId === contextId
      ? sourceDraftState.value
      : sourceDraftState.contextId === null && sourceDraftState.value
        ? sourceDraftState.value
        : (readStoredDraft(sourceDraftKey(draftContext), draftContext) ?? "");
  const sourceDirty = acceptedRoute.panel === "source" && sourceDraft !== "";
  const dirtyKind = editorDirty ? "profile" : sourceDirty ? "source" : null;
  const shouldBlockDestination = (destination) => {
    if (!dirtyKind) return false;
    return canonicalSettingsLocationUrl(destination) !== acceptedLocationUrl;
  };
  const blocker = useDataRouterBlocker(({ nextLocation }) => {
    const nextLocationUrl = canonicalSettingsLocationUrl(nextLocation);
    if (permittedNavigationRef.current === nextLocationUrl) {
      permittedNavigationRef.current = null;
      return false;
    }
    return shouldBlockDestination(nextLocation);
  });
  const fallbackHistoryNavigation =
    currentLocationUrl !== acceptedLocationUrl && shouldBlockDestination(location)
      ? {
          kind: "committed",
          to: currentLocationUrl,
          options: {},
          origin: acceptedLocationUrl,
        }
      : null;
  const blockedHistoryNavigation =
    blocker?.state === "blocked"
      ? {
          kind: "blocker",
          to: profileSettingsRoute({
            ...profileSettingsLocation(blocker.location?.search || ""),
          }),
          options: {},
          origin: acceptedLocationUrl,
        }
      : null;
  const activeNavigation =
    blockedHistoryNavigation || fallbackHistoryNavigation || pendingNavigation;
  const displayedRoute = fallbackHistoryNavigation ? acceptedRoute : currentRoute;
  const activeTab = displayedRoute.activeTab;
  const activePanel = displayedRoute.panel;
  const editingSection = activePanel === "editor" ? displayedRoute.section : null;
  const profileEditor = editingSection ? model.profile?.editors?.[editingSection] : null;
  const defaultEditorValues = profileEditorValues(profileEditor);
  const editorValues = editingSection
    ? hydrateProfileEditorDraft(
        profileEditor,
        editorDrafts[editingSection] ??
          (draftContext
            ? readStoredDraft(profileEditorDraftKey(editingSection, draftContext), draftContext)
            : null)
      )
    : null;
  const visibleEditorValues = editorValues ?? defaultEditorValues;
  const draftDirty = Boolean(dirtyKind);
  const enginePickerOpen = activePanel === "engine" && !activeNavigation;
  const sourceDialogOpen = activePanel === "source" && !activeNavigation;
  const technicalDetailsOpen = activePanel === "technical" && !activeNavigation;

  useEffect(() => {
    if (!draftDirty || typeof globalThis.addEventListener !== "function") return undefined;
    const protectDraft = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", protectDraft);
    return () => globalThis.removeEventListener?.("beforeunload", protectDraft);
  }, [draftDirty]);

  useEffect(() => {
    if (!draftContext) return;
    clearLegacyUnownedDrafts();
    if (sourceDraftState.contextId !== null || !sourceDraftState.value) return;
    const result = writeStoredDraft(
      sourceDraftKey(draftContext),
      draftContext,
      sourceDraftState.value
    );
    setSourceDraftState({ contextId, value: sourceDraftState.value });
    if (result === "saved") setDraftStorageWarning(null);
    if (result === "too-large") setDraftStorageWarning(DRAFT_TOO_LARGE);
    if (result === "unavailable") setDraftStorageWarning(DRAFT_STORAGE_UNAVAILABLE);
  }, [contextId, draftContext, sourceDraftState.contextId, sourceDraftState.value]);

  useEffect(() => {
    if (draftDirty || actualLocationUrl === currentLocationUrl) return;
    navigate(currentLocationUrl, { replace: true });
  }, [actualLocationUrl, currentLocationUrl, draftDirty, navigate]);

  useEffect(() => {
    if (fallbackHistoryNavigation || acceptedLocationUrl === currentLocationUrl) return;
    setAcceptedLocationUrl(currentLocationUrl);
  }, [acceptedLocationUrl, currentLocationUrl, fallbackHistoryNavigation]);

  function requestNavigation(to, options = {}, force = false) {
    const destination = new URL(to, "http://careerrat.local");
    if (!force && shouldBlockDestination(destination)) {
      setPendingNavigation({ kind: "requested", to, options, origin: acceptedLocationUrl });
      return false;
    }
    if (!force) {
      navigate(to, options);
      return true;
    }
    permittedNavigationRef.current = canonicalSettingsLocationUrl(destination);
    try {
      navigate(to, options);
    } finally {
      permittedNavigationRef.current = null;
    }
    return true;
  }

  function navigateForeground(
    { tab = activeTab, panel = null, section = null } = {},
    options = {},
    force = false
  ) {
    return requestNavigation(profileSettingsRoute({ tab, panel, section }), options, force);
  }

  function setActiveTab(tab) {
    navigateForeground({ tab });
  }

  function setEnginePickerOpen(open) {
    navigateForeground({ tab: "settings", panel: open ? "engine" : null }, { replace: !open });
  }

  function setSourceDialogOpen(open) {
    navigateForeground({ tab: "settings", panel: open ? "source" : null }, { replace: !open });
  }

  function setTechnicalDetailsOpen(open) {
    navigateForeground({ tab: "settings", panel: open ? "technical" : null }, { replace: !open });
  }

  async function load() {
    const [onboard, runtimes, automation, sources, aiPreferences] = await Promise.all([
      api.getOnboardState(),
      api.getInstalledAiRuntimes(),
      api.getAutomationSettings(),
      api.getSourceMaintenance(),
      api.getAiPreferences(),
    ]);
    const next = { onboard, runtimes, automation, sources, aiPreferences };
    setModel(buildSettingsModel(next));
    setError(null);
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getOnboardState(),
      api.getInstalledAiRuntimes(),
      api.getAutomationSettings(),
      api.getSourceMaintenance(),
      api.getAiPreferences(),
    ])
      .then(([onboard, runtimes, automation, sources, aiPreferences]) => {
        if (cancelled) return;
        const next = { onboard, runtimes, automation, sources, aiPreferences };
        setModel(buildSettingsModel(next));
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            profileSettingsErrorMessage(cause, "CareerRat couldn't load Settings. Try again.")
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  function askConversation(section) {
    navigate("/", {
      state: { composerDraft: `I need to update my ${String(section).replaceAll("-", " ")}.` },
    });
  }

  function editSection(section) {
    const editor = model.profile?.editors?.[section];
    if (!editor) return;
    navigateForeground({ tab: "profile", panel: "editor", section });
  }

  function clearEditorDraft(section) {
    removeStoredDraft(profileEditorDraftKey(section, draftContext));
    setEditorDraftState((current) => {
      const values = current.contextId === contextId ? { ...current.values } : {};
      delete values[section];
      return { contextId, values };
    });
  }

  function clearSourceDraft() {
    removeStoredDraft(sourceDraftKey(draftContext));
    setSourceDraftState({ contextId, value: "" });
  }

  function recordDraftPersistence(result) {
    if (result === "saved") setDraftStorageWarning(null);
    if (result === "too-large") setDraftStorageWarning(DRAFT_TOO_LARGE);
    if (result === "unavailable") setDraftStorageWarning(DRAFT_STORAGE_UNAVAILABLE);
  }

  function closeEditor() {
    if (editorBusy) return;
    if (!navigateForeground({ tab: "profile" }, { replace: true })) return;
    clearEditorDraft(editingSection);
  }

  function keepEditing() {
    const navigation = activeNavigation;
    setPendingNavigation(null);
    if (blocker?.state === "blocked") blocker.reset();
    if (navigation?.kind === "committed") {
      navigate(navigation.origin, { replace: true });
    }
  }

  function discardEditor() {
    const navigation = activeNavigation;
    if (!navigation) return;
    if (dirtyKind === "profile") clearEditorDraft(acceptedEditingSection);
    if (dirtyKind === "source") clearSourceDraft();
    setPendingNavigation(null);
    if (navigation.kind === "blocker") {
      blocker.proceed();
      return;
    }
    if (navigation.kind === "committed") {
      setAcceptedLocationUrl(navigation.to);
      return;
    }
    requestNavigation(navigation.to, navigation.options, true);
  }

  async function saveEditor() {
    const editor = model.profile?.editors?.[editingSection];
    if (!editor) return;
    if (!draftContext?.base?.revision) {
      setError("CareerRat couldn't confirm the latest profile. Reload Settings, then try again.");
      return;
    }
    const savedDraft = { ...visibleEditorValues };
    const savedContext = draftContext;
    setEditorBusy(true);
    setError(null);
    try {
      for (const write of profileSectionSavePlan(editingSection, visibleEditorValues, editor)) {
        if (write.kind === "deep-ingest") {
          await api.upsertDeepIngestConfirmedItem({
            ...write,
            expectedBaseRevision: draftContext.base.revision,
          });
        } else {
          await api.saveCandidateFile(write.name, write.patch, {
            expectedBaseRevision: draftContext.base.revision,
          });
        }
      }
      await load();
      clearEditorDraft(editingSection);
      setPendingNavigation(null);
      navigateForeground({ tab: "profile" }, { replace: true }, true);
    } catch (cause) {
      if (cause?.status === 409 && cause?.body?.code === "SETTINGS_BASE_CHANGED") {
        try {
          const next = await load();
          const nextContext = normalizeDraftContext(next.onboard?.draftContext);
          const nextContextId = draftContextId(nextContext);
          if (nextContext) {
            const previousKey = profileEditorDraftKey(editingSection, savedContext);
            const nextKey = profileEditorDraftKey(editingSection, nextContext);
            const result = writeStoredDraft(nextKey, nextContext, savedDraft);
            recordDraftPersistence(result);
            setEditorDraftState({
              contextId: nextContextId,
              values: { [editingSection]: savedDraft },
            });
            if (result === "saved" && previousKey !== nextKey) {
              removeStoredDraft(previousKey);
            }
          }
          setError(SETTINGS_BASE_CHANGED);
        } catch (reloadCause) {
          setError(
            profileSettingsErrorMessage(
              reloadCause,
              "Your profile changed while you were editing, but CareerRat couldn't reload it. Keep this page open and try again."
            )
          );
        }
      } else {
        setError(
          profileSettingsErrorMessage(
            cause,
            "CareerRat couldn't save that profile section. Check it and try again."
          )
        );
      }
    } finally {
      setEditorBusy(false);
    }
  }

  async function changePermission(id, enabled) {
    const patch = permissionPatch(id, enabled, model.permissionState || model.permissions);
    if (!patch) return;
    try {
      await api.saveCandidateFile("automation", patch);
      await load();
    } catch (cause) {
      setError(
        profileSettingsErrorMessage(cause, "CareerRat couldn't save that permission. Try again.")
      );
    }
  }

  async function changePublicSync(enabled) {
    setPublicSyncBusy(true);
    setError(null);
    try {
      await api.setPublicSyncPreference(enabled);
      await load();
    } catch (cause) {
      setError(
        profileSettingsErrorMessage(
          cause,
          "CareerRat couldn't save that sharing setting. Try again."
        )
      );
    } finally {
      setPublicSyncBusy(false);
    }
  }

  async function changeAiPreference(field, value) {
    const next = {
      quality: model.aiPreferences?.quality || "automatic",
      reasoning: model.aiPreferences?.reasoning || "automatic",
      [field]: value,
    };
    setAiPreferencesBusy(true);
    setAiPreferencesStatus("Saving…");
    setError(null);
    try {
      const saved = await api.saveAiPreferences(next);
      setModel((current) => ({ ...current, aiPreferences: saved }));
      setAiPreferencesStatus("Saved on this computer");
    } catch (cause) {
      setAiPreferencesStatus("");
      setError(
        profileSettingsErrorMessage(
          cause,
          "CareerRat couldn't save that AI setting. Choose one of the options and try again."
        )
      );
    } finally {
      setAiPreferencesBusy(false);
    }
  }

  async function changeBrowserProvider(provider) {
    setBrowserProviderBusy(true);
    setError(null);
    try {
      await api.setAutomationSessionProvider(provider);
      await load();
    } catch (cause) {
      setError(
        profileSettingsErrorMessage(
          cause,
          "CareerRat couldn't change the browser choice. Try again."
        )
      );
    } finally {
      setBrowserProviderBusy(false);
    }
  }

  function changeEngine() {
    setEnginePickerOpen(true);
  }

  async function updateRuntime(action, fallback) {
    setEnginePickerBusy(true);
    setError(null);
    try {
      await action();
      return await load();
    } catch (cause) {
      setError(profileSettingsErrorMessage(cause, fallback));
    } finally {
      setEnginePickerBusy(false);
    }
  }

  async function selectEngine(runtimeId) {
    const result = await updateRuntime(
      () => api.selectInstalledAiRuntime({ runtimeId }),
      "CareerRat couldn't select that AI. Check it again or choose another one."
    );
    if (result) setEngineSignInId(null);
  }

  async function connectEngine(runtimeId) {
    const result = await updateRuntime(async () => {
      await api.startInstalledAiRuntimeSignIn(runtimeId);
      setEngineSignInId(runtimeId);
    }, "CareerRat couldn't start sign-in. Try again, or sign in from the AI tool.");
    if (!result) setEngineSignInId(null);
  }

  async function retryEngine(runtimeId) {
    const result = await updateRuntime(
      () => api.probeInstalledAiRuntime(runtimeId),
      "CareerRat couldn't check that AI. Make sure it's installed and signed in, then check again."
    );
    if (
      result?.runtimes?.runtimes?.some(
        (runtime) => runtime.id === runtimeId && runtime.ready === true
      )
    ) {
      setEngineSignInId(null);
    }
  }

  // Returning users hit "Update needed" from Settings, not the first-run
  // picker, so Settings needs its own guided-update path rather than only a
  // "Check again" retry that can never clear the boundary on its own.
  // Mirrors FirstRunController's startGuidedSetup outcome mapping so the
  // same installing/failed/cancelled/unavailable states show up here too.
  async function guidedUpdateEngine(runtimeId) {
    setEnginePickerBusy(true);
    setError(null);
    setGuidedSetup({ runtimeId, status: "installing" });
    try {
      await api.startInstalledAiRuntimeGuidedSetup(runtimeId, { onEvent() {} });
      await load();
      setGuidedSetup({ runtimeId, status: "installed" });
    } catch (cause) {
      const code = String(cause?.code || cause?.body?.code || "").toUpperCase();
      if (code === "RUNTIME_ALREADY_INSTALLED") {
        try {
          await load();
        } finally {
          setGuidedSetup({ runtimeId, status: "installed" });
        }
      } else {
        const status =
          code === "RUNTIME_GUIDED_SETUP_CANCELLED"
            ? "cancelled"
            : ["RUNTIME_GUIDED_SETUP_UNAVAILABLE", "RUNTIME_GUIDED_SETUP_UNSUPPORTED"].includes(
                  code
                )
              ? "unavailable"
              : "failed";
        setGuidedSetup({ runtimeId, status });
      }
    } finally {
      setEnginePickerBusy(false);
    }
  }

  function addSource() {
    setSourceDialogOpen(true);
  }

  async function submitSource() {
    const raw = sourceDraft.trim();
    if (!raw) return;
    let url;
    try {
      url = new URL(raw);
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("unsupported protocol");
    } catch {
      setError("Enter a complete http or https board URL.");
      return;
    }
    setSourceDialogBusy(true);
    setError(null);
    try {
      await api.addBoardSource(url.href);
      await load();
      clearSourceDraft();
      navigateForeground({ tab: "settings" }, { replace: true }, true);
    } catch (cause) {
      setError(
        profileSettingsErrorMessage(
          cause,
          "CareerRat couldn't add that board. Check the link and try again."
        )
      );
    } finally {
      setSourceDialogBusy(false);
    }
  }

  function exportData() {
    if (!globalThis.document) return;
    const link = document.createElement("a");
    link.href = "/api/data/export-everything";
    link.download = "careerrat-data.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <>
      {error || draftStorageWarning ? (
        <div className="chat-first-controller-alert" role="alert">
          {error || draftStorageWarning}
        </div>
      ) : null}
      <ProfileSettings
        {...model}
        activeTab={activeTab}
        onBack={() => requestNavigation("/")}
        onTabChange={setActiveTab}
        onEditSection={editSection}
        onOpenFiles={() => requestNavigation("/", { state: { browse: "files" } })}
        onPermissionChange={changePermission}
        aiPreferencesBusy={aiPreferencesBusy}
        aiPreferencesStatus={aiPreferencesStatus}
        onAiPreferenceChange={changeAiPreference}
        publicSyncBusy={publicSyncBusy}
        desktopUpdate={{
          available: desktopUpdate.available,
          supported: desktopUpdate.supported,
          enabled: desktopUpdate.enabled,
          saving: desktopUpdate.saving,
          checking: desktopUpdate.checking,
          status: desktopUpdate.status,
          downloadUrl: desktopUpdate.downloadUrl,
          onEnabledChange: desktopUpdate.setEnabled,
          onCheckNow: desktopUpdate.checkNow,
        }}
        onPublicSyncChange={changePublicSync}
        onChangeEngine={changeEngine}
        onShowTechnicalDetails={() => setTechnicalDetailsOpen(true)}
        onAddSource={addSource}
        onExportData={exportData}
        enginePickerOpen={enginePickerOpen}
        enginePickerBusy={enginePickerBusy}
        engineSignInId={engineSignInId}
        guidedSetup={guidedSetup}
        onCloseEnginePicker={() => setEnginePickerOpen(false)}
        onSelectEngine={selectEngine}
        onConnectEngine={connectEngine}
        onRetryEngine={retryEngine}
        onGuidedUpdateEngine={guidedUpdateEngine}
        onRefreshEngines={() =>
          updateRuntime(
            () => Promise.resolve(),
            "CareerRat couldn't refresh the AI list. Make sure Claude Code or Codex is installed, then try again."
          )
        }
        sourceDialogOpen={sourceDialogOpen}
        sourceDialogBusy={sourceDialogBusy}
        sourceDraft={sourceDraft}
        onCloseSourceDialog={() => setSourceDialogOpen(false)}
        onSourceDraftChange={(value) => {
          recordDraftPersistence(
            writeStoredDraft(sourceDraftKey(draftContext), draftContext, value)
          );
          setSourceDraftState({ contextId, value });
        }}
        onSubmitSource={submitSource}
        technicalDetailsOpen={technicalDetailsOpen}
        browserProviderBusy={browserProviderBusy}
        onBrowserProviderChange={changeBrowserProvider}
        onCloseTechnicalDetails={() => setTechnicalDetailsOpen(false)}
        profileEditor={profileEditor}
        editorValues={visibleEditorValues}
        editorBusy={editorBusy}
        discardEditorOpen={Boolean(activeNavigation)}
        onEditorChange={(id, value) => {
          const currentValues = editorDraftState.contextId === contextId ? editorDrafts : {};
          const values = {
            ...(hydrateProfileEditorDraft(
              profileEditor,
              currentValues[editingSection] ||
                readStoredDraft(profileEditorDraftKey(editingSection, draftContext), draftContext)
            ) || defaultEditorValues),
            [id]: value,
          };
          recordDraftPersistence(
            writeStoredDraft(
              profileEditorDraftKey(editingSection, draftContext),
              draftContext,
              values
            )
          );
          setEditorDraftState({
            contextId,
            values: { ...currentValues, [editingSection]: values },
          });
        }}
        onSaveEditor={saveEditor}
        onAskAgent={(section) => {
          if (draftDirty) {
            setPendingNavigation({
              kind: "requested",
              to: "/",
              options: {
                state: {
                  composerDraft: `I need to update my ${String(section || editingSection).replaceAll("-", " ")}.`,
                },
              },
              origin: acceptedLocationUrl,
            });
            return;
          }
          askConversation(section || editingSection);
        }}
        onCloseEditor={closeEditor}
        onKeepEditing={keepEditing}
        onDiscardEditor={discardEditor}
      />
    </>
  );
}
