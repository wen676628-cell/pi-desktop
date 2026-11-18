/**
 * Agent behavior destination (D684): what a new conversation starts with, and
 * what the agent is allowed to do while it runs.
 *
 * Session defaults and Execution replace the old Defaults card, which had
 * grown into the page's catch-all: it mixed these decisions with transcript
 * presentation and composer input, which are now the Conversation
 * destination.
 */
import type { AppSettings, GlobalPermissionMode, OutputStyleId } from "@pi-desktop/shared";
import { useTranslation } from "react-i18next";
import { SettingsToggle } from "../../../components/ui";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { ComputerUseSettings } from "../computer-use/ComputerUseSettings";
import { GoalBudgetSettingsRow } from "../../modes/GoalBudgetSettingsRow";
import { CommandShellRow, SettingsCard, SettingsRow } from "../primitives";
import { AgentMemoryPanel } from "../AgentMemoryPanel";

export function AgentBehaviorSettings({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-stack">
      <SettingsCard
        title={t("settings.sessionDefaults")}
        caption={t("settings.sessionDefaultsCaption")}
      >
        <GoalBudgetSettingsRow settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.permissionMode")}
          description={t("settings.permissionModeDesc")}
        >
          <SettingsMenuSelect
            className="settings-permission-select"
            label={t("settings.permissionMode")}
            value={settings.defaultPermissionMode ?? "ask"}
            onChange={(mode) =>
              void saveSettings({
                defaultPermissionMode: mode as GlobalPermissionMode,
              })
            }
            options={[
              { id: "ask", label: t("settings.permissionModeAsk") },
              {
                id: "accept-edits",
                label: t("settings.permissionModeAcceptEdits"),
              },
              { id: "auto", label: t("settings.permissionModeAuto") },
            ]}
          />
        </SettingsRow>
        <CommandShellRow settings={settings} saveSettings={saveSettings} />
        <SettingsRow
          title={t("settings.outputStyle")}
          description={t("settings.outputStyleDesc")}
        >
          <SettingsMenuSelect
            className="settings-output-style-select"
            label={t("settings.outputStyle")}
            value={settings.outputStyle ?? "default"}
            onChange={(style) =>
              void saveSettings({ outputStyle: style as OutputStyleId })
            }
            options={[
              { id: "default", label: t("settings.outputStyleDefault") },
              { id: "concise", label: t("settings.outputStyleConcise") },
              { id: "explanatory", label: t("settings.outputStyleExplanatory") },
              { id: "mentor", label: t("settings.outputStyleMentor") },
            ]}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t("settings.execution")}>
        <SettingsRow
          title={t("settings.infiniteProviderRetry")}
          description={t("settings.infiniteProviderRetryDesc")}
        >
          <SettingsToggle
            checked={settings.infiniteProviderRetry === true}
            label={t("settings.infiniteProviderRetry")}
            onChange={() => void saveSettings({ infiniteProviderRetry: settings.infiniteProviderRetry !== true })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.scheduledTasks")}
          description={t("settings.scheduledTasksDesc")}
        >
          <SettingsToggle
            checked={settings.scheduledTasksEnabled !== false}
            label={t("settings.scheduledTasks")}
            onChange={() => void saveSettings({
              scheduledTasksEnabled: settings.scheduledTasksEnabled === false,
            })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("settings.agentMemory")}
          description={t("settings.agentMemoryDesc")}
        >
          <SettingsToggle
            checked={settings.agentMemoryEnabled === true}
            label={t("settings.agentMemory")}
            onChange={() => void saveSettings({
              agentMemoryEnabled: settings.agentMemoryEnabled === true,
            })}
          />
        </SettingsRow>
      </SettingsCard>

      {/* Usage and transfer stay next to the switch so "on" and "what it holds"
          are the same decision surface. */}
      {settings.agentMemoryEnabled === true ? <AgentMemoryPanel /> : null}

      <ComputerUseSettings t={t} settings={settings} saveSettings={saveSettings} />
    </div>
  );
}
