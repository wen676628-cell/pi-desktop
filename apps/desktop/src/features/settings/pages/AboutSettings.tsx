/**
 * Info destination: what is installed, how it updates, and the two ways out of
 * a problem (logs, bug report). The Developer card stays here because the
 * things it unlocks are diagnostics, not preferences.
 */
import type { AppSettings } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { Button } from "../../../components/ui";
import { UpdatesRow } from "../agent-sections";
import { DeveloperSection } from "../developer-sections";
import { SettingsCard, SettingsRow } from "../primitives";

export function AboutSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const version = useAppStore((s) => s.version);
  const showToast = useAppStore((s) => s.showToast);
  const reportError = (error: unknown) =>
    showToast(error instanceof Error ? error.message : String(error), {
      variant: "error",
    });
  return (
    <div className="settings-stack">
      <div className="settings-about-hero">
        <div className="settings-about-hero-name">{version?.name || "PI-Desktop"}</div>
        <div className="settings-about-hero-version">
          {t("settings.aboutVersion", { version: version?.version ?? "" })}
        </div>
        <div className="settings-about-hero-meta">
          protocol {version?.protocolVersion} · host {version?.hostVersion}
        </div>
      </div>
      <UpdatesRow
        currentVersion={version?.version}
        settings={settings}
        saveSettings={saveSettings}
      />
      <SettingsCard>
        <SettingsRow title={t("settings.logs")}>
          <Button
            variant="secondary"
            onClick={() => void api.openLogs().catch(reportError)}
          >
            {t("settings.openLogs")}
          </Button>
        </SettingsRow>
        <SettingsRow
          title={t("settings.feedback")}
          description={t("settings.feedbackDesc")}
        >
          <Button
            variant="secondary"
            onClick={() => void api.openFeedback().catch(reportError)}
          >
            {t("settings.openFeedback")}
          </Button>
        </SettingsRow>
      </SettingsCard>

      {settings && (
        <DeveloperSection settings={settings} saveSettings={saveSettings} />
      )}
    </div>
  );
}
