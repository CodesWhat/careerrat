import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { profileSettingsApi } from "./api.js";
import { ProfileSettings } from "./ProfileSettings.jsx";
import {
  buildProfileSettingsModel,
  permissionPatch,
  profileSectionSavePlan,
} from "./profile-settings-controller.js";

const EMPTY_MODEL = buildProfileSettingsModel();

export function ProfileSettingsController({ api = profileSettingsApi }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState(() =>
    location.state?.activeTab === "settings" ? "settings" : "profile"
  );
  const [model, setModel] = useState(EMPTY_MODEL);
  const [error, setError] = useState(null);
  const [enginePickerOpen, setEnginePickerOpen] = useState(
    () => location.state?.openEnginePicker === true
  );
  const [enginePickerBusy, setEnginePickerBusy] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [sourceDialogBusy, setSourceDialogBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  const [technicalDetailsOpen, setTechnicalDetailsOpen] = useState(false);
  const [browserProviderBusy, setBrowserProviderBusy] = useState(false);
  const [publicSyncBusy, setPublicSyncBusy] = useState(false);
  const [editingSection, setEditingSection] = useState(null);
  const [editorValues, setEditorValues] = useState({});
  const [editorBusy, setEditorBusy] = useState(false);

  async function load() {
    const [onboard, runtimes, automation, sources] = await Promise.all([
      api.getOnboardState(),
      api.getInstalledAiRuntimes(),
      api.getAutomationSettings(),
      api.getSourceMaintenance(),
    ]);
    const next = { onboard, runtimes, automation, sources };
    setModel(buildProfileSettingsModel(next));
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getOnboardState(),
      api.getInstalledAiRuntimes(),
      api.getAutomationSettings(),
      api.getSourceMaintenance(),
    ])
      .then(([onboard, runtimes, automation, sources]) => {
        if (cancelled) return;
        const next = { onboard, runtimes, automation, sources };
        setModel(buildProfileSettingsModel(next));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause?.message || "Profile settings could not load.");
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
    setEditingSection(section);
    setEditorValues(
      Object.fromEntries(
        editor.fields.map((field) => [
          field.id,
          field.type === "checkbox" ? field.checked === true : (field.value ?? ""),
        ])
      )
    );
  }

  function closeEditor() {
    if (editorBusy) return;
    setEditingSection(null);
    setEditorValues({});
  }

  async function saveEditor() {
    const editor = model.profile?.editors?.[editingSection];
    if (!editor) return;
    setEditorBusy(true);
    setError(null);
    try {
      for (const write of profileSectionSavePlan(editingSection, editorValues, editor)) {
        if (write.kind === "deep-ingest") {
          await api.upsertDeepIngestConfirmedItem(write);
        } else {
          await api.saveCandidateFile(write.name, write.patch);
        }
      }
      await load();
      setEditingSection(null);
      setEditorValues({});
    } catch (cause) {
      setError(cause?.message || "That profile section could not be saved.");
    } finally {
      setEditorBusy(false);
    }
  }

  async function changePermission(id, enabled) {
    const patch = permissionPatch(id, enabled);
    if (!patch) return;
    try {
      await api.saveCandidateFile("automation", patch);
      await load();
    } catch (cause) {
      setError(cause?.message || "That permission could not be saved.");
    }
  }

  async function changePublicSync(enabled) {
    setPublicSyncBusy(true);
    setError(null);
    try {
      await api.setPublicSyncPreference(enabled);
      await load();
    } catch (cause) {
      setError(cause?.message || "That public metadata setting could not be saved.");
    } finally {
      setPublicSyncBusy(false);
    }
  }

  async function changeBrowserProvider(provider) {
    setBrowserProviderBusy(true);
    setError(null);
    try {
      await api.setAutomationSessionProvider(provider);
      await load();
    } catch (cause) {
      setError(cause?.message || "That browser automation provider could not be saved.");
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
      await load();
    } catch (cause) {
      setError(cause?.message || fallback);
    } finally {
      setEnginePickerBusy(false);
    }
  }

  async function selectEngine(runtimeId) {
    await updateRuntime(
      () => api.selectInstalledAiRuntime({ runtimeId }),
      "That AI engine could not be selected."
    );
  }

  async function connectEngine(runtimeId) {
    await updateRuntime(
      () => api.openInstalledAiRuntimeTerminal(runtimeId),
      "The sign-in terminal could not be opened."
    );
  }

  async function retryEngine(runtimeId) {
    await updateRuntime(
      () => api.probeInstalledAiRuntime(runtimeId),
      "CareerRat could not check that AI engine."
    );
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
      await api.addBoard({ url: url.href, label: url.hostname });
      await load();
      setSourceDraft("");
      setSourceDialogOpen(false);
    } catch (cause) {
      setError(cause?.message || "That source could not be added.");
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
        onBack={() => navigate("/")}
        onTabChange={setActiveTab}
        onEditSection={editSection}
        onOpenFiles={() => navigate("/", { state: { browse: "files" } })}
        onPermissionChange={changePermission}
        publicSyncBusy={publicSyncBusy}
        onPublicSyncChange={changePublicSync}
        onChangeEngine={changeEngine}
        onShowTechnicalDetails={() => setTechnicalDetailsOpen(true)}
        onAddSource={addSource}
        onExportData={exportData}
        enginePickerOpen={enginePickerOpen}
        enginePickerBusy={enginePickerBusy}
        onCloseEnginePicker={() => setEnginePickerOpen(false)}
        onSelectEngine={selectEngine}
        onConnectEngine={connectEngine}
        onRetryEngine={retryEngine}
        onRefreshEngines={() =>
          updateRuntime(() => Promise.resolve(), "CareerRat could not refresh the AI engine list.")
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
        profileEditor={editingSection ? model.profile?.editors?.[editingSection] : null}
        editorValues={editorValues}
        editorBusy={editorBusy}
        onEditorChange={(id, value) => setEditorValues((current) => ({ ...current, [id]: value }))}
        onSaveEditor={saveEditor}
        onAskAgent={(section) => askConversation(section || editingSection)}
        onCloseEditor={closeEditor}
      />
    </>
  );
}
