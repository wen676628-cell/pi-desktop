import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import {
  keybindingDisplayParts,
  type Mode,
  type PermissionMode,
  type ShortcutPlatform,
  type SessionThinkingLevel,
  type PluginComposerTransformMeta,
} from "@pi-desktop/shared";
import { type AppState, useAppStore } from "../../../stores/app-store";
import { modeErrorMessage } from "../../modes/mode-run-model";
import { ComposerPermissionPicker } from "./ComposerPermissionPicker";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { ContextUsageInspector } from "../../../components/ContextUsageInspector";
import { ComposerControlSlots } from "./ComposerControlSlots";
import { TooltipButton } from "../../../components/ui";
import {
  IconArrowUp,
  IconSparkles,
  IconStop,
  IconUndo2,
} from "../../../components/icons";
import { LiveVoiceControls } from "../../voice/live/LiveVoiceControls";
import { ComputerUseIndicator } from "../../computer-use/ComputerUseIndicator";
import { ComposerModelPicker } from "./ComposerModelPicker";
import type { useComposerModelMenu } from "./hooks/useComposerModelMenu";

type ModelMenuController = ReturnType<typeof useComposerModelMenu>;
type ContextUsage = Parameters<typeof ContextUsageInspector>[0];

export type ComposerToolbarProps = {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  providerId?: string;
  modelId?: string;
  thinkingLevel: SessionThinkingLevel;
  composerPermissionMode: Exclude<PermissionMode, "inherit">;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  localToolsAllowed?: boolean;
  attachmentsAllowed?: boolean;
  stopAllowed?: boolean;
  pasting: boolean;
  pickAndAttach: () => Promise<void>;
  plusOpen: boolean;
  setPlusOpen: Dispatch<SetStateAction<boolean>>;
  /** Inserts `/name ` into the draft from the add menu. */
  onPickCommand: (name: string) => void;
  configureActiveSession: AppState["configureActiveSession"];
  showToast: AppState["showToast"];
  modelMenu: ModelMenuController;
  modelLabel: string;
  thinkingLabel: string;
  /** The selected model asks for OpenAI's priority tier (ADR 0334). */
  modelFastMode?: boolean;
  contextUsage: ContextUsage | null;
  value: string;
  modelReady: boolean;
  sendBlocked: boolean;
  composerTransforms: PluginComposerTransformMeta[];
  activeTransformKey: string | null;
  undoTransform: PluginComposerTransformMeta | null;
  runComposerTransform: (transform: PluginComposerTransformMeta) => Promise<void>;
  undoComposerTransform: () => void;
  runActive: boolean;
  hasDraftContent: boolean;
  abort: AppState["abort"];
  submit: () => Promise<void>;
  workSessionId?: string;
  workSessionLabel?: string;
};

