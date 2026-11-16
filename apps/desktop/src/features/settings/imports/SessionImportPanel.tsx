import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ImportCandidate } from "../../../lib/api";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import {
  ImportGroup,
  ImportIdle,
  ImportResults,
  ImportRow,
  ImportToolbar,
  toggleKey,
  useGroupDisclosure,
} from "../import-workbench";

/* ---------------------------------------------------------------------------
 * External coding-agent sessions (Claude Code / Codex / OpenCode / pi)
 *
 * The scan runs on this machine's local agent session stores and the import
 * writes through the host-owned `session.import` API, so imported rows become
 * ordinary sessions — no foreign files are kept around after import.
 * ------------------------------------------------------------------------- */

function messageCountLabel(
  t: (key: string, values?: Record<string, unknown>) => string,
  count: number | null,
): string {
  if (count === null) return t("settings.importSessionsUnknownCount");
  return t("settings.importSessionsCount", { count });
}

export function SessionImportPanel() {
  const { t } = useTranslation();
  const refreshSessions = useAppStore((s) => s.refreshSessions);
  const showToast = useAppStore((s) => s.showToast);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ImportCandidate) =>
    `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportSessions();
      setCandidates(res.sessions ?? (res as unknown as { sessions: ImportCandidate[] }).sessions);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runImportSessions(items);
      await refreshSessions();
      showToast(
        t("settings.importResult", {
          imported: res.imported,
          skipped: res.skipped,
          failed: res.failed,
        }),
        { variant: res.failed > 0 ? "error" : "success" },
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const sourceLabels: Record<ImportCandidate["source"], string> = useMemo(
    () => ({
      "claude-code": t("settings.importSourceClaudeCode"),
      opencode: t("settings.importSourceOpenCode"),
      codex: t("settings.importSourceCodex"),
      pi: t("settings.importSourcePi"),
    }),
    [t],
  );

  const groups = useMemo(() => {
    if (!candidates) return [];
    const grouped = new Map<ImportCandidate["source"], ImportCandidate[]>();
    for (const candidate of candidates) {
      const items = grouped.get(candidate.source) ?? [];
      items.push(candidate);
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      grouped.set(candidate.source, items);
    }
    return [...grouped.entries()].map(([source, items]) => ({
      id: source,
      name: sourceLabels[source],
      items,
    }));
  }, [candidates, sourceLabels]);

  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="import-workbench">
      {candidates === null ? (
        <ImportIdle
          description={t("settings.importSessionsScanDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importSessionsFound", { count: candidates.length })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSessionsSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults
            message={
              candidates.length === 0 ? t("settings.importSessionsNone") : undefined
            }
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-session-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    count={group.items.length}
                    countLabel={t("settings.importSessionsFound", {
                      count: group.items.length,
                    })}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      label: t("settings.importSessionsSelectGroup", { name: group.name }),
                      checked: groupSelected === groupKeys.length,
                      indeterminate:
                        groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((item) => (
                      <ImportRow
                        key={keyOf(item)}
                        title={item.title}
                        meta={`${messageCountLabel(t, item.messageCount)}${
                          item.projectPath ? ` · ${item.projectPath}` : ""
                        }`}
                        checked={selected.has(keyOf(item))}
                        onChange={(on) =>
                          setSelected((previous) => toggleKey(previous, keyOf(item), on))
                        }
                      />
                    ))}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}
