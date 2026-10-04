import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createMessageRecallExtension } from "../src/index.js";
import { EXTENSION_COMMAND } from "../src/recall-constants.js";
import { saveRecallSettings } from "../src/recall-settings.js";
import { type RecallPickerOptions } from "../src/recall-types.js";
import { createCommandContext, createHarness, createShortcutContext } from "./test-harness.js";

// Never read the real ~/.pi agent settings: a customised shortcut there would break these tests.
const missingSettingsPath = join(
  tmpdir(),
  `pi-message-recall-missing-${process.pid}-${Date.now()}`,
  "settings.json"
);

void test("extension registers the /recall command and default Alt+R shortcut", () => {
  const harness = createHarness();
  createMessageRecallExtension(harness.pi, { settingsPath: missingSettingsPath });

  assert.ok(harness.commands.has(EXTENSION_COMMAND));
  assert.ok(harness.shortcuts.has("alt+r"));
});

void test("extension skips shortcut registration when the saved key is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-extension-"));
  const settingsPath = join(root, "settings.json");

  try {
    saveRecallSettings(
      {
        defaultScope: "project",
        pickerLayout: "balanced",
        shortcutEnabled: true,
        shortcutKey: "shift+tab",
      },
      settingsPath
    );

    const harness = createHarness();
    createMessageRecallExtension(harness.pi, {
      settingsPath,
    });

    assert.equal(harness.shortcuts.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("/recall restores the previous draft when the picker is cancelled", async () => {
  const harness = createHarness();
  // Captured rather than asserted inside the stub: /recall turns a throw there into a notification.
  let received: RecallPickerOptions | undefined;
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: async (_ctx, options) => {
      received = options;
      return undefined;
    },
  });

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createCommandContext({ editorText: "existing draft" });
  await command?.handler("", ctx);

  assert.ok(received, "the picker was opened");
  assert.equal(received.initialQuery, "existing draft");
  assert.equal(received.previousDraft, "existing draft");
  assert.deepEqual(ctx.notifications, []);
  assert.equal(ctx.waitForIdleCalls, 1);
  assert.deepEqual(ctx.setEditorTextCalls, []);
  assert.equal(ctx.ui.getEditorText(), "existing draft");
});

void test("/recall fills the editor with the selected message without auto-sending", async () => {
  const harness = createHarness();
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: async (_ctx, options) => {
      assert.equal(options.initialQuery, "find this");
      assert.equal(options.previousDraft, "draft");
      return {
        id: "picked",
        sessionPath: "/sessions/one.jsonl",
        sessionCwd: "/work/project",
        timestamp: 1,
        text: "remember this exact prompt",
        preview: "remember this exact prompt",
        normalizedText: "remember this exact prompt",
        isCurrentSession: false,
      };
    },
  });

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createCommandContext({ editorText: "draft" });
  await command?.handler("find this", ctx);

  assert.deepEqual(ctx.setEditorTextCalls, ["remember this exact prompt"]);
  assert.equal(ctx.ui.getEditorText(), "remember this exact prompt");
});

void test("/recall restores the previous draft if the picker throws", async () => {
  const harness = createHarness();
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: async (_ctx, options) => {
      assert.equal(options.previousDraft, "draft before failure");
      throw new Error("picker crashed");
    },
  });

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createCommandContext({ editorText: "draft before failure" });
  await command?.handler("", ctx);

  assert.deepEqual(ctx.setEditorTextCalls, []);
  assert.equal(ctx.ui.getEditorText(), "draft before failure");
  assert.match(ctx.notifications.at(-1) ?? "", /picker crashed/i);
});

void test("the shortcut opens recall only when Pi is idle", async () => {
  const harness = createHarness();
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: async () => undefined,
  });

  const shortcut = harness.shortcuts.get("alt+r");
  assert.ok(shortcut);

  const busyCtx = createShortcutContext({ idle: false });
  await shortcut?.handler(busyCtx);
  assert.match(busyCtx.notifications[0] ?? "", /wait for pi to finish/i);
});

void test("a second shortcut press while the picker is open does not stack another picker", async () => {
  const harness = createHarness();
  let pickerCalls = 0;
  const openPickers: (() => void)[] = [];
  const closePickers = () => {
    for (const close of openPickers.splice(0)) {
      close();
    }
  };
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: () => {
      pickerCalls += 1;
      return new Promise((resolve) => {
        openPickers.push(() => resolve(undefined));
      });
    },
  });

  const shortcut = harness.shortcuts.get("alt+r");
  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(shortcut && command);

  const ctx = createShortcutContext({ editorText: "draft" });
  const first = shortcut.handler(ctx);
  const second = shortcut.handler(ctx);
  const viaCommand = command.handler("", createCommandContext({ editorText: "draft" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pickerCalls, 1);

  closePickers();
  await Promise.all([first, second, viaCommand]);

  const reopened = shortcut.handler(ctx);
  assert.equal(pickerCalls, 2);
  closePickers();
  await reopened;
  assert.deepEqual(ctx.notifications, []);
});

