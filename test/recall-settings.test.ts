import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { type KeybindingsConfig } from "@earendil-works/pi-tui";
import {
  buildRecallStatusText,
  createRecallSettings,
  getRecallSettingsPath,
  loadRecallSettings,
  normalizeRecallSettings,
  saveRecallSettings,
} from "../src/recall-settings.js";
import {
  findReservedShortcutConflict,
  getShortcutStatus,
  validateShortcutKey,
} from "../src/recall-shortcut.js";

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
  assert.match(validateShortcutKey("r").error ?? "", /must include ctrl, alt or super/i);
  assert.match(validateShortcutKey("shift+r").error ?? "", /must include ctrl, alt or super/i);
});

void test("shortcut validation accepts every Pi key id Recall supports", () => {
  // Pi's KeyId union includes the super modifier, F1-F12, Insert and Clear.
  assert.equal(validateShortcutKey("super+k").normalized, "super+k");
  assert.equal(validateShortcutKey("Super+Alt+K").normalized, "alt+super+k");
  assert.equal(validateShortcutKey("ctrl+f5").normalized, "ctrl+f5");
  assert.equal(validateShortcutKey("alt+insert").normalized, "alt+insert");
  assert.equal(validateShortcutKey("ctrl+clear").normalized, "ctrl+clear");
  // KeyId spells these in camelCase, which is also what parseKey() reports.
  assert.equal(validateShortcutKey("ctrl+pageup").normalized, "ctrl+pageUp");
  assert.equal(validateShortcutKey("ctrl+pageDown").normalized, "ctrl+pageDown");
  assert.equal(validateShortcutKey("ctrl+esc").normalized, "ctrl+escape");
  // Symbol keys stay out: terminals report Ctrl+symbol combos inconsistently.
  assert.match(validateShortcutKey("ctrl+/").error ?? "", /letter, digit, or a supported/i);
  assert.match(validateShortcutKey("hyper+r").error ?? "", /valid pi key combo/i);

  const status = getShortcutStatus({ ...createRecallSettings(), shortcutKey: "super+f12" });
  assert.equal(status.state, "active");
  assert.equal(status.label, "Super+F12");
  assert.equal(
    getShortcutStatus({ ...createRecallSettings(), shortcutKey: "ctrl+pageup" }).label,
    "Ctrl+PageUp"
  );
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

void test("shortcut validation rejects keys Pi reserves for its own actions", () => {
  const keybindings: KeybindingsConfig = {
    "app.message.copy": "ctrl+x",
    "app.model.cycleBackward": ["shift+ctrl+p"],
    "app.thinking.save": "ctrl+s",
  };

  assert.match(
    validateShortcutKey("ctrl+x", keybindings).error ?? "",
    /Ctrl\+X is reserved by Pi for app\.message\.copy/
  );
  // Pi binds shift+ctrl+p; the modifier order must not hide the conflict.
  assert.match(
    validateShortcutKey("Ctrl+Shift+P", keybindings).error ?? "",
    /reserved by Pi for app\.model\.cycleBackward/
  );
  // Non-reserved Pi bindings can be overridden by extensions.
  assert.equal(validateShortcutKey("ctrl+s", keybindings).normalized, "ctrl+s");
  assert.equal(validateShortcutKey("ctrl+x").normalized, "ctrl+x");
  assert.equal(findReservedShortcutConflict("alt+r", keybindings), undefined);
});

void test("getShortcutStatus flags a saved shortcut that Pi reserves", () => {
  const settings = { ...createRecallSettings(), shortcutKey: "ctrl+x" };
  assert.equal(getShortcutStatus(settings).state, "active");

  const status = getShortcutStatus(settings, { "app.message.copy": "ctrl+x" });
  assert.equal(status.state, "conflict");
  assert.match(status.detail, /reserves it for app\.message\.copy/);

  const text = buildRecallStatusText({
    settings,
    settingsPath: "/tmp/s.json",
    shortcutStatus: status,
  });
  assert.match(text, /Shortcut: Ctrl\+X \(conflicts with Pi: /);
});
