import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerCommand } from "@pi-desktop/shared";
import { useAppStore } from "../../../stores/app-store";
import {
  fetchComposerCommands,
  readComposerCommandsCache,
} from "../../../lib/composer-command-source";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import {
  IconBookOpen,
  IconPaperclip,
  IconPlug,
  IconSlash,
  IconSparkles,
} from "../../../components/icons";

/**
 * The composer's add menu: attachments first, then the same built-in and
 * plugin commands the `/` autocomplete lists. ZCode-style grouping keeps the
 * attachment action visible instead of hiding it behind a modifier.
 */
/** Built-ins that must show even before the host command read resolves. */
const FALLBACK_BUILTINS: ComposerCommand[] = [
  "new",
  "compact",
  "agent-mode",
  "plan-mode",
  "goal-mode",
  "fast",
].map((name) => ({ name, kind: "builtin", title: "" }));

export function ComposerPlusMenu({
  open,
  setOpen,
  controlsBlocked,
  pasting,
  attachmentsAllowed,
  onCloseOtherMenus,
  onAttach,
  onPickCommand,
}: {
  open: boolean;
  setOpen: (next: boolean) => void;
  controlsBlocked: boolean;
  pasting: boolean;
  attachmentsAllowed: boolean;
  onCloseOtherMenus: () => void;
  onAttach: () => void;
  onPickCommand: (name: string) => void;
}) {
  const { t } = useTranslation();
  const workspace = useAppStore((state) => state.workspace?.path ?? "");
  const [commands, setCommands] = useState<ComposerCommand[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cached = readComposerCommandsCache(workspace);
    if (cached) {
      setCommands(cached);
      return;
    }
    void fetchComposerCommands(workspace)
      .then((list) => {
        if (!cancelled) setCommands(list);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspace]);

  const builtin = commands.some((command) => command.kind === "builtin")
    ? commands.filter((command) => command.kind === "builtin")
    : FALLBACK_BUILTINS;
  // ZCode's panel lists plugins, not every MCP tool; deeper tool names stay
  // reachable through the typed "/" list.
  const others = commands
    .filter(
      (command) =>
        command.kind !== "builtin" &&
        (command.kind === "plugin" || command.kind === "extension" || command.kind === "mcp") &&
        command.name.split(":").length <= 2,
    )
    .slice(0, 16);

  const row = (command: ComposerCommand) => (
    <button
      key={`${command.kind}:${command.name}`}
      type="button"
      role="menuitem"
      className="composer-plus-item composer-add-item"
      disabled={controlsBlocked}
      onClick={() => {
        setOpen(false);
        onPickCommand(command.name);
      }}
    >
      <span className="composer-add-icon" aria-hidden>
        {command.kind === "skill" ? (
          <IconBookOpen size={14} />
        ) : command.kind === "builtin" ? (
          <IconSparkles size={14} />
        ) : (
          <IconPlug size={14} />
        )}
      </span>
      <span className="composer-add-name">/{command.name}</span>
      <span className="composer-add-detail">{command.title}</span>
    </button>
  );

  return (
    <AnchoredMenu
      className="composer-add"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-mode-menu composer-add-menu"
      label={t("chat.addFiles")}
      role="menu"
      align="start"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className="icon-btn icon-btn-square"
          tooltip={t("chat.addFiles")}
          ariaLabel={t("chat.addFiles")}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={controlsBlocked || pasting}
          onClick={() => {
            onCloseOtherMenus();
            setOpen(!open);
          }}
        >
          <IconPaperclip size={15} aria-hidden />
        </TooltipButton>
      )}
    >
      <div className="composer-add-group" aria-hidden>
        {t("chat.addFiles")}
      </div>
      <button
        type="button"
        role="menuitem"
        className="composer-plus-item composer-add-item"
        disabled={controlsBlocked || pasting || !attachmentsAllowed}
        onClick={() => {
          setOpen(false);
          void onAttach();
        }}
      >
        <span className="composer-add-icon" aria-hidden>
          <IconPaperclip size={14} />
        </span>
        <span className="composer-add-name">{t("chat.addFiles")}</span>
        <span className="composer-add-detail">文件、图片或目录</span>
      </button>

      <div className="composer-menu-separator" role="separator" />
      <div className="composer-add-group" aria-hidden>
        {t("chat.slashMenu")}
      </div>
      {builtin.map(row)}
      {others.length > 0 ? (
        <>
          <div className="composer-menu-separator" role="separator" />
          <div className="composer-add-group" aria-hidden>
            {t("chat.slashGroupPlugins")}
          </div>
          {others.map(row)}
        </>
      ) : null}

      <div className="composer-add-hints" aria-hidden>
        <span>
          <kbd>@</kbd> 添加上下文
        </span>
        <span>
          <kbd>/</kbd> 选择能力
        </span>
      </div>
    </AnchoredMenu>
  );
}

/** One command glyph, shared by the add menu and future pickers. */
export function CommandGlyph({ kind }: { kind: ComposerCommand["kind"] }) {
  if (kind === "skill") return <IconBookOpen size={14} />;
  if (kind === "builtin") return <IconSparkles size={14} />;
  return <IconSlash size={14} />;
}
