/**
 * Data destination (fork addition): import external coding-agent sessions —
 * Claude Code, Codex, OpenCode, and pi CLI — into this installation through
 * the host-owned `session.import` API.
 *
 * The scan runs on this machine's local agent session stores; imported rows
 * become ordinary sessions and no foreign files are kept after import.
 */
import { SessionImportPanel } from "./imports/SessionImportPanel";
import { SettingsCard } from "./primitives";
import { useTranslation } from "react-i18next";

export function DataImportSection() {
  const { t } = useTranslation();
  return (
    <SettingsCard title={t("settings.importSessionsTitle")}>
      <SessionImportPanel />
    </SettingsCard>
  );
}
