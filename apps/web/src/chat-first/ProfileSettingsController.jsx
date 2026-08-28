import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { inlineErrorMessage } from "../lib/errorCopy.js";
import { profileSettingsApi } from "./api.js";
import { useDesktopUpdate } from "./desktop-update.js";
import { firstRunRuntimeChoices } from "./first-run-controller.js";
import { ProfileSettings } from "./ProfileSettings.jsx";
import {
  buildProfileSettingsModel,
  permissionPatch,
  profileSectionSavePlan,
  profileSettingsRoute,
} from "./profile-settings-controller.js";

function buildSettingsModel(input = {}) {
  const model = buildProfileSettingsModel(input);
  return {
    ...model,
    aiPreferences: {
      quality: input.aiPreferences?.quality || "automatic",
      reasoning: input.aiPreferences?.reasoning || "automatic",
      source: input.aiPreferences?.source || "default",
      updatedAt: input.aiPreferences?.updatedAt || null,
    },
    engine: {
      ...model.engine,
      choices: firstRunRuntimeChoices(input.runtimes),
    },
  };
}

const EMPTY_MODEL = buildSettingsModel();
const PROFILE_EDITOR_DRAFT_PREFIX = "careerrat:profile-editor-draft:";
const PROFILE_EDITOR_DRAFT_LIMIT = 16_000;

function profileEditorValues(editor) {
  return Object.fromEntries(
    (editor?.fields || []).map((field) => [
      field.id,
      field.type === "checkbox" ? field.checked === true : (field.value ?? ""),
    ])
  );
}

function profileEditorValuesMatch(editor, left, right) {
  return (editor?.fields || []).every((field) => Object.is(left?.[field.id], right?.[field.id]));
}

function profileEditorDraftKey(section) {
  return typeof section === "string" && section ? `${PROFILE_EDITOR_DRAFT_PREFIX}${section}` : null;
}

function readProfileEditorDraft(section) {
  const key = profileEditorDraftKey(section);
  if (!key) return null;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw || raw.length > PROFILE_EDITOR_DRAFT_LIMIT) return null;
    const values = JSON.parse(raw);
    return values && typeof values === "object" && !Array.isArray(values) ? values : null;
  } catch {
    return null;
  }
}

function writeProfileEditorDraft(section, values) {
  const key = profileEditorDraftKey(section);
  if (!key) return;
  try {
    const raw = JSON.stringify(values);
    if (raw.length <= PROFILE_EDITOR_DRAFT_LIMIT) globalThis.localStorage?.setItem(key, raw);
  } catch {
    // The in-memory draft still protects the active editor when storage is unavailable.
  }
}

function clearProfileEditorDraft(section) {
  const key = profileEditorDraftKey(section);
  if (!key) return;
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // The route can still close after its in-memory draft is cleared.
  }
}

export function profileSettingsErrorMessage(error, fallback) {
  return inlineErrorMessage(error, fallback);
}

