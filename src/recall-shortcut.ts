import { type KeyId } from "@mariozechner/pi-tui";
import { DEFAULT_SHORTCUT_KEY } from "./recall-constants.js";
import {
  type RecallSettings,
  type ShortcutStatus,
  type ShortcutValidationResult,
} from "./recall-types.js";

const MODIFIER_ORDER = ["ctrl", "shift", "alt"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
const SPECIAL_KEYS = new Set<string>([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);
const SYMBOL_KEYS = new Set<string>([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?",
]);
const DISPLAY_NAMES: Record<string, string> = {
  escape: "Escape",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  clear: "Clear",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};
const VALID_KEY_ID_SPECIAL_KEYS = new Set<string>([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);

interface ShortcutParts {
  modifiers: string[];
  key: string;
}

export function normalizeShortcutKey(value: string | undefined): string | undefined {
  const parts = parseShortcutParts(value);
  if (!parts) {
    return undefined;
  }

  const key = normalizeBaseKey(parts.key);
  if (!key) {
    return undefined;
  }

  const modifierSet = new Set<string>();
  for (const modifier of parts.modifiers) {
    if (!MODIFIERS.has(modifier) || modifierSet.has(modifier)) {
      return undefined;
    }
    modifierSet.add(modifier);
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier));
  return [...orderedModifiers, key].join("+");
}

export function formatShortcutKey(value: string | undefined): string {
  const normalized = normalizeShortcutKey(value);
  if (normalized) {
    const normalizedParts = parseShortcutParts(normalized);
    if (normalizedParts) {
      return formatShortcutParts(normalizedParts);
    }
  }

  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }

  const defaultParts = parseShortcutParts(DEFAULT_SHORTCUT_KEY);
  return defaultParts ? formatShortcutParts(defaultParts) : DEFAULT_SHORTCUT_KEY;
}

export function validateShortcutKey(value: string): ShortcutValidationResult {
  const normalized = normalizeShortcutKey(value);
  if (!normalized) {
    return { error: "Use a valid Pi key combo like Alt+R or Ctrl+Alt+R." };
  }

  if (!hasShortcutModifier(normalized.split("+"))) {
    return {
      error: "Recall shortcuts must include Ctrl and/or Alt so normal typing keeps working.",
    };
  }

  if (!isValidKeyId(normalized)) {
    return {
      error: "Recall shortcuts must use a letter, digit, or a supported Pi special key.",
    };
  }

  return { normalized };
}

export function getShortcutStatus(settings: RecallSettings): ShortcutStatus {
  const label = formatShortcutKey(settings.shortcutKey);

  if (!settings.shortcutEnabled) {
    return {
      state: "disabled",
      label,
      detail: "Disabled in /recall settings.",
    };
  }

  const normalized = normalizeShortcutKey(settings.shortcutKey);
  if (!normalized || !isValidKeyId(normalized)) {
    return {
      state: "skipped",
      label,
      detail: "The saved shortcut is invalid. Use /recall settings to choose a new key.",
    };
  }

  return {
    state: "active",
    key: normalized,
    label: formatShortcutKey(normalized),
  };
}

function parseShortcutParts(value: string | undefined): ShortcutParts | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  const parts =
    trimmed === "+"
      ? ["+"]
      : trimmed.endsWith("+")
        ? [
            ...trimmed
              .slice(0, -1)
              .split("+")
              .map((part) => part.trim())
              .filter(Boolean),
            "+",
          ]
        : trimmed
            .split("+")
            .map((part) => part.trim())
            .filter(Boolean);

  if (parts.length === 0) {
    return undefined;
  }

  const key = parts.at(-1);
  if (!key) {
    return undefined;
  }

  return {
    modifiers: parts.slice(0, -1),
    key,
  };
}

function normalizeBaseKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (/^[a-z0-9]$/.test(value)) {
    return value;
  }

  if (SPECIAL_KEYS.has(value)) {
    if (value === "return") {
      return "enter";
    }
    if (value === "esc") {
      return "escape";
    }
    return value;
  }

  if (SYMBOL_KEYS.has(value)) {
    return value;
  }

  return undefined;
}

function hasShortcutModifier(tokens: Iterable<string>): boolean {
  for (const token of tokens) {
    if (token === "ctrl" || token === "alt") {
      return true;
    }
  }

  return false;
}

function isValidKeyId(value: string): value is KeyId {
  const parts = parseShortcutParts(value);
  if (!parts) {
    return false;
  }

  const modifierSet = new Set(parts.modifiers);
  if (modifierSet.size !== parts.modifiers.length) {
    return false;
  }

  for (const modifier of modifierSet) {
    if (!MODIFIERS.has(modifier)) {
      return false;
    }
  }

  if (!hasShortcutModifier(modifierSet)) {
    return false;
  }

  if (SYMBOL_KEYS.has(parts.key)) {
    return false;
  }

  if (/^[a-z0-9]$/.test(parts.key)) {
    return true;
  }

  return VALID_KEY_ID_SPECIAL_KEYS.has(parts.key);
}

function formatShortcutParts(parts: ShortcutParts): string {
  return [
    ...parts.modifiers.map((modifier) => formatShortcutToken(modifier, false)),
    formatShortcutToken(parts.key, true),
  ].join("+");
}

function formatShortcutToken(token: string, isKey: boolean): string {
  if (!isKey) {
    return token.slice(0, 1).toUpperCase() + token.slice(1);
  }

  if (DISPLAY_NAMES[token]) {
    return DISPLAY_NAMES[token];
  }

  if (/^[a-z0-9]$/.test(token)) {
    return token.toUpperCase();
  }

  if (/^f\d+$/.test(token)) {
    return token.toUpperCase();
  }

  return token;
}
