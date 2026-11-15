import { useTranslation } from "react-i18next";
import type { AppSettings, RemoteMediaPolicy } from "@pi-desktop/shared";
import { SettingsRow } from "../../features/settings/primitives";
import { SegmentedControl } from "../ui";

const OPTIONS = [
  { value: "click", labelKey: "settings.remoteMediaClick" },
  { value: "allow", labelKey: "settings.remoteMediaAllow" },
] as const satisfies readonly {
  value: RemoteMediaPolicy;
  labelKey: string;
}[];

/**
 * Remote media policy (Settings → Conversation). Absent or unknown values keep
 * the safe default: a reply's remote image/audio/video waits for a click, so
 * rendering it cannot reveal the user's IP to a host the model named.
 */
export function RemoteMediaRow({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const policy: RemoteMediaPolicy = settings.remoteMedia === "allow" ? "allow" : "click";
  return (
    <SettingsRow
      title={t("settings.remoteMedia")}
      description={t("settings.remoteMediaDesc")}
    >
      <SegmentedControl
        value={policy}
        onChange={(value) => void saveSettings({ remoteMedia: value })}
        options={OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        label={t("settings.remoteMedia")}
      />
    </SettingsRow>
  );
}