export function ProfileSettingsController({ api = profileSettingsApi }) {
  const navigate = useNavigate();
  const location = useLocation();
  const foregroundParams = new URLSearchParams(location.search || "");
  const activeTab = foregroundParams.get("tab") === "settings" ? "settings" : "profile";
  const activePanel = foregroundParams.get("panel");
  const [model, setModel] = useState(EMPTY_MODEL);
  const [error, setError] = useState(null);
  const enginePickerOpen = foregroundParams.get("panel") === "engine";
  const [enginePickerBusy, setEnginePickerBusy] = useState(false);
  const [engineSignInId, setEngineSignInId] = useState(null);
  const sourceDialogOpen = activePanel === "source";
  const [sourceDialogBusy, setSourceDialogBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  const technicalDetailsOpen = activePanel === "technical";
  const [browserProviderBusy, setBrowserProviderBusy] = useState(false);
  const [publicSyncBusy, setPublicSyncBusy] = useState(false);
  const [aiPreferencesBusy, setAiPreferencesBusy] = useState(false);
  const [aiPreferencesStatus, setAiPreferencesStatus] = useState("");
  const editingSection = activePanel === "editor" ? foregroundParams.get("section") : null;
  const [editorDrafts, setEditorDrafts] = useState({});
  const [editorBusy, setEditorBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState(null);
  const desktopUpdate = useDesktopUpdate();
  const profileEditor = editingSection ? model.profile?.editors?.[editingSection] : null;
  const defaultEditorValues = profileEditorValues(profileEditor);
  const editorValues = editingSection
    ? (editorDrafts[editingSection] ?? readProfileEditorDraft(editingSection))
    : null;
  const visibleEditorValues = editorValues || defaultEditorValues;
  const editorDirty = Boolean(
    profileEditor &&
      !profileEditorValuesMatch(profileEditor, visibleEditorValues, defaultEditorValues)
  );

  useEffect(() => {
    if (!editorDirty || typeof globalThis.addEventListener !== "function") return undefined;
    const protectDraft = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", protectDraft);
    return () => globalThis.removeEventListener?.("beforeunload", protectDraft);
  }, [editorDirty]);

  function requestNavigation(to, options = {}, force = false) {
    if (editorDirty && !force) {
      setPendingNavigation({ to, options });
      return false;
    }
    navigate(to, options);
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

  function closeEditor() {
    if (editorBusy) return;
    if (!navigateForeground({ tab: "profile" }, { replace: true })) return;
    clearProfileEditorDraft(editingSection);
    setEditorDrafts((current) => {
      const next = { ...current };
      delete next[editingSection];
      return next;
    });
  }

  function keepEditing() {
    setPendingNavigation(null);
  }

  function discardEditor() {
    if (!pendingNavigation) return;
    clearProfileEditorDraft(editingSection);
    setEditorDrafts((current) => {
      const next = { ...current };
      delete next[editingSection];
      return next;
    });
    setPendingNavigation(null);
    requestNavigation(pendingNavigation.to, pendingNavigation.options, true);
  }

  async function saveEditor() {
    const editor = model.profile?.editors?.[editingSection];
    if (!editor) return;
    setEditorBusy(true);
    setError(null);
    try {
      for (const write of profileSectionSavePlan(editingSection, visibleEditorValues, editor)) {
        if (write.kind === "deep-ingest") {
          await api.upsertDeepIngestConfirmedItem(write);
        } else {
          await api.saveCandidateFile(write.name, write.patch);
        }
      }
      await load();
      clearProfileEditorDraft(editingSection);
      setEditorDrafts((current) => {
        const next = { ...current };
        delete next[editingSection];
        return next;
      });
      setPendingNavigation(null);
      navigateForeground({ tab: "profile" }, { replace: true }, true);
    } catch (cause) {
      setError(
        profileSettingsErrorMessage(
          cause,
          "CareerRat couldn't save that profile section. Check it and try again."
        )
      );
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
      setSourceDraft("");
      setSourceDialogOpen(false);
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
      {error ? (
        <div className="chat-first-controller-alert" role="alert">
          {error}
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
        onCloseEnginePicker={() => setEnginePickerOpen(false)}
        onSelectEngine={selectEngine}
        onConnectEngine={connectEngine}
        onRetryEngine={retryEngine}
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
        onSourceDraftChange={setSourceDraft}
        onSubmitSource={submitSource}
        technicalDetailsOpen={technicalDetailsOpen}
        browserProviderBusy={browserProviderBusy}
        onBrowserProviderChange={changeBrowserProvider}
        onCloseTechnicalDetails={() => setTechnicalDetailsOpen(false)}
        profileEditor={profileEditor}
        editorValues={visibleEditorValues}
        editorBusy={editorBusy}
        discardEditorOpen={Boolean(pendingNavigation)}
        onEditorChange={(id, value) => {
          setEditorDrafts((current) => {
            const values = {
              ...(current[editingSection] ||
                readProfileEditorDraft(editingSection) ||
                defaultEditorValues),
              [id]: value,
            };
            writeProfileEditorDraft(editingSection, values);
            return { ...current, [editingSection]: values };
          });
        }}
        onSaveEditor={saveEditor}
        onAskAgent={(section) => {
          if (editorDirty) {
            setPendingNavigation({
              to: "/",
              options: {
                state: {
                  composerDraft: `I need to update my ${String(section || editingSection).replaceAll("-", " ")}.`,
                },
              },
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