void test("/recall explains that the picker needs the TUI in RPC mode", async () => {
  const harness = createHarness();
  let pickerOpened = false;
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: async () => {
      pickerOpened = true;
      return undefined;
    },
  });

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createCommandContext({ mode: "rpc", editorText: "draft" });
  await command?.handler("", ctx);

  assert.equal(pickerOpened, false);
  assert.equal(ctx.waitForIdleCalls, 0);
  assert.deepEqual(ctx.setEditorTextCalls, []);
  assert.match(ctx.notifications.at(-1) ?? "", /requires the interactive terminal UI/i);
});

void test("the shortcut does nothing outside the TUI", async () => {
  const harness = createHarness();
  let pickerOpened = false;
  createMessageRecallExtension(harness.pi, {
    settingsPath: missingSettingsPath,
    openPicker: async () => {
      pickerOpened = true;
      return undefined;
    },
  });

  const shortcut = harness.shortcuts.get("alt+r");
  assert.ok(shortcut);

  const ctx = createShortcutContext({ mode: "rpc" });
  await shortcut?.handler(ctx);

  assert.equal(pickerOpened, false);
  assert.deepEqual(ctx.notifications, []);
});

void test("the skipped-shortcut warning is shown once, and only in the TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-extension-"));
  const settingsPath = join(root, "settings.json");

  try {
    saveRecallSettings(
      {
        defaultScope: "project",
        pickerLayout: "balanced",
        shortcutEnabled: true,
        shortcutKey: "shift+tab",
      },
      settingsPath
    );

    const harness = createHarness();
    createMessageRecallExtension(harness.pi, { settingsPath });
    const [sessionStart] = harness.eventHandlers.get("session_start") ?? [];
    assert.ok(sessionStart);

    const rpcCtx = createShortcutContext({ mode: "rpc" });
    await sessionStart({ type: "session_start", reason: "startup" }, rpcCtx);
    assert.deepEqual(rpcCtx.notifications, []);

    const tuiCtx = createShortcutContext({ mode: "tui" });
    await sessionStart({ type: "session_start", reason: "startup" }, tuiCtx);
    await sessionStart({ type: "session_start", reason: "startup" }, tuiCtx);
    assert.equal(tuiCtx.notifications.length, 1);
    assert.match(tuiCtx.notifications[0] ?? "", /shortcut .* was not installed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("a saved shortcut that Pi reserves is reported at session start and in /recall status", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-extension-"));
  const settingsPath = join(root, "settings.json");

  try {
    saveRecallSettings(
      {
        defaultScope: "project",
        pickerLayout: "balanced",
        shortcutEnabled: true,
        shortcutKey: "ctrl+x",
      },
      settingsPath
    );

    const harness = createHarness();
    createMessageRecallExtension(harness.pi, {
      settingsPath,
      getKeybindings: () => ({ "app.message.copy": "ctrl+x" }),
    });
    assert.ok(harness.shortcuts.has("ctrl+x"));

    const [sessionStart] = harness.eventHandlers.get("session_start") ?? [];
    assert.ok(sessionStart);
    const ctx = createShortcutContext({ mode: "tui" });
    await sessionStart({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0] ?? "", /Ctrl\+X conflicts with Pi: .*app\.message\.copy/);

    const command = harness.commands.get(EXTENSION_COMMAND);
    const statusCtx = createCommandContext();
    await command?.handler("status", statusCtx);
    assert.match(statusCtx.notifications.at(-1) ?? "", /Ctrl\+X \(conflicts with Pi: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("/recall status names the configured scope key in the TUI and Tab elsewhere", async () => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.tab": "ctrl+t" }));

  try {
    const harness = createHarness();
    createMessageRecallExtension(harness.pi, { settingsPath: missingSettingsPath });
    const command = harness.commands.get(EXTENSION_COMMAND);

    const tuiCtx = createCommandContext({ mode: "tui" });
    await command?.handler("status", tuiCtx);
    assert.match(tuiCtx.notifications.at(-1) ?? "", /Picker scope toggle: ctrl\+t$/m);

    const rpcCtx = createCommandContext({ mode: "rpc" });
    await command?.handler("status", rpcCtx);
    assert.match(rpcCtx.notifications.at(-1) ?? "", /Picker scope toggle: Tab$/m);
  } finally {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
  }
});
