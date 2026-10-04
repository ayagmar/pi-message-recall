import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { RESULT_PAGE_SIZE } from "../src/recall-constants.js";
import {
  adjustRecallPickerLayoutForPreview,
  captureShortcutKey,
  compactPath,
  createSearchInput,
  formatRelativeTime,
  openRecallPicker,
  openRecallSettingsFlow,
  resolveRecallPickerLayout,
  resolveRecallPickerWindow,
  resolveRetainedSelectionIndex,
} from "../src/recall-dialogs.js";
import { createRecallSettings, loadRecallSettings } from "../src/recall-settings.js";
import { type RecallMessage } from "../src/recall-types.js";

function expectedMaxHeight(rows: number): number {
  return Math.min(Math.floor((rows * 84) / 100), rows - 2);
}

void test("resolveRecallPickerLayout uses a balanced default sweet spot", () => {
  const compact = resolveRecallPickerLayout(40, 180, "compact");
  const balanced = resolveRecallPickerLayout(40, 180, "balanced");
  const wide = resolveRecallPickerLayout(40, 180, "wide");

  assert.equal(balanced.maxHeight, expectedMaxHeight(40));
  assert.equal(balanced.totalLines, balanced.maxHeight);
  assert.ok(compact.overlayWidth < balanced.overlayWidth);
  assert.ok(balanced.overlayWidth < wide.overlayWidth);
  assert.ok(compact.resultPrimaryColumnWidth < balanced.resultPrimaryColumnWidth);
  assert.ok(balanced.resultPrimaryColumnWidth < wide.resultPrimaryColumnWidth);
});

void test("resolveRecallPickerLayout expands to fill taller fullscreen overlays", () => {
  const regular = resolveRecallPickerLayout(30, 120, "balanced");
  const fullscreen = resolveRecallPickerLayout(60, 220, "balanced");

  assert.equal(regular.maxHeight, expectedMaxHeight(30));
  assert.equal(fullscreen.maxHeight, expectedMaxHeight(60));
  assert.equal(regular.totalLines, regular.maxHeight);
  assert.equal(fullscreen.totalLines, fullscreen.maxHeight);
  assert.ok(fullscreen.overlayWidth > regular.overlayWidth);
  assert.ok(fullscreen.resultPrimaryColumnWidth > regular.resultPrimaryColumnWidth);
  assert.ok(fullscreen.pageSize > regular.pageSize);
  assert.ok(fullscreen.pageSize > RESULT_PAGE_SIZE);
  assert.ok(fullscreen.previewBodyLines > regular.previewBodyLines);
});

void test("resolveRecallPickerLayout keeps shorter terminals within the overlay budget", () => {
  const layout = resolveRecallPickerLayout(24, 90, "balanced");

  assert.equal(layout.maxHeight, expectedMaxHeight(24));
  assert.equal(layout.totalLines, layout.maxHeight);
  assert.equal(layout.pageSize, layout.resultLines);
  assert.ok(layout.overlayWidth >= 72);
  assert.ok(layout.resultPrimaryColumnWidth >= 38);
  assert.ok(layout.pageSize >= 1);
  assert.ok(layout.previewLines >= 0);
  assert.ok(layout.previewBodyLines >= 0);
});

void test("adjustRecallPickerLayoutForPreview gives long prompts more preview space", () => {
  const layout = resolveRecallPickerLayout(40, 180, "balanced");
  const adjusted = adjustRecallPickerLayoutForPreview(layout, 18);

  assert.equal(adjusted.totalLines, layout.totalLines);
  assert.ok(adjusted.previewBodyLines > layout.previewBodyLines);
  assert.ok(adjusted.previewLines > layout.previewLines);
  assert.ok(adjusted.resultLines < layout.resultLines);
  assert.equal(adjusted.pageSize, layout.pageSize);
});

void test("adjustRecallPickerLayoutForPreview leaves short prompts alone", () => {
  const layout = resolveRecallPickerLayout(40, 180, "balanced");
  const adjusted = adjustRecallPickerLayoutForPreview(layout, layout.previewBodyLines);

  assert.deepEqual(adjusted, layout);
});

