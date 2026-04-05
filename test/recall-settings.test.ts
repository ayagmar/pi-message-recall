import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildRecallStatusText,
  createRecallSettings,
  getRecallSettingsPath,
  loadRecallSettings,
  normalizeRecallSettings,
  saveRecallSettings,
} from "../src/recall-settings.js";
import { getShortcutStatus, validateShortcutKey } from "../src/recall-shortcut.js";

void test("createRecallSettings returns the default scope, layout, and shortcut", () => {
  assert.deepEqual(createRecallSettings(), {
    defaultScope: "project",
    pickerLayout: "balanced",
    shortcutEnabled: true,
    shortcutKey: "alt+r",
  });
});

void test("normalizeRecallSettings repairs malformed values", () => {
  const settings = normalizeRecallSettings({
    defaultScope: "invalid",
    pickerLayout: "massive",
    shortcutEnabled: "yes",
    shortcutKey: "",
  });

  assert.deepEqual(settings, createRecallSettings());
});

void test("saveRecallSettings and loadRecallSettings round-trip through the extension settings path", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-settings-"));
  const settingsPath = getRecallSettingsPath(root);

  try {
    const next = {
      ...createRecallSettings(),
      defaultScope: "all" as const,
      pickerLayout: "wide" as const,
      shortcutEnabled: false,
      shortcutKey: "alt+r",
    };

    saveRecallSettings(next, settingsPath);

    assert.match(readFileSync(settingsPath, "utf-8"), /"defaultScope": "all"/);
    assert.match(readFileSync(settingsPath, "utf-8"), /"pickerLayout": "wide"/);
    assert.deepEqual(loadRecallSettings(settingsPath), next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("loadRecallSettings falls back to defaults when settings.json is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-invalid-"));
  const settingsPath = getRecallSettingsPath(root);

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{not valid json\n", "utf-8");

    assert.deepEqual(loadRecallSettings(settingsPath), createRecallSettings());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("shortcut validation accepts valid combos and rejects plain typing", () => {
  assert.equal(validateShortcutKey("ctrl+r").normalized, "ctrl+r");
  assert.equal(validateShortcutKey("alt+r").normalized, "alt+r");
  assert.match(validateShortcutKey("r").error ?? "", /must include ctrl and\/or alt/i);
});

void test("getShortcutStatus reports active and skipped shortcuts", () => {
  const active = getShortcutStatus(createRecallSettings());
  assert.equal(active.state, "active");

  const skipped = getShortcutStatus({
    ...createRecallSettings(),
    shortcutKey: "shift+tab",
  });
  assert.equal(skipped.state, "skipped");
  assert.match(skipped.detail, /saved shortcut is invalid/i);
});

void test("buildRecallStatusText includes the settings path and active shortcut state", () => {
  const text = buildRecallStatusText({
    settings: createRecallSettings(),
    settingsPath: "/tmp/recall-settings.json",
    shortcutStatus: {
      state: "active",
      key: "alt+r",
      label: "Alt+R",
    },
  });

  assert.match(text, /Settings file: \/tmp\/recall-settings\.json/);
  assert.match(text, /Default scope: Project/);
  assert.match(text, /Picker layout: Balanced/);
  assert.match(text, /Shortcut: Alt\+R \(configured\)/);
});