/** Composer controls: mode, permission, model, plugin actions, and send/stop. */
export function ComposerToolbar({
  t,
  mode,
  planningLive,
  providerId,
  modelId,
  thinkingLevel,
  composerPermissionMode,
  permissionOpen,
  setPermissionOpen,
  controlsBlocked,
  localToolsAllowed = true,
  attachmentsAllowed = true,
  stopAllowed = true,
  pasting,
  pickAndAttach,
  plusOpen,
  setPlusOpen,
  onPickCommand,
  configureActiveSession,
  showToast,
  modelMenu,
  modelLabel,
  thinkingLabel,
  modelFastMode = false,
  contextUsage,
  value,
  modelReady,
  sendBlocked,
  composerTransforms,
  activeTransformKey,
  undoTransform,
  runComposerTransform,
  undoComposerTransform,
  runActive,
  hasDraftContent,
  abort,
  submit,
  workSessionId,
  workSessionLabel,
}: ComposerToolbarProps) {
  const platform = (window.piDesktop?.platform ?? "darwin") as ShortcutPlatform;
  const steeringShortcut = keybindingDisplayParts("Alt+Enter", platform).join("+");
  return (
    <div className="composer-toolbar">
      <div className="composer-left">
        <div className="composer-plus">
          <ComposerPlusMenu
            open={plusOpen}
            setOpen={setPlusOpen}
            controlsBlocked={controlsBlocked}
            pasting={pasting}
            attachmentsAllowed={attachmentsAllowed}
            onCloseOtherMenus={() => {
              setPermissionOpen(false);
              modelMenu.setOpen(false);
            }}
            onAttach={() => void pickAndAttach()}
            onPickCommand={onPickCommand}
          />
        </div>
        {localToolsAllowed ? <LiveVoiceControls t={t} workSessionId={workSessionId} /> : null}
        {localToolsAllowed ? (
          <ComputerUseIndicator sessionId={workSessionId ?? null} abort={abort} />
        ) : null}
        <ComposerPermissionPicker t={t} mode={mode}
          composerPermissionMode={composerPermissionMode}
          permissionOpen={permissionOpen} setPermissionOpen={setPermissionOpen}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => {
            modelMenu.setOpen(false);
            setPlusOpen(false);
          }}
          onSelect={async (candidate) => {
                try {
                  await configureActiveSession({
                    mode,
                    providerId,
                    modelId,
                    thinkingLevel,
                    permissionMode: candidate,
                  });
                } catch (error) {
                  showToast(error instanceof Error ? error.message : String(error), {
                    variant: "error",
                  });
                }
          }} />
        {localToolsAllowed ? <ComposerControlSlots side="left" /> : null}
      </div>

      <div className="composer-right">
        {localToolsAllowed ? <ComposerControlSlots side="right" /> : null}
        {contextUsage ? <ContextUsageInspector {...contextUsage} /> : null}
        <ComposerModelPicker
          t={t}
          controller={modelMenu}
          modelLabel={modelLabel}
          thinkingLabel={thinkingLabel}
          fastMode={modelFastMode}
          thinkingLevel={thinkingLevel}
          selectedProviderId={providerId}
          selectedModelId={modelId}
          controlsBlocked={controlsBlocked}
          onCloseOtherMenus={() => setPermissionOpen(false)}
          onOpenModelSettings={() => useAppStore.getState().setSettingsTab("agent")}
        />
        {composerTransforms.map((transform) => {
          const key = `${transform.pluginId}/${transform.id}`;
          const isActive = activeTransformKey === key;
          return (
          <TooltipButton
            key={key}
            type="button"
            className={`icon-btn icon-btn-square composer-plugin-transform-btn${isActive ? " is-loading" : ""}`}
            tooltip={transform.title}
            ariaLabel={transform.title}
            aria-busy={isActive}
            disabled={
              !value.trim() ||
              value.trim().startsWith("/") ||
              controlsBlocked ||
              sendBlocked ||
              pasting ||
              activeTransformKey !== null
            }
            onClick={() => void runComposerTransform(transform)}
          >
            {isActive ? <span className="tool-spinner" aria-hidden="true" /> : <IconSparkles size={15} aria-hidden="true" />}
          </TooltipButton>
          );
        })}
        {undoTransform ? (
          <TooltipButton
            type="button"
            className="icon-btn icon-btn-square composer-plugin-transform-undo"
            tooltip={undoTransform.undoTitle}
            ariaLabel={undoTransform.undoTitle}
            disabled={controlsBlocked}
            onClick={undoComposerTransform}
          >
            <IconUndo2 size={15} aria-hidden="true" />
          </TooltipButton>
        ) : null}
        {runActive && !hasDraftContent ? (
          <TooltipButton
            type="button"
            className="stop-btn"
            tooltip={t("chat.stopGenerating")}
            ariaLabel={t("chat.stopGenerating")}
            disabled={!stopAllowed}
            onClick={() => void abort()}
          >
            <IconStop size={14} />
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className="send-btn"
            ariaLabel={modelReady ? t("chat.send") : t("settings.addProvider")}
            tooltip={
              runActive
                ? t("chat.sendWhileRunning", { shortcut: steeringShortcut })
                : modelReady
                  ? t("chat.send")
                  : t("settings.addProvider")
            }
            disabled={
              !hasDraftContent ||
              sendBlocked ||
              (!modelReady && !value.trim().startsWith("/"))
            }
            onClick={() => void submit()}
          >
            <IconArrowUp size={15} />
          </TooltipButton>
        )}
      </div>
    </div>
  );
}
