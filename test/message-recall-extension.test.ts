import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMessageRecallExtension } from "../src/index.js";
import { EXTENSION_COMMAND } from "../src/recall-constants.js";
import { saveRecallSettings } from "../src/recall-settings.js";
import { createCommandContext, createHarness, createShortcutContext } from "./test-harness.js";

void test("extension registers the /recall command and default Alt+R shortcut", () => {
  const harness = createHarness();
  createMessageRecallExtension(harness.pi);

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
  createMessageRecallExtension(harness.pi, {
    openPicker: async (_ctx, options) => {
      assert.equal(options.initialQuery, "existing draft");
      assert.equal(options.previousDraft, "existing draft");
      return undefined;
    },
  });

  const command = harness.commands.get(EXTENSION_COMMAND);
  assert.ok(command);

  const ctx = createCommandContext({ editorText: "existing draft" });
  await command?.handler("", ctx);

  assert.equal(ctx.waitForIdleCalls, 1);
  assert.deepEqual(ctx.setEditorTextCalls, []);
  assert.equal(ctx.ui.getEditorText(), "existing draft");
});

void test("/recall fills the editor with the selected message without auto-sending", async () => {
  const harness = createHarness();
  createMessageRecallExtension(harness.pi, {
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
    openPicker: async () => undefined,
  });

  const shortcut = harness.shortcuts.get("alt+r");
  assert.ok(shortcut);

  const busyCtx = createShortcutContext({ idle: false });
  await shortcut?.handler(busyCtx);
  assert.match(busyCtx.notifications[0] ?? "", /wait for pi to finish/i);
});

void test("/recall explains that the picker needs the TUI in RPC mode", async () => {
  const harness = createHarness();
  let pickerOpened = false;
  createMessageRecallExtension(harness.pi, {
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
