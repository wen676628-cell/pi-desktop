import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentInstructionFile, AppSettings, UpdatePreference } from "@pi-desktop/shared";
import { api, type DiscoveredConfigEntry } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useUpdateState } from "../../hooks/use-update-state";
import { Button } from "../../components/ui";
import {
  IconCheck,
  IconDownload,
  IconFileText,
  IconRefresh,
} from "../../components/icons";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { persistUpdatePreference } from "./update-preference";
import { SettingsCard, SettingsRow } from "./primitives";

const ReleaseNotesDialog = lazy(() =>
  import("../../components/ReleaseNotesDialog").then((module) => ({
    default: module.ReleaseNotesDialog,
  })),
);

export function AgentInstructionsSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [global, setGlobal] = useState<AgentInstructionFile | null>(null);
  const [globalDraft, setGlobalDraft] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredConfigEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const result = await api.getAgentInstructions();
      setGlobal(result.global);
      setGlobalDraft(result.global.content);
      setDiscovered(result.discovered ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await api.saveAgentInstructions("global", globalDraft);
      setGlobal(result.file);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const globalDirty = global !== null && globalDraft !== global.content;
  return (
    <div className="settings-stack">
      <SettingsCard
        title={t("settings.instructionsGlobal")}
        description={t("settings.instructionsGlobalDesc")}
      >
        <div className="settings-form-grid">
          {loadError ? (
            <>
              <div className="settings-row-copy">
                <div className="settings-row-detail" role="alert">
                  {t("settings.instructionsLoadFailed")}
                </div>
              </div>
              <Button variant="secondary" onClick={() => void load()}>
                {t("errors.action.retry")}
              </Button>
            </>
          ) : (
            <>
              <div className="settings-row-copy">
                <div className="settings-instruction-path">{global?.path ?? ""}</div>
              </div>
              <textarea
                className="field-textarea settings-instruction-editor"
                value={globalDraft}
                onChange={(event) => setGlobalDraft(event.target.value)}
                aria-label={t("settings.instructionsGlobal")}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                disabled={loading}
              />
            </>
          )}
        </div>
        <div className="settings-panel-actions">
          <Button
            variant="primary"
            disabled={!globalDirty || saving || loading || loadError}
            onClick={() => void save()}
          >
            {saving ? t("settings.saving") : t("settings.instructionsSave")}
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.discoveredTitle")}
        description={t("settings.discoveredDesc")}
      >
        {discovered.length === 0 ? (
          <div className="settings-row-detail">{t("settings.discoveredEmpty")}</div>
        ) : (
          discovered.map((entry) => (
            <div className="settings-row" key={`${entry.scope}:${entry.path}`}>
              <div className="settings-row-copy">
                <div className="settings-row-title">
                  {entry.provider} · {entry.kind}
                </div>
                <div className="settings-instruction-path">{entry.path}</div>
              </div>
              <div className="settings-row-detail">
                {entry.entries === undefined ? entry.scope : `${entry.scope} · ${entry.entries}`}
              </div>
            </div>
          ))
        )}
      </SettingsCard>
    </div>
  );
}

