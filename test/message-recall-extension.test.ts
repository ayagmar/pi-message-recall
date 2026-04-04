import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXTENSION_COMMAND } from "../src/recall-constants.js";
import { createMessageRecallExtension } from "../src/index.js";
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
