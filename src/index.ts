import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  keyText,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { getRecallArgumentCompletions, parseRecallCommandArgs } from "./recall-command.js";
import { EXTENSION_COMMAND } from "./recall-constants.js";
import { openRecallPicker, openRecallSettingsFlow } from "./recall-dialogs.js";
import { findGitRepoRoot } from "./recall-history.js";
import {
  buildRecallStatusText,
  getRecallSettingsPath,
  loadRecallSettings,
} from "./recall-settings.js";
import { getShortcutStatus } from "./recall-shortcut.js";
import {
  type RecallMessage,
  type RecallPickerOptions,
  type RecallSettings,
  type RecallSettingsFlowResult,
} from "./recall-types.js";

export default function messageRecallExtension(pi: ExtensionAPI): void {
  createMessageRecallExtension(pi);
}

export function createMessageRecallExtension(
  pi: ExtensionAPI,
  options?: {
    settingsPath?: string;
    openPicker?: (
      ctx: ExtensionContext,
      options: RecallPickerOptions
    ) => Promise<RecallMessage | undefined>;
    openSettings?: (
      ctx: ExtensionContext,
      options: Parameters<typeof openRecallSettingsFlow>[1]
    ) => Promise<RecallSettingsFlowResult | undefined>;
    /** Pi's resolved keybindings; only consulted in the TUI, where Pi has installed them. */
    getKeybindings?: () => KeybindingsConfig;
  }
): void {
  const settingsPath = options?.settingsPath ?? getRecallSettingsPath();
  const showPicker = options?.openPicker ?? openRecallPicker;
  const showSettings = options?.openSettings ?? openRecallSettingsFlow;
  const readKeybindings = options?.getKeybindings ?? readPiKeybindings;
  const findRepoRoot = (cwd: string, signal?: AbortSignal) =>
    findGitRepoRoot(
      (command, args, execOptions) => pi.exec(command, args, execOptions),
      cwd,
      signal
    );
  const getRuntimeShortcutStatus = (ctx: ExtensionContext) =>
    getShortcutStatus(settings, ctx.mode === "tui" ? readKeybindings() : undefined);

  let settings = loadRecallSettings(settingsPath);
  // Set while a picker is open so a repeated shortcut or /recall cannot stack a second overlay
  // that would snapshot (and later restore) a stale draft.
  let pickerOpen = false;
  const openPickerOnce = async (ctx: ExtensionContext, initialQuery?: string): Promise<void> => {
    if (pickerOpen) {
      return;
    }

    pickerOpen = true;
    try {
      await runRecallPicker(ctx, showPicker, { settings, findRepoRoot }, initialQuery);
    } finally {
      pickerOpen = false;
    }
  };
  const startupShortcutStatus = getShortcutStatus(settings);
  let notifiedShortcutIssue = false;

  if (startupShortcutStatus.state === "active") {
    pi.registerShortcut(startupShortcutStatus.key, {
      description: "Recall a previous user message into the editor",
      handler: async (ctx) => {
        if (ctx.mode !== "tui") {
          return;
        }

        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait for Pi to finish, then open Message Recall.", "info");
          return;
        }

        try {
          await openPickerOnce(ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (notifiedShortcutIssue || ctx.mode !== "tui") {
      return;
    }

    if (startupShortcutStatus.state === "skipped") {
      notifiedShortcutIssue = true;
      ctx.ui.notify(
        `Message Recall shortcut ${startupShortcutStatus.label} was not installed: ${startupShortcutStatus.detail} Use /${EXTENSION_COMMAND} or /${EXTENSION_COMMAND} settings.`,
        "warning"
      );
      return;
    }

    // Pi resolves keybindings (defaults plus keybindings.json) after extensions load, so reserved
    // key conflicts can only be detected once the session starts.
    const shortcutStatus = getRuntimeShortcutStatus(ctx);
    if (startupShortcutStatus.state === "active" && shortcutStatus.state === "conflict") {
      notifiedShortcutIssue = true;
      ctx.ui.notify(
        `Message Recall shortcut ${shortcutStatus.label} conflicts with Pi: ${shortcutStatus.detail} /${EXTENSION_COMMAND} always works.`,
        "warning"
      );
    }
  });

  pi.registerCommand(EXTENSION_COMMAND, {
    description: "Recall a previous user message into the editor",
    getArgumentCompletions: getRecallArgumentCompletions,
    handler: async (args, ctx) => {
      const command = parseRecallCommandArgs(args);

      try {
        switch (command.kind) {
          case "status": {
            ctx.ui.notify(
              buildRecallStatusText({
                settings,
                settingsPath,
                shortcutStatus: getRuntimeShortcutStatus(ctx),
                scopeToggleKey: getScopeToggleKey(ctx),
              }),
              "info"
            );
            return;
          }

          case "settings": {
            await handleSettingsCommand(ctx, {
              settings,
              settingsPath,
              openSettings: showSettings,
              onSettingsChange: (nextSettings) => {
                settings = nextSettings;
              },
            });
            return;
          }

          case "picker": {
            // The picker is a custom TUI overlay; ctx.ui.custom() is a no-op in RPC mode.
            if (ctx.mode !== "tui") {
              ctx.ui.notify(
                `/${EXTENSION_COMMAND} requires the interactive terminal UI. Use /${EXTENSION_COMMAND} status or /${EXTENSION_COMMAND} settings instead.`,
                "error"
              );
              return;
            }

            await ctx.waitForIdle();
            await openPickerOnce(ctx, command.initialQuery);
            return;
          }
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

async function handleSettingsCommand(
  ctx: ExtensionCommandContext,
  options: {
    settings: RecallSettings;
    settingsPath: string;
    openSettings: (
      ctx: ExtensionContext,
      options: Parameters<typeof openRecallSettingsFlow>[1]
    ) => Promise<RecallSettingsFlowResult | undefined>;
    onSettingsChange: (settings: RecallSettings) => void;
  }
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      buildRecallStatusText({
        settings: options.settings,
        settingsPath: options.settingsPath,
        shortcutStatus: getShortcutStatus(options.settings),
        scopeToggleKey: getScopeToggleKey(ctx),
      }),
      "info"
    );
    return;
  }

  const result = await options.openSettings(ctx, {
    settings: options.settings,
    settingsPath: options.settingsPath,
  });
  if (!result) {
    return;
  }

  options.onSettingsChange(result.settings);

  if (result.reloadRequired) {
    ctx.ui.notify("Reloading Message Recall to apply shortcut changes…", "info");
    await ctx.reload();
  }
}

async function runRecallPicker(
  ctx: ExtensionContext,
  showPicker: (
    ctx: ExtensionContext,
    options: RecallPickerOptions
  ) => Promise<RecallMessage | undefined>,
  pickerOptions: Pick<RecallPickerOptions, "settings" | "findRepoRoot">,
  initialQuery = ""
): Promise<void> {
  const previousDraft = ctx.ui.getEditorText();
  const effectiveInitialQuery =
    initialQuery.length > 0 ? initialQuery : previousDraft.replace(/\s+/g, " ").trim();

  try {
    const recalledMessage = await showPicker(ctx, {
      ...pickerOptions,
      initialQuery: effectiveInitialQuery,
      previousDraft,
    });

    if (!recalledMessage) {
      if (ctx.ui.getEditorText() !== previousDraft) {
        ctx.ui.setEditorText(previousDraft);
      }
      return;
    }

    if (ctx.ui.getEditorText() !== recalledMessage.text) {
      ctx.ui.setEditorText(recalledMessage.text);
    }
  } catch (error) {
    if (ctx.ui.getEditorText() !== previousDraft) {
      ctx.ui.setEditorText(previousDraft);
    }
    throw error;
  }
}

// Pi's keybindings are only loaded in the interactive UI; elsewhere the status text keeps "Tab".
function getScopeToggleKey(ctx: ExtensionContext): string | undefined {
  return ctx.mode === "tui" ? keyText("tui.input.tab") : undefined;
}

function readPiKeybindings(): KeybindingsConfig | undefined {
  try {
    return getKeybindings().getResolvedBindings();
  } catch {
    return undefined;
  }
}