export function UpdatesRow({
  currentVersion,
  settings,
  saveSettings,
}: {
  currentVersion?: string;
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const update = useUpdateState();
  const showToast = useAppStore((state) => state.showToast);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const selectedPreference: UpdatePreference =
    update?.automaticSupported === false
      ? "manual"
      : settings?.updatePreference ??
        update?.preference ??
        update?.defaultPreference ??
        "manual";
  const savePreference = useCallback(async (value: string) => {
    if (value !== "automatic" && value !== "manual") return;
    setPreferenceSaving(true);
    try {
      await persistUpdatePreference(value, saveSettings);
    } catch {
      if (useAppStore.getState().settings?.updatePreference !== value) {
        showToast(t("updates.preferenceSaveFailed"), { variant: "error" });
      }
    } finally {
      setPreferenceSaving(false);
    }
  }, [saveSettings, showToast, t]);
  const closeReleaseNotes = useCallback(() => setReleaseNotesOpen(false), []);
  const unavailable = update?.mode === "disabled";
  const disabled = !update || unavailable;
  const busy = update?.status === "checking" || update?.status === "downloading";
  const preferenceLocked =
    !update ||
    unavailable ||
    !settings ||
    update.status === "downloading";

  let action: ReactNode;
  if (update?.status === "downloaded") {
    action = (
      <Button
        variant="primary"
        onClick={() =>
          void api.updatesInstall().catch((error) =>
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            }),
          )
        }
      >
        {t("updates.restart")}
      </Button>
    );
  } else if (update?.status === "available" && update.mode === "manual") {
    action = (
      <Button
        variant="secondary"
        onClick={() =>
          void api.updatesOpenReleases().catch((error) =>
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            }),
          )
        }
      >
        {t("updates.viewRelease")}
      </Button>
    );
  } else {
    // A failed check flips the primary action into an explicit retry; while a
    // check or download runs the button stays visible but inert.
    action = (
      <Button
        variant="secondary"
        disabled={disabled || busy}
        onClick={() =>
          void api.updatesCheck().catch((error) =>
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "error",
            }),
          )
        }
      >
        {update?.status === "error" ? (
          <IconRefresh size={14} />
        ) : (
          <IconCheck size={14} />
        )}
        {update?.status === "error"
          ? t("updates.retry")
          : update?.status === "checking"
            ? t("updates.checking")
            : t("updates.check")}
      </Button>
    );
  }

  const progress = Math.max(0, Math.min(100, update?.progressPercent ?? 0));

  let statusBody: ReactNode = null;
  if (unavailable) {
    statusBody = (
      <div className="about-update-status">{t("updates.devDisabled")}</div>
    );
  } else if (!update) {
    statusBody = (
      <div className="about-update-status">{t("common.loading")}</div>
    );
  } else {
    switch (update.status) {
      case "checking":
        statusBody = (
          <div className="about-update-status">{t("updates.checking")}</div>
        );
        break;
      case "up-to-date":
        statusBody = (
          <div className="about-update-status is-ready">
            {t("updates.upToDate")}
          </div>
        );
        break;
      case "available":
        statusBody = (
          <div className="about-update-status">
            {t("updates.available", { version: update.availableVersion })}
            {update.mode === "manual" ? ` ${t("updates.manualHint")}` : ""}
          </div>
        );
        break;
      case "downloading":
        statusBody = (
          <div className="about-update-download">
            <div
              className="about-update-progress"
              role="progressbar"
              aria-label={t("updates.downloading", { percent: progress })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="about-update-progress-meta">
              <span>{t("updates.backgroundLabel")}</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="about-update-hint">
              {t("updates.backgroundHint")}
            </div>
          </div>
        );
        break;
      case "downloaded":
        statusBody = (
          <div className="about-update-status is-ready">
            {t("updates.downloaded", { version: update.availableVersion })}
          </div>
        );
        break;
      case "error":
        statusBody = (
          <div className="about-update-status is-error">
            {t("updates.error", { message: update.error ?? "" })}
          </div>
        );
        break;
      default:
        break;
    }
  }

  const notes = update?.releaseNotes?.trim() || null;
  const showNotes =
    notes &&
    (update?.status === "available" ||
      update?.status === "downloading" ||
      update?.status === "downloaded");

  return (
    <>
      {/*
        App-update card: icon + title + description on the left, actions on
        the right, live status (progress bar, error, readiness) below.
      */}
      <section className="settings-card-block">
        <div className="settings-panel about-update-panel">
          <div className="about-update-header">
            <div className="about-update-icon" aria-hidden="true">
              <IconDownload size={18} />
            </div>
            <div className="about-update-copy">
              <div className="about-update-title">{t("updates.title")}</div>
              <div className="about-update-desc">{t("updates.cardDesc")}</div>
            </div>
            <div className="about-update-actions">
              <Button
                variant="secondary"
                onClick={() => setReleaseNotesOpen(true)}
              >
                <IconFileText size={14} />
                {t("updates.releaseNotes")}
              </Button>
              {action}
            </div>
          </div>
          {statusBody}
          {showNotes ? (
            <div className="update-settings-notes about-update-notes">
              <div className="update-settings-notes-label">
                {t("updates.whatsNew")}
              </div>
              <pre className="update-settings-notes-body">{notes}</pre>
            </div>
          ) : null}
        </div>
      </section>
      <SettingsCard>
        <SettingsRow
          title={t("updates.preferenceTitle")}
          description={t("updates.preferenceDesc")}
        >
          <div className="flex flex-col items-end gap-1.5">
            <SettingsMenuSelect
              label={t("updates.preferenceTitle")}
              value={selectedPreference}
              options={[
                {
                  id: "automatic",
                  label: t("updates.automatic"),
                  disabled:
                    update?.automaticSupported !== true || preferenceLocked,
                },
                {
                  id: "manual",
                  label: t("updates.manual"),
                  disabled: preferenceLocked,
                },
              ]}
              disabled={preferenceLocked}
              busy={preferenceSaving || update?.status === "downloading"}
              onChange={(value) => void savePreference(value)}
            />
            {update?.automaticSupported === false ? (
              <div className="text-right text-xs-plus text-text-muted">
                {t("updates.automaticUnsupported")}
              </div>
            ) : null}
            {update?.automaticSupported && update.defaultPreference === "manual" ? (
              <div className="text-right text-xs-plus text-text-muted">
                {t("updates.automaticPortableWarning")}
              </div>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsCard>
      {releaseNotesOpen ? (
          <Suspense
            fallback={
              <div
                className="route-pending"
                role="status"
                aria-label={t("app.loadingView")}
              >
                <span className="route-pending-indicator" aria-hidden />
              </div>
            }
          >
            <ReleaseNotesDialog
              currentVersion={update?.currentVersion ?? currentVersion}
              availableVersion={update?.availableVersion}
              onClose={closeReleaseNotes}
            />
          </Suspense>
        ) : null}
    </>
  );
}