void test("resolveRecallPickerWindow keeps pagination stable when preview shrinks the list", () => {
  const layout = resolveRecallPickerLayout(40, 180, "balanced");
  const adjusted = adjustRecallPickerLayoutForPreview(layout, 18);
  const window = resolveRecallPickerWindow(1048, 61, adjusted.pageSize, adjusted.resultLines);

  assert.equal(window.pageCount, Math.ceil(1048 / layout.pageSize));
  assert.equal(window.pageIndex, Math.floor(61 / layout.pageSize));
  assert.equal(window.pageStart, Math.floor(61 / layout.pageSize) * layout.pageSize);
  assert.equal(window.selectedIndexInView, 61 - window.visibleStart);
  assert.equal(window.visibleEnd - window.visibleStart, adjusted.resultLines);
});

void test("resolveRecallPickerWindow keeps the selected item visible on the last page", () => {
  const window = resolveRecallPickerWindow(25, 24, 10, 4);

  assert.equal(window.pageIndex, 2);
  assert.equal(window.pageStart, 20);
  assert.equal(window.pageEnd, 25);
  assert.equal(window.visibleStart, 21);
  assert.equal(window.visibleEnd, 25);
  assert.equal(window.selectedIndexInView, 3);
});

void test("resolveRetainedSelectionIndex falls back to prompt text when dedupe replaces the id", () => {
  const results: RecallMessage[] = [
    {
      id: "newer-duplicate",
      sessionPath: "/sessions/newer.jsonl",
      sessionCwd: "/work/project",
      timestamp: 3,
      text: "Keep the key hints visible",
      preview: "Keep the key hints visible",
      normalizedText: "keep the key hints visible",
      isCurrentSession: true,
    },
    {
      id: "other",
      sessionPath: "/sessions/other.jsonl",
      sessionCwd: "/work/project",
      timestamp: 2,
      text: "Add pagination to the picker",
      preview: "Add pagination to the picker",
      normalizedText: "add pagination to the picker",
      isCurrentSession: false,
    },
  ];

  assert.equal(
    resolveRetainedSelectionIndex(results, "older-duplicate", "Keep the key hints visible"),
    0
  );
});

void test("captureShortcutKey asks for the key as text outside the TUI", async () => {
  const notifications: string[] = [];
  const inputs: string[] = [];
  let customCalls = 0;
  const createCtx = (answer: string | undefined) =>
    ({
      mode: "rpc",
      hasUI: true,
      ui: {
        input: async (_title: string, placeholder?: string) => {
          inputs.push(placeholder ?? "");
          return answer;
        },
        custom: async () => {
          customCalls += 1;
          return undefined;
        },
        notify: (message: string) => {
          notifications.push(message);
        },
      },
    }) as unknown as ExtensionContext;

  assert.equal(
    await captureShortcutKey(createCtx(" Ctrl+Alt+R "), { currentValue: "alt+r" }),
    "ctrl+alt+r"
  );
  assert.deepEqual(inputs, ["alt+r"]);

  assert.equal(await captureShortcutKey(createCtx("r")), undefined);
  assert.match(notifications.at(-1) ?? "", /must include ctrl, alt or super/i);

  assert.equal(await captureShortcutKey(createCtx(undefined)), undefined);
  assert.equal(customCalls, 0);

  // Pi's default reserved keys are refused here too, not only in the TUI capture dialog.
  assert.equal(await captureShortcutKey(createCtx("ctrl+c")), undefined);
  assert.match(notifications.at(-1) ?? "", /Ctrl\+C is reserved by Pi/);
  assert.equal(await captureShortcutKey(createCtx("ctrl+k")), undefined);
  assert.match(notifications.at(-1) ?? "", /reserved by Pi for tui\.editor\.deleteToLineEnd/);
});

