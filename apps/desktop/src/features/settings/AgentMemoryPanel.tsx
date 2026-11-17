/**
 * Agent memory usage panel (ADR agent-long-term-memory, rollout 4).
 *
 * Shows what the memory server holds per scope and lets the user move memory
 * between machines as a plain JSON package. Device-local memory is absent by
 * design: it names this machine's paths and never leaves it.
 *
 * Rendered only while the Agent memory switch is on; the switch itself lives
 * in the Execution card. Rows reuse the settings primitives so the panel adds
 * no page-specific chrome.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button } from "../../components/ui";
import { api, type AgentMemoryStatus } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";

export function AgentMemoryPanel() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [status, setStatus] = useState<AgentMemoryStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.agentMemoryStatus());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scopeLabel = (target: AgentMemoryStatus["scopes"][number]["target"]) =>
    t(`settings.agentMemoryScope_${target}`);

  const onExport = async () => {
    setBusy(true);
    try {
      const result = await api.exportAgentMemory();
      if (result.saved) {
        showToast(t("settings.agentMemoryExported", { count: result.entries }), {
          variant: "success",
        });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setBusy(true);
    try {
      const result = await api.importAgentMemory();
      if (result.imported) {
        showToast(
          t("settings.agentMemoryImported", {
            added: result.result.added,
            duplicates: result.result.duplicates,
            tombstoned: result.result.tombstoned,
          }),
          { variant: "success" },
        );
        await refresh();
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const actions = (
    <div className="settings-row-control">
      <Button variant="secondary" disabled={busy} onClick={() => void onExport()}>
        {t("settings.agentMemoryExport")}
      </Button>
      <Button variant="secondary" disabled={busy} onClick={() => void onImport()}>
        {t("settings.agentMemoryImport")}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
        {t("settings.agentMemoryRefresh")}
      </Button>
    </div>
  );

  return (
    <SettingsCard title={t("settings.agentMemoryUsageTitle")}>
      {status === null ? null : status.scopes.length === 0 ? (
        <SettingsRow title={t("settings.agentMemoryEmpty")}>{null}</SettingsRow>
      ) : (
        status.scopes.map((scope) => (
          <SettingsRow
            key={scope.id}
            title={
              scope.projectId
                ? `${scope.projectId} · ${scopeLabel(scope.target)}`
                : scopeLabel(scope.target)
            }
            description={t("settings.agentMemoryUsage", {
              entries: scope.entries,
              max: scope.maxEntries,
            })}
          >
            {scope.overBudget ? (
              <Badge tone="warning">{t("settings.agentMemoryOverBudget")}</Badge>
            ) : null}
          </SettingsRow>
        ))
      )}
      <SettingsRow
        title={t("settings.agentMemoryTransfer")}
        description={t("settings.agentMemoryTransferDesc")}
      >
        {actions}
      </SettingsRow>
    </SettingsCard>
  );
}
