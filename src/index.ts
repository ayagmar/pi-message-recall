import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getRecallArgumentCompletions, parseRecallCommandArgs } from "./recall-command.js";
import { EXTENSION_COMMAND } from "./recall-constants.js";
import { openRecallPicker, openRecallSettingsFlow } from "./recall-dialogs.js";
import {
  buildRecallStatusText,
  getRecallSettingsPath,
  loadRecallSettings,
} from "./recall-settings.js";
import { getShortcutStatus } from "./recall-shortcut.js";
import { type RecallMessage, type RecallSettingsFlowResult } from "./recall-types.js";

export default function messageRecallExtension(pi: ExtensionAPI): void {
  createMessageRecallExtension(pi);
}

export function createMessageRecallExtension(
  pi: ExtensionAPI,
  options?: {
    settingsPath?: string;
    openPicker?: (
      ctx: ExtensionContext,
      options: Parameters<typeof openRecallPicker>[1]
    ) => Promise<RecallMessage | undefined>;
    openSettings?: (
      ctx: ExtensionContext,
      options: Parameters<typeof openRecallSettingsFlow>[1]
    ) => Promise<RecallSettingsFlowResult | undefined>;
  }
): void {
  const settingsPath = options?.settingsPath ?? getRecallSettingsPath();
  const showPicker = options?.openPicker ?? openRecallPicker;
  const showSettings = options?.openSettings ?? openRecallSettingsFlow;

  let settings = loadRecallSettings(settingsPath);
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
          await runRecallPicker(ctx, settings, showPicker);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (notifiedShortcutIssue || ctx.mode !== "tui" || startupShortcutStatus.state !== "skipped") {
      return;
    }

    notifiedShortcutIssue = true;
    ctx.ui.notify(
      `Message Recall shortcut ${startupShortcutStatus.label} was not installed: ${startupShortcutStatus.detail} Use /${EXTENSION_COMMAND} or /${EXTENSION_COMMAND} settings.`,
      "warning"
    );
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
                shortcutStatus: getShortcutStatus(settings),
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
            await runRecallPicker(ctx, settings, showPicker, command.initialQuery);
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
    settings: Parameters<typeof buildRecallStatusText>[0]["settings"];
    settingsPath: string;
    openSettings: (
      ctx: ExtensionContext,
      options: Parameters<typeof openRecallSettingsFlow>[1]
    ) => Promise<RecallSettingsFlowResult | undefined>;
    onSettingsChange: (settings: Parameters<typeof buildRecallStatusText>[0]["settings"]) => void;
  }
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      buildRecallStatusText({
        settings: options.settings,
        settingsPath: options.settingsPath,
        shortcutStatus: getShortcutStatus(options.settings),
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
  settings: Parameters<typeof buildRecallStatusText>[0]["settings"],
  showPicker: (
    ctx: ExtensionContext,
    options: Parameters<typeof openRecallPicker>[1]
  ) => Promise<RecallMessage | undefined>,
  initialQuery = ""
): Promise<void> {
  const previousDraft = ctx.ui.getEditorText();
  const effectiveInitialQuery =
    initialQuery.length > 0 ? initialQuery : previousDraft.replace(/\s+/g, " ").trim();

  try {
    const recalledMessage = await showPicker(ctx, {
      settings,
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
