import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PICKER_LAYOUT,
  DEFAULT_SCOPE,
  DEFAULT_SHORTCUT_KEY,
  EXTENSION_NAME,
  RECALL_PICKER_LAYOUTS,
  RECALL_SCOPES,
} from "./recall-constants.js";
import { formatShortcutKey } from "./recall-shortcut.js";
import {
  type RecallPickerLayoutPreference,
  type RecallScope,
  type RecallSettings,
  type ShortcutStatus,
} from "./recall-types.js";

export function getRecallSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", EXTENSION_NAME, "settings.json");
}

export function createRecallSettings(): RecallSettings {
  return {
    defaultScope: DEFAULT_SCOPE,
    pickerLayout: DEFAULT_PICKER_LAYOUT,
    shortcutEnabled: true,
    shortcutKey: DEFAULT_SHORTCUT_KEY,
  };
}

export function normalizeRecallSettings(raw: unknown): RecallSettings {
  const defaults = createRecallSettings();
  const input = isRecord(raw) ? raw : {};

  return {
    defaultScope: normalizeScope(input.defaultScope, defaults.defaultScope),
    pickerLayout: normalizePickerLayout(input.pickerLayout, defaults.pickerLayout),
    shortcutEnabled: normalizeBoolean(input.shortcutEnabled, defaults.shortcutEnabled),
    shortcutKey: normalizeShortcutKeyValue(input.shortcutKey, defaults.shortcutKey),
  };
}

export function loadRecallSettings(settingsPath = getRecallSettingsPath()): RecallSettings {
  if (!existsSync(settingsPath)) {
    return createRecallSettings();
  }

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return normalizeRecallSettings(raw);
  } catch {
    return createRecallSettings();
  }
}

export function saveRecallSettings(
  settings: RecallSettings,
  settingsPath = getRecallSettingsPath()
): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify(normalizeRecallSettings(settings), null, 2)}\n`,
    "utf-8"
  );
}

export function formatRecallScope(scope: RecallScope): string {
  switch (scope) {
    case "project":
      return "Project";
    case "repo":
      return "Repo";
    case "all":
      return "All";
  }
}

export function formatRecallPickerLayout(layout: RecallPickerLayoutPreference): string {
  switch (layout) {
    case "compact":
      return "Compact";
    case "balanced":
      return "Balanced";
    case "wide":
      return "Wide";
  }
}

export function buildRecallStatusText(input: {
  settings: RecallSettings;
  settingsPath: string;
  shortcutStatus: ShortcutStatus;
}): string {
  return [
    "## Message Recall",
    `- Settings file: ${input.settingsPath}`,
    `- Default scope: ${formatRecallScope(input.settings.defaultScope)}`,
    `- Picker layout: ${formatRecallPickerLayout(input.settings.pickerLayout)}`,
    `- Shortcut: ${formatShortcutSummary(input.shortcutStatus)}`,
    "- Picker scope toggle: Tab",
    "- Search modes: empty = recent, quotes = exact phrase, re:<pattern> = regex",
    "- Recall is text-only and fills the editor without sending",
  ].join("\n");
}

function formatShortcutSummary(shortcutStatus: ShortcutStatus): string {
  switch (shortcutStatus.state) {
    case "active":
      return `${shortcutStatus.label} (configured)`;
    case "disabled":
      return `${shortcutStatus.label} (disabled)`;
    case "skipped":
      return `${formatShortcutKey(shortcutStatus.label)} (not loaded: ${shortcutStatus.detail})`;
  }
}

function normalizeScope(value: unknown, fallback: RecallScope): RecallScope {
  if (typeof value !== "string") {
    return fallback;
  }

  return (RECALL_SCOPES as readonly string[]).includes(value) ? (value as RecallScope) : fallback;
}

function normalizePickerLayout(
  value: unknown,
  fallback: RecallPickerLayoutPreference
): RecallPickerLayoutPreference {
  if (typeof value !== "string") {
    return fallback;
  }

  return (RECALL_PICKER_LAYOUTS as readonly string[]).includes(value)
    ? (value as RecallPickerLayoutPreference)
    : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeShortcutKeyValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