void test("the settings flow refuses keys Pi reserves outside the TUI", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-dialogs-"));
  const settingsPath = join(root, "settings.json");
  const notifications: string[] = [];
  const answers = ["Shortcut · Disabled", undefined];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      select: async () => answers.shift(),
      input: async () => "ctrl+d",
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  try {
    const result = await openRecallSettingsFlow(ctx, {
      settings: { ...createRecallSettings(), shortcutEnabled: false },
      settingsPath,
    });

    assert.equal(result, undefined);
    assert.equal(existsSync(settingsPath), false);
    assert.deepEqual(notifications, [
      "Enter the shortcut you want to enable for Message Recall.",
      "Ctrl+D is reserved by Pi for app.exit. Choose another shortcut.",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the shortcut capture dialog refuses keys Pi reserves", async () => {
  const theme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  };
  let rendered: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: string | undefined) => void
        ) => { handleInput(data: string): void; render(width: number): string[] }
      ) =>
        new Promise<string | undefined>((resolve) => {
          const dialog = factory(
            { requestRender: () => undefined },
            theme,
            { getResolvedBindings: () => ({ "app.message.copy": "ctrl+x" }) },
            resolve
          );
          dialog.handleInput("\x18"); // ctrl+x
          rendered = dialog.render(60);
          dialog.handleInput("\x1br"); // alt+r
        }),
    },
  } as unknown as ExtensionContext;

  assert.equal(await captureShortcutKey(ctx), "alt+r");
  assert.match(rendered.join("\n"), /Ctrl\+X is reserved by Pi for app\.message\.copy/);
});

void test("settings changes made before dismissing the settings menu are returned", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-dialogs-"));
  const settingsPath = join(root, "settings.json");
  const answers = ["Default scope · Project", "All", "Picker layout · Balanced", "Wide", undefined];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      select: async () => answers.shift(),
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;

  try {
    const result = await openRecallSettingsFlow(ctx, {
      settings: createRecallSettings(),
      settingsPath,
    });

    assert.deepEqual(answers, []);
    assert.equal(result?.settings.defaultScope, "all");
    assert.equal(result?.settings.pickerLayout, "wide");
    assert.equal(result?.reloadRequired, false);
    assert.deepEqual(loadRecallSettings(settingsPath), result?.settings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("dismissing the settings menu without changes returns nothing", async () => {
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { select: async () => undefined },
  } as unknown as ExtensionContext;

  assert.equal(
    await openRecallSettingsFlow(ctx, {
      settings: createRecallSettings(),
      settingsPath: "/nonexistent/settings.json",
    }),
    undefined
  );
});

void test("compactPath only abbreviates paths inside the home directory", () => {
  assert.equal(compactPath("/home/me", "/home/me"), "~");
  assert.equal(compactPath("/home/me/project", "/home/me"), "~/project");
  assert.equal(compactPath("/home/me/project", "/home/me/"), "~/project");
  assert.equal(compactPath("/home/me2/project", "/home/me"), "/home/me2/project");
  assert.equal(compactPath("/work/project", "/home/me"), "/work/project");
});

void test("formatRelativeTime shows older prompts with their local calendar date", () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    // 03:00 UTC on Jan 2 is still Jan 1 in Los Angeles.
    const timestamp = Date.UTC(2026, 0, 2, 3, 0);
    const day = 24 * 60 * 60 * 1000;

    assert.equal(formatRelativeTime(timestamp, timestamp + 30_000), "just now");
    assert.equal(formatRelativeTime(timestamp, timestamp + 2 * day), "2d ago");
    assert.equal(formatRelativeTime(timestamp, timestamp + 30 * day), "2026-01-01");
  } finally {
    if (previousTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTz;
    }
  }
});

void test("the prefilled search query keeps the cursor at its end", () => {
  const input = createSearchInput("loading spinner");
  input.handleInput("s");
  assert.equal(input.getValue(), "loading spinners");

  const empty = createSearchInput("");
  empty.handleInput("a");
  assert.equal(empty.getValue(), "a");
});

