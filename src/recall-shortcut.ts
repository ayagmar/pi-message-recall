import { type KeybindingsConfig, type KeyId } from "@earendil-works/pi-tui";
import { DEFAULT_SHORTCUT_KEY } from "./recall-constants.js";
import {
  type RecallSettings,
  type ShortcutStatus,
  type ShortcutValidationResult,
} from "./recall-types.js";

// Modifiers and keys accepted by Pi's KeyId union (@earendil-works/pi-tui keys.ts), which only
// exists as a type. Keep in sync when Pi adds keys.
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);
// Modifiers that keep a shortcut from interfering with normal typing.
const SHORTCUT_MODIFIERS = new Set<string>(["ctrl", "alt", "super"]);
// Lowercase spelling -> KeyId spelling. matchesKey() lowercases key ids, but the KeyId union
// spells PageUp/PageDown in camelCase.
const SPECIAL_KEYS = new Map<string, string>([
  ["escape", "escape"],
  ["esc", "escape"],
  ["enter", "enter"],
  ["return", "enter"],
  ["tab", "tab"],
  ["space", "space"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["insert", "insert"],
  ["clear", "clear"],
  ["home", "home"],
  ["end", "end"],
  ["pageup", "pageUp"],
  ["pagedown", "pageDown"],
  ["up", "up"],
  ["down", "down"],
  ["left", "left"],
  ["right", "right"],
  ...Array.from({ length: 12 }, (_, index): [string, string] => [`f${index + 1}`, `f${index + 1}`]),
]);
// Valid Pi keys, but not accepted as Recall shortcuts: terminals report Ctrl+symbol combos
// inconsistently.
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

// Mirrors RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS in Pi's extension runner, which is not
// exported. Pi skips (with only a startup diagnostic) any extension shortcut bound to one of these.
const PI_RESERVED_KEYBINDINGS = new Set<string>([
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.thinking.cycle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.tools.expand",
  "app.thinking.toggle",
  "app.editor.external",
  "app.message.copy",
  "app.message.followUp",
  "tui.input.submit",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.input.copy",
  "tui.editor.deleteToLineEnd",
]);

/**
 * Pi 1.0.1's default keys for the reserved app.* actions (KEYBINDINGS in pi-coding-agent's
 * core/keybindings.ts, which extensions cannot build at runtime). Outside the TUI Pi never installs
 * its keybindings, so these stand in to reject reserved keys there. Custom remaps from
 * keybindings.json are not visible outside the TUI, which is why session_start still reports
 * conflicts. Keep in sync with Pi.
 */
export function getDefaultReservedAppKeybindings(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): KeybindingsConfig {
  // Mirrors useWindowsKeybindings() in Pi: Windows itself, and Linux under WSL.
  const windowsKeybindings =
    platform === "win32" ||
    (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));

  return {
    "app.interrupt": "escape",
    "app.clear": "ctrl+c",
    "app.exit": "ctrl+d",
    "app.suspend": platform === "win32" ? [] : "ctrl+z",
    "app.thinking.cycle": "shift+tab",
    "app.model.cycleForward": "ctrl+p",
    "app.model.cycleBackward": windowsKeybindings ? "alt+p" : "shift+ctrl+p",
    "app.model.select": "ctrl+l",
    "app.tools.expand": "ctrl+o",
    "app.thinking.toggle": "ctrl+t",
    "app.editor.external": "ctrl+g",
    "app.message.copy": "ctrl+x",
    "app.message.followUp": windowsKeybindings ? "ctrl+q" : "alt+enter",
  };
}

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

/** Returns the reserved Pi action bound to `key`, if any. Modifier order does not matter. */
export function findReservedShortcutConflict(
  key: string,
  keybindings: KeybindingsConfig | undefined
): string | undefined {
  const target = canonicalizeKeyId(key);
  if (!target || !keybindings) {
    return undefined;
  }

  for (const [keybinding, keys] of Object.entries(keybindings)) {
    if (!PI_RESERVED_KEYBINDINGS.has(keybinding) || keys === undefined) {
      continue;
    }

    const boundKeys: readonly string[] = Array.isArray(keys) ? keys : [keys];
    if (boundKeys.some((boundKey) => canonicalizeKeyId(boundKey) === target)) {
      return keybinding;
    }
  }

  return undefined;
}

export function validateShortcutKey(
  value: string,
  keybindings?: KeybindingsConfig
): ShortcutValidationResult {
  const normalized = normalizeShortcutKey(value);
  if (!normalized) {
    return { error: "Use a valid Pi key combo like Alt+R or Ctrl+Alt+R." };
  }

  if (!hasShortcutModifier(normalized.split("+"))) {
    return {
      error: "Recall shortcuts must include Ctrl, Alt or Super so normal typing keeps working.",
    };
  }

  if (!isValidKeyId(normalized)) {
    return {
      error: "Recall shortcuts must use a letter, digit, or a supported Pi special key.",
    };
  }

  const reservedFor = findReservedShortcutConflict(normalized, keybindings);
  if (reservedFor) {
    return {
      error: `${formatShortcutKey(normalized)} is reserved by Pi for ${reservedFor}. Choose another shortcut.`,
    };
  }

  return { normalized };
}

export function getShortcutStatus(
  settings: RecallSettings,
  keybindings?: KeybindingsConfig
): ShortcutStatus {
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

  const reservedFor = findReservedShortcutConflict(normalized, keybindings);
  if (reservedFor) {
    return {
      state: "conflict",
      key: normalized,
      label: formatShortcutKey(normalized),
      detail: `Pi reserves it for ${reservedFor}, so Pi may ignore it. Use /recall settings to choose a new key.`,
    };
  }

  return {
    state: "active",
    key: normalized,
    label: formatShortcutKey(normalized),
  };
}

function canonicalizeKeyId(value: string): string | undefined {
  const parts = parseShortcutParts(value);
  if (!parts) {
    return undefined;
  }

  const key = parts.key === "esc" ? "escape" : parts.key === "return" ? "enter" : parts.key;
  const modifiers = [...new Set(parts.modifiers)].sort();
  return [...modifiers, key].join("+");
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

  const specialKey = SPECIAL_KEYS.get(value);
  if (specialKey) {
    return specialKey;
  }

  if (SYMBOL_KEYS.has(value)) {
    return value;
  }

  return undefined;
}

function hasShortcutModifier(tokens: Iterable<string>): boolean {
  for (const token of tokens) {
    if (SHORTCUT_MODIFIERS.has(token)) {
      return true;
    }
  }

  return false;
}

/** Whether `value` is a normalized shortcut that Pi accepts as a KeyId and Recall allows. */
function isValidKeyId(value: string): value is KeyId {
  const parts = parseShortcutParts(value);
  if (!parts || normalizeShortcutKey(value) !== value || !hasShortcutModifier(parts.modifiers)) {
    return false;
  }

  return /^[a-z0-9]$/.test(parts.key) || SPECIAL_KEYS.has(parts.key);
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