void test("toggling the shortcut leaves the reload notice to the extension", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-dialogs-"));
  const settingsPath = join(root, "settings.json");
  const notifications: string[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      select: async () => "Shortcut · Enabled",
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  try {
    const result = await openRecallSettingsFlow(ctx, {
      settings: createRecallSettings(),
      settingsPath,
    });

    assert.equal(result?.settings.shortcutEnabled, false);
    assert.equal(result?.reloadRequired, true);
    assert.deepEqual(notifications, ["Recall shortcut disabled."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type PickerDialog = { render(width: number): string[]; handleInput(data: string): void };

function createPickerContext(
  root: string,
  keybindings: KeybindingsManager
): { ctx: ExtensionContext; getDialog: () => PickerDialog | undefined } {
  let dialog: PickerDialog | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    sessionManager: {
      getSessionDir: () => root,
      getEntries: () => [],
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
    },
    ui: {
      getEditorText: () => "",
      setEditorText: () => undefined,
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: unknown) => void
        ) => PickerDialog,
        _options: unknown
      ) =>
        new Promise((resolve) => {
          dialog = factory(
            {
              requestRender: () => undefined,
              terminal: { rows: 40, columns: 120 },
            },
            {
              fg: (_c: string, t: string) => t,
              bg: (_c: string, t: string) => t,
              bold: (t: string) => t,
            },
            keybindings,
            resolve
          );
        }),
    },
  } as unknown as ExtensionContext;

  return { ctx, getDialog: () => dialog };
}

function renderScopeLine(dialog: PickerDialog | undefined): string {
  return dialog?.render(120).find((line) => line.includes("Scope ")) ?? "";
}

void test("the picker's empty state names the configured scope key", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-picker-"));
  initTheme("dark");
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.tab": "ctrl+t" });
  setKeybindings(keybindings);
  const { ctx, getDialog } = createPickerContext(root, keybindings);

  try {
    const picker = openRecallPicker(ctx, {
      initialQuery: "",
      previousDraft: "",
      settings: createRecallSettings(),
      findRepoRoot: async () => undefined,
    });
    let output = "";
    for (let attempt = 0; attempt < 100 && !output.includes("wider scope"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      output = getDialog()?.render(120).join("\n") ?? "";
    }

    assert.match(output, /Try ctrl\+t for a wider scope/);
    assert.doesNotMatch(output, /\bTab\b/);

    getDialog()?.handleInput("\x1b");
    assert.equal(await picker, undefined);
  } finally {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the picker opens before the git root lookup finishes, then offers Repo scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-picker-"));
  initTheme("dark");
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const { ctx, getDialog } = createPickerContext(root, keybindings);
  let resolveRepoRoot: (root: string | undefined) => void = () => undefined;
  let lookupSignal: AbortSignal | undefined;

  try {
    const picker = openRecallPicker(ctx, {
      initialQuery: "",
      previousDraft: "",
      settings: { ...createRecallSettings(), defaultScope: "repo" },
      findRepoRoot: (cwd, signal) => {
        assert.equal(cwd, root);
        lookupSignal = signal;
        return new Promise((resolve) => {
          resolveRepoRoot = resolve;
        });
      },
    });

    // The overlay exists, and receives keys, while git is still running.
    assert.ok(getDialog());
    getDialog()?.handleInput("s");
    assert.match(getDialog()?.render(120).join("\n") ?? "", /Search › > s/);
    assert.doesNotMatch(renderScopeLine(getDialog()), /Repo/);
    assert.match(renderScopeLine(getDialog()), / Project .*\[All\]/);

    resolveRepoRoot(root);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The configured default Repo scope is selected once the root is known.
    assert.match(renderScopeLine(getDialog()), /\[Project\] +Repo +\[All\]/);

    getDialog()?.handleInput("\x1b");
    assert.equal(await picker, undefined);
    assert.equal(lookupSignal?.aborted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the picker keeps a scope the user picked while the git root was resolving", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-picker-"));
  initTheme("dark");
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const { ctx, getDialog } = createPickerContext(root, keybindings);
  let resolveRepoRoot: (root: string | undefined) => void = () => undefined;

  try {
    const picker = openRecallPicker(ctx, {
      initialQuery: "",
      previousDraft: "",
      settings: { ...createRecallSettings(), defaultScope: "repo" },
      findRepoRoot: () =>
        new Promise((resolve) => {
          resolveRepoRoot = resolve;
        }),
    });

    getDialog()?.handleInput("\t");
    assert.match(renderScopeLine(getDialog()), /\[Project\] +All /);

    resolveRepoRoot(root);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(renderScopeLine(getDialog()), /\[Project\] +\[Repo\] +All /);

    getDialog()?.handleInput("\x1b");
    assert.equal(await picker, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
