import { homedir } from "node:os";
import { type ExtensionContext, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  parseKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { DEFAULT_SHORTCUT_KEY, RECALL_SCOPES, RESULT_PAGE_SIZE } from "./recall-constants.js";
import { getAvailableScopes, loadMessagesForScope, resolveRecallScope } from "./recall-history.js";
import { searchRecallMessages } from "./recall-search.js";
import { createRecallSettings, formatRecallScope, saveRecallSettings } from "./recall-settings.js";
import { formatShortcutKey, normalizeShortcutKey, validateShortcutKey } from "./recall-shortcut.js";
import {
  type RecallLoadProgress,
  type RecallMessage,
  type RecallPickerOptions,
  type RecallScope,
  type RecallSearchResult,
  type RecallSettings,
  type RecallSettingsFlowResult,
} from "./recall-types.js";

export async function openRecallPicker(
  ctx: ExtensionContext,
  options: RecallPickerOptions
): Promise<RecallMessage | undefined> {
  const availableScopes = getAvailableScopes(ctx.cwd);
  const initialScope = resolveRecallScope(options.settings.defaultScope, availableScopes);

  return ctx.ui.custom<RecallMessage | undefined>(
    (tui, theme, keybindings, done) => {
      return new RecallPickerDialog(
        theme,
        keybindings,
        {
          initialQuery: options.initialQuery,
          initialScope,
          availableScopes,
          currentCwd: ctx.cwd,
          currentSessionDir: ctx.sessionManager.getSessionDir(),
          currentSessionEntries: ctx.sessionManager.getEntries() as Parameters<
            typeof loadMessagesForScope
          >[0]["currentSessionEntries"],
          currentSessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
          currentSessionName: ctx.sessionManager.getSessionName() ?? undefined,
        },
        {
          onDone: (value) => {
            const nextText = value?.text ?? options.previousDraft;
            if (ctx.ui.getEditorText() !== nextText) {
              ctx.ui.setEditorText(nextText);
            }
            done(value);
          },
          requestRender: () => tui.requestRender(),
        }
      );
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "72%",
        minWidth: 72,
        maxHeight: "84%",
        margin: 1,
      },
    }
  );
}

export async function openRecallSettingsFlow(
  ctx: ExtensionContext,
  options: {
    settings: RecallSettings;
    settingsPath: string;
  }
): Promise<RecallSettingsFlowResult | undefined> {
  let settings = options.settings;

  while (true) {
    const choices = [
      `Default scope · ${formatRecallScope(settings.defaultScope)}`,
      `Shortcut · ${settings.shortcutEnabled ? "Enabled" : "Disabled"}`,
      `Shortcut key · ${formatShortcutKey(settings.shortcutKey)}`,
      "Reset to defaults",
    ];
    const selected = await ctx.ui.select("Message Recall settings", choices);
    if (!selected) {
      return undefined;
    }

    const index = choices.indexOf(selected);
    switch (index) {
      case 0: {
        const next = await updateDefaultScope(ctx, settings, options.settingsPath);
        if (!next) {
          continue;
        }

        settings = next;
        continue;
      }

      case 1: {
        const next = await toggleShortcut(ctx, settings);
        if (!next) {
          continue;
        }

        saveRecallSettings(next, options.settingsPath);
        return {
          settings: next,
          reloadRequired: shortcutReloadRequired(settings, next),
        };
      }

      case 2: {
        const captured = await captureShortcutKey(ctx, {
          currentValue: settings.shortcutKey,
        });
        if (!captured) {
          continue;
        }

        const next = { ...settings, shortcutKey: captured };
        saveRecallSettings(next, options.settingsPath);
        return {
          settings: next,
          reloadRequired: shortcutReloadRequired(settings, next),
        };
      }

      case 3: {
        const confirmed = await ctx.ui.confirm(
          "Reset Message Recall settings",
          "Restore the default scope and shortcut?"
        );
        if (!confirmed) {
          continue;
        }

        const next = createRecallSettings();
        saveRecallSettings(next, options.settingsPath);
        return {
          settings: next,
          reloadRequired: shortcutReloadRequired(settings, next),
        };
      }

      default:
        continue;
    }
  }
}

type DialogTheme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bg" | "bold">;

type PickerLoadState = {
  progress: RecallLoadProgress;
  messages: RecallMessage[];
  results: RecallMessage[];
  resultMode: RecallSearchResult["mode"];
  queryError: string | undefined;
};

const RESULT_PANEL_LINES = RESULT_PAGE_SIZE;
const RESULT_PRIMARY_COLUMN_WIDTH = 38;
const PREVIEW_BODY_LINES = 4;
const PREVIEW_PANEL_LINES = PREVIEW_BODY_LINES + 1;

class RecallPickerDialog implements Component, Focusable {
  private readonly searchInput = new Input();
  private readonly pageSize = RESULT_PAGE_SIZE;
  private readonly searchHint =
    'Search with words, "quoted phrases", or re:<pattern>. Empty query shows recent prompts.';

  private selectList: SelectList = this.createSelectList([]);
  private selectedMessageId: string | undefined;
  private pageIndex = 0;
  private selectedIndex = 0;
  private loadAbort?: AbortController;
  private disposed = false;
  private _focused = false;

  private readonly state: PickerLoadState;
  private scope: RecallScope;

  constructor(
    private readonly theme: DialogTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: {
      initialQuery: string;
      initialScope: RecallScope;
      availableScopes: RecallScope[];
      currentCwd: string;
      currentSessionDir: string;
      currentSessionEntries: Parameters<typeof loadMessagesForScope>[0]["currentSessionEntries"];
      currentSessionFile: string | undefined;
      currentSessionName: string | undefined;
    },
    private readonly callbacks: {
      onDone: (value: RecallMessage | undefined) => void;
      requestRender: () => void;
    }
  ) {
    this.scope = options.initialScope;
    this.searchInput.setValue(options.initialQuery);
    this.searchInput.focused = true;
    this.state = {
      progress: {
        scope: this.scope,
        totalSessions: 0,
        loadedSessions: 0,
        loadedMessages: 0,
        skippedSessions: 0,
        loading: true,
      },
      messages: [],
      results: [],
      resultMode: options.initialQuery.trim() ? "text" : "recent",
      queryError: undefined,
    };

    void this.reloadScope(this.scope);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.selectList.invalidate();
  }

  dispose(): void {
    this.close(undefined);
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    const lines: string[] = [
      this.renderHeaderLine(innerWidth),
      this.theme.fg("dim", truncateToWidth(this.buildMetaLine(), innerWidth)),
      this.renderScopeLine(innerWidth),
      ...this.renderSearchLines(innerWidth),
      this.renderDivider(innerWidth),
      this.theme.fg("accent", truncateToWidth(this.buildResultsLine(), innerWidth)),
      ...this.renderResultsPanel(innerWidth),
      this.renderDivider(innerWidth),
      this.theme.fg("accent", truncateToWidth(this.buildPreviewLine(innerWidth), innerWidth)),
      ...this.renderPreviewLines(innerWidth),
      this.theme.fg("dim", truncateToWidth(this.buildHelpLine(), innerWidth)),
    ];

    return renderDialogBox(this.theme, innerWidth, lines);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.input.tab")) {
      void this.reloadScope(this.nextScope());
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(undefined);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.movePage(-1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.movePage(1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.state.results[this.selectedIndex];
      if (selected) {
        this.close(selected);
      }
      return;
    }

    this.searchInput.handleInput(data);
    this.refreshResults();
    this.callbacks.requestRender();
  }

  private async reloadScope(scope: RecallScope): Promise<void> {
    this.scope = scope;
    this.loadAbort?.abort();
    const controller = new AbortController();
    this.loadAbort = controller;

    this.state.messages = [];
    this.state.results = [];
    this.state.resultMode = this.searchInput.getValue().trim() ? "text" : "recent";
    this.state.queryError = undefined;
    this.state.progress = {
      scope,
      totalSessions: 0,
      loadedSessions: 0,
      loadedMessages: 0,
      skippedSessions: 0,
      loading: true,
    };
    this.pageIndex = 0;
    this.selectedIndex = 0;
    this.selectedMessageId = undefined;
    this.selectList = this.createSelectList([]);
    this.refreshResults();
    this.callbacks.requestRender();

    try {
      await loadMessagesForScope(
        {
          scope,
          currentCwd: this.options.currentCwd,
          currentSessionDir: this.options.currentSessionDir,
          currentSessionEntries: this.options.currentSessionEntries,
          ...(this.options.currentSessionFile
            ? { currentSessionFile: this.options.currentSessionFile }
            : {}),
          ...(this.options.currentSessionName
            ? { currentSessionName: this.options.currentSessionName }
            : {}),
        },
        {
          onBatch: (messages, progress) => {
            if (this.disposed || controller.signal.aborted || this.loadAbort !== controller) {
              return;
            }

            this.state.messages = mergeMessagesByTimestamp(this.state.messages, messages);
            this.state.progress = progress;
            this.refreshResults();
            this.callbacks.requestRender();
          },
          onProgress: (progress) => {
            if (this.disposed || controller.signal.aborted || this.loadAbort !== controller) {
              return;
            }

            this.state.progress = progress;
            this.callbacks.requestRender();
          },
        },
        { signal: controller.signal }
      );
    } catch (error) {
      if (this.disposed || controller.signal.aborted || this.loadAbort !== controller) {
        return;
      }

      this.state.progress = {
        scope,
        totalSessions: 0,
        loadedSessions: 0,
        loadedMessages: 0,
        skippedSessions: 0,
        loading: false,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
      this.callbacks.requestRender();
    }
  }

  private close(value: RecallMessage | undefined): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.loadAbort?.abort();
    this.callbacks.onDone(value);
  }

  private refreshResults(): void {
    const previousSelection = this.selectedMessageId;
    const result = searchRecallMessages(this.state.messages, this.searchInput.getValue());
    this.state.results = result.matches;
    this.state.resultMode = result.mode;
    this.state.queryError = result.error;

    if (this.state.results.length === 0) {
      this.pageIndex = 0;
      this.selectedIndex = 0;
      this.selectedMessageId = undefined;
      this.selectList = this.createSelectList([]);
      return;
    }

    const selectedIndex = previousSelection
      ? this.state.results.findIndex((message) => message.id === previousSelection)
      : -1;
    this.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.pageIndex = Math.floor(this.selectedIndex / this.pageSize);
    this.selectedMessageId = this.state.results[this.selectedIndex]?.id;
    this.selectList = this.createSelectList(this.visibleResults());
  }

  private createSelectList(items: SelectItem[]): SelectList {
    const list = new SelectList(
      items,
      Math.max(1, Math.min(items.length, this.pageSize)),
      {
        selectedPrefix: (text) => this.highlightSelected(text),
        selectedText: (text) => this.highlightSelected(text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      {
        minPrimaryColumnWidth: RESULT_PRIMARY_COLUMN_WIDTH,
        maxPrimaryColumnWidth: RESULT_PRIMARY_COLUMN_WIDTH,
      }
    );

    if (items.length > 0) {
      list.setSelectedIndex(this.selectedIndex - this.pageIndex * this.pageSize);
    }

    return list;
  }

  private visibleResults(): SelectItem[] {
    const start = this.pageIndex * this.pageSize;
    return this.state.results.slice(start, start + this.pageSize).map((message) => ({
      value: message.id,
      label: message.preview,
      description: formatMessageDescription(message),
    }));
  }

  private moveSelection(delta: number): void {
    if (this.state.results.length === 0) {
      return;
    }

    this.selectedIndex =
      (this.selectedIndex + delta + this.state.results.length) % this.state.results.length;
    this.selectedMessageId = this.state.results[this.selectedIndex]?.id;
    this.pageIndex = Math.floor(this.selectedIndex / this.pageSize);
    this.selectList = this.createSelectList(this.visibleResults());
    this.callbacks.requestRender();
  }

  private movePage(delta: number): void {
    const pageCount = Math.max(1, Math.ceil(this.state.results.length / this.pageSize));
    if (pageCount <= 1) {
      return;
    }

    const localIndex = this.selectedIndex - this.pageIndex * this.pageSize;
    this.pageIndex = (this.pageIndex + delta + pageCount) % pageCount;
    this.selectedIndex = Math.min(
      this.pageIndex * this.pageSize + localIndex,
      this.state.results.length - 1
    );
    this.selectedMessageId = this.state.results[this.selectedIndex]?.id;
    this.selectList = this.createSelectList(this.visibleResults());
    this.callbacks.requestRender();
  }

  private nextScope(): RecallScope {
    const currentIndex = this.options.availableScopes.indexOf(this.scope);
    const nextIndex = (currentIndex + 1) % this.options.availableScopes.length;
    return this.options.availableScopes[nextIndex] ?? this.scope;
  }

  private renderHeaderLine(width: number): string {
    const title = this.theme.fg("accent", this.theme.bold("Message Recall"));
    const status = this.renderStatusPill();

    if (visibleWidth(title) + visibleWidth(status) + 1 > width) {
      return title;
    }

    return `${title}${" ".repeat(width - visibleWidth(title) - visibleWidth(status))}${status}`;
  }

  private renderStatusPill(): string {
    const progress = this.state.progress;
    if (progress.unavailableReason || this.state.queryError) {
      return this.theme.bg("toolErrorBg", this.theme.fg("text", " issue "));
    }

    if (progress.loading) {
      return this.theme.bg("toolPendingBg", this.theme.fg("text", " scanning "));
    }

    return this.theme.bg("toolSuccessBg", this.theme.fg("text", " ready "));
  }

  private renderScopeLine(width: number): string {
    const prefix = this.theme.fg("dim", "Scope ");
    const pills = this.options.availableScopes
      .map((scope) => this.renderScopePill(scope))
      .join(" ");
    return `${prefix}${truncateToWidth(pills, Math.max(1, width - visibleWidth(prefix)))}`;
  }

  private renderScopePill(scope: RecallScope): string {
    const label = ` ${formatRecallScope(scope)} `;
    if (scope === this.scope) {
      return this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(label)));
    }

    return this.theme.fg("muted", `[${label.trim()}]`);
  }

  private renderSearchLines(width: number): string[] {
    const prefix = this.theme.fg("dim", "Search › ");
    const prefixWidth = visibleWidth(prefix);
    const inputLine = this.searchInput.render(Math.max(1, width - prefixWidth))[0] ?? "";

    const hint = this.state.queryError
      ? this.theme.fg("warning", truncateToWidth(this.state.queryError, width))
      : this.theme.fg("dim", truncateToWidth(this.buildSearchHint(), width));

    return [prefix + inputLine, hint];
  }

  private renderResultsPanel(width: number): string[] {
    const lines =
      this.state.results.length > 0 ? this.selectList.render(width) : this.renderEmptyState(width);
    return padBlockLines(lines, RESULT_PANEL_LINES);
  }

  private renderEmptyState(width: number): string[] {
    const lines: string[] = [];
    const progress = this.state.progress;
    const hasQuery = Boolean(this.searchInput.getValue().trim());

    if (progress.unavailableReason) {
      lines.push(this.theme.fg("warning", truncateToWidth(progress.unavailableReason, width)));
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth("Switch scope with Tab or try another directory.", width)
        )
      );
      return lines;
    }

    if (this.state.queryError) {
      lines.push(
        this.theme.fg(
          "warning",
          truncateToWidth("Fix the search query above to see matching prompts.", width)
        )
      );
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth("Results update as soon as the query becomes valid.", width)
        )
      );
      return lines;
    }

    if (progress.loading && progress.loadedMessages === 0) {
      lines.push(this.theme.fg("accent", truncateToWidth("Scanning prior prompts…", width)));
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth("Results will appear here as history loads in the background.", width)
        )
      );
      return lines;
    }

    if (progress.loadedMessages === 0) {
      lines.push(
        this.theme.fg(
          "warning",
          truncateToWidth("No prior text prompts were found in this scope yet.", width)
        )
      );
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth("Try Tab for a wider scope once you have more history.", width)
        )
      );
      return lines;
    }

    if (hasQuery && progress.loading) {
      lines.push(
        this.theme.fg(
          "warning",
          truncateToWidth("No matches yet. More history is still loading…", width)
        )
      );
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth("Keep typing, or wait a moment for more prompts to arrive.", width)
        )
      );
      return lines;
    }

    if (hasQuery) {
      lines.push(this.theme.fg("warning", truncateToWidth("No prompts match this query.", width)));
      lines.push(
        this.theme.fg(
          "dim",
          truncateToWidth(
            this.scope !== "all"
              ? "Try shorter terms, quotes, regex, or press Tab to widen the scope."
              : "Try shorter terms, quoted phrases, or regex with re:<pattern>.",
            width
          )
        )
      );
      return lines;
    }

    lines.push(
      this.theme.fg("warning", truncateToWidth("No recent prompts are available yet.", width))
    );
    lines.push(
      this.theme.fg(
        "dim",
        truncateToWidth("Open a few chats first, then come back to recall them here.", width)
      )
    );
    return lines;
  }

  private renderPreviewLines(width: number): string[] {
    const selected = this.state.results[this.selectedIndex];
    if (!selected) {
      return padBlockLines(
        [
          this.theme.fg(
            "dim",
            truncateToWidth(
              "Move through the list to preview the full prompt before restoring it.",
              width
            )
          ),
          this.theme.fg(
            "dim",
            truncateToWidth("Press Enter to restore the highlighted prompt into the editor.", width)
          ),
        ],
        PREVIEW_PANEL_LINES
      );
    }

    return padBlockLines(
      [
        this.theme.fg("dim", truncateToWidth(formatMessageDescription(selected), width)),
        ...this.getWrappedPreviewLines(selected, width).slice(0, PREVIEW_BODY_LINES),
      ],
      PREVIEW_PANEL_LINES
    );
  }

  private renderDivider(width: number): string {
    return this.theme.fg("borderMuted", "─".repeat(width));
  }

  private buildSearchHint(): string {
    if (this.state.resultMode === "regex") {
      return "Regex mode · match against the original prompt text.";
    }

    if (this.state.resultMode === "text") {
      return 'Text mode · combine words and "quoted phrases" to narrow results.';
    }

    return this.searchHint;
  }

  private buildMetaLine(): string {
    const progress = this.state.progress;
    const parts = [
      `${progress.loadedMessages} prompt${progress.loadedMessages === 1 ? "" : "s"}`,
      progress.loading
        ? `${progress.loadedSessions}/${progress.totalSessions} sessions scanned`
        : `${progress.loadedSessions} session${progress.loadedSessions === 1 ? "" : "s"}`,
      `${formatRecallScope(this.scope)} scope`,
    ];

    if (progress.skippedSessions > 0) {
      parts.push(`skipped ${progress.skippedSessions}`);
    }

    return parts.join(" · ");
  }

  private buildResultsLine(): string {
    const pageCount = Math.max(1, Math.ceil(this.state.results.length / this.pageSize));
    const parts = [
      `${formatResultMode(this.state.resultMode)} results`,
      `${this.state.results.length} match${this.state.results.length === 1 ? "" : "es"}`,
    ];

    if (this.state.results.length > 0) {
      parts.push(`selected ${this.selectedIndex + 1}/${this.state.results.length}`);
      parts.push(`page ${this.pageIndex + 1}/${pageCount}`);
    }

    return parts.join(" · ");
  }

  private buildPreviewLine(width: number): string {
    if (this.state.results.length === 0) {
      return "Preview";
    }

    const selected = this.state.results[this.selectedIndex];
    const parts = ["Preview", `${this.selectedIndex + 1}/${this.state.results.length}`];
    if (selected?.isCurrentSession) {
      parts.push("current session");
    }

    if (selected) {
      const hiddenLines = this.getWrappedPreviewLines(selected, width).length - PREVIEW_BODY_LINES;
      if (hiddenLines > 0) {
        parts.push(`+${hiddenLines} more`);
      }
    }

    return parts.join(" · ");
  }

  private getWrappedPreviewLines(message: RecallMessage, width: number): string[] {
    return wrapTextWithAnsi(message.text.trim(), width).filter(Boolean);
  }

  private buildHelpLine(): string {
    const parts = [
      formatKeybindingPair(this.keybindings, "tui.select.up", "tui.select.down", "move"),
    ];

    if (this.state.results.length > this.pageSize) {
      parts.push(
        formatKeybindingPair(this.keybindings, "tui.select.pageUp", "tui.select.pageDown", "pages")
      );
    }

    parts.push(
      formatKeybindingHint(this.keybindings, "tui.input.tab", "scope"),
      formatKeybindingHint(this.keybindings, "tui.select.confirm", "restore"),
      formatKeybindingHint(this.keybindings, "tui.select.cancel", "cancel")
    );

    return parts.join(" · ");
  }

  private highlightSelected(text: string): string {
    return this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(text)));
  }
}

export async function captureShortcutKey(
  ctx: ExtensionContext,
  options?: { currentValue?: string }
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) => {
      return new ShortcutCaptureDialog(theme, {
        ...(options?.currentValue ? { currentValue: options.currentValue } : {}),
        requestRender: () => tui.requestRender(),
        onDone: done,
      });
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 52,
        maxHeight: 8,
      },
    }
  );
}

class ShortcutCaptureDialog implements Component {
  private hint = "Press a shortcut. Esc cancels.";

  constructor(
    private readonly theme: DialogTheme,
    private readonly callbacks: {
      currentValue?: string;
      requestRender: () => void;
      onDone: (value: string | undefined) => void;
    }
  ) {}

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const innerWidth = Math.max(20, width - 2);
    return renderDialogBox(this.theme, innerWidth, [
      this.theme.fg(
        "accent",
        truncateToWidth(this.theme.bold("Set Message Recall shortcut"), innerWidth)
      ),
      this.theme.fg(
        "dim",
        truncateToWidth(
          `Current: ${formatShortcutKey(this.callbacks.currentValue)} · Backspace resets to ${formatShortcutKey(DEFAULT_SHORTCUT_KEY)}`,
          innerWidth
        )
      ),
      this.theme.fg("text", truncateToWidth(this.hint, innerWidth)),
    ]);
  }

  handleInput(data: string): void {
    const parsed = parseKey(data);
    if (!parsed) {
      return;
    }

    if (parsed === "escape") {
      this.callbacks.onDone(undefined);
      return;
    }

    if (parsed === "backspace" || parsed === "delete") {
      const validation = validateShortcutKey(DEFAULT_SHORTCUT_KEY);
      if (validation.normalized) {
        this.callbacks.onDone(validation.normalized);
        return;
      }

      this.hint = validation.error ?? "The default shortcut is not available right now.";
      this.callbacks.requestRender();
      return;
    }

    const validation = validateShortcutKey(parsed);
    if (validation.normalized) {
      this.callbacks.onDone(validation.normalized);
      return;
    }

    this.hint = validation.error ?? "That shortcut is not valid.";
    this.callbacks.requestRender();
  }
}

async function updateDefaultScope(
  ctx: ExtensionContext,
  settings: RecallSettings,
  settingsPath: string
): Promise<RecallSettings | undefined> {
  const availableScopes = [...RECALL_SCOPES];
  const labels = availableScopes.map((scope) => formatRecallScope(scope));
  const selected = await ctx.ui.select("Default Message Recall scope", labels);
  if (!selected) {
    return undefined;
  }

  const nextScope = availableScopes[labels.indexOf(selected)];
  if (!nextScope || nextScope === settings.defaultScope) {
    return undefined;
  }

  const nextSettings = { ...settings, defaultScope: nextScope };
  saveRecallSettings(nextSettings, settingsPath);
  ctx.ui.notify(`Default Recall scope saved: ${formatRecallScope(nextScope)}.`, "info");
  return nextSettings;
}

async function toggleShortcut(
  ctx: ExtensionContext,
  settings: RecallSettings
): Promise<RecallSettings | undefined> {
  if (settings.shortcutEnabled) {
    const nextSettings = { ...settings, shortcutEnabled: false };
    ctx.ui.notify("Recall shortcut disabled. Reload to apply the change.", "info");
    return nextSettings;
  }

  ctx.ui.notify("Press the shortcut you want to enable for Message Recall.", "info");
  const captured = await captureShortcutKey(ctx, {
    currentValue: normalizeShortcutKey(settings.shortcutKey) ?? settings.shortcutKey,
  });
  if (!captured) {
    return undefined;
  }

  const nextSettings = {
    ...settings,
    shortcutEnabled: true,
    shortcutKey: captured,
  };
  ctx.ui.notify("Recall shortcut enabled. Reload to apply the change.", "info");
  return nextSettings;
}

function shortcutReloadRequired(before: RecallSettings, after: RecallSettings): boolean {
  const beforeKey = normalizeShortcutKey(before.shortcutKey);
  const afterKey = normalizeShortcutKey(after.shortcutKey);
  const changed = before.shortcutEnabled !== after.shortcutEnabled || beforeKey !== afterKey;
  return changed && (before.shortcutEnabled || after.shortcutEnabled);
}

function compareMessages(left: RecallMessage, right: RecallMessage): number {
  return right.timestamp - left.timestamp;
}

function mergeMessagesByTimestamp(
  existing: RecallMessage[],
  incoming: RecallMessage[]
): RecallMessage[] {
  if (incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return [...incoming].sort(compareMessages);
  }

  const sortedIncoming = [...incoming].sort(compareMessages);
  const merged: RecallMessage[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;

  while (existingIndex < existing.length && incomingIndex < sortedIncoming.length) {
    const existingMessage = existing[existingIndex];
    const incomingMessage = sortedIncoming[incomingIndex];
    if (!existingMessage || !incomingMessage) {
      break;
    }

    if (existingMessage.timestamp >= incomingMessage.timestamp) {
      merged.push(existingMessage);
      existingIndex += 1;
      continue;
    }

    merged.push(incomingMessage);
    incomingIndex += 1;
  }

  if (existingIndex < existing.length) {
    merged.push(...existing.slice(existingIndex));
  }

  if (incomingIndex < sortedIncoming.length) {
    merged.push(...sortedIncoming.slice(incomingIndex));
  }

  return merged;
}

function formatMessageDescription(message: RecallMessage): string {
  const parts = [formatRelativeTime(message.timestamp)];
  if (message.isCurrentSession) {
    parts.push("current session");
  }

  if (message.sessionName) {
    parts.push(message.sessionName);
  }

  parts.push(compactPath(message.sessionCwd));
  return parts.join(" · ");
}

function formatRelativeTime(timestamp: number): string {
  const deltaMs = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (deltaMs < minute) {
    return "just now";
  }

  if (deltaMs < hour) {
    return `${Math.floor(deltaMs / minute)}m ago`;
  }

  if (deltaMs < day) {
    return `${Math.floor(deltaMs / hour)}h ago`;
  }

  if (deltaMs < week) {
    return `${Math.floor(deltaMs / day)}d ago`;
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

function compactPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }

  return path;
}

function formatResultMode(mode: RecallSearchResult["mode"]): string {
  switch (mode) {
    case "recent":
      return "Recent";
    case "text":
      return "Text";
    case "regex":
      return "Regex";
  }
}

function renderDialogBox(theme: DialogTheme, innerWidth: number, lines: string[]): string[] {
  const top = theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`);
  const bottom = theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`);
  const middle = lines.map(
    (line) =>
      `${theme.fg("borderAccent", "│")}${padAnsi(truncateToWidth(line, innerWidth), innerWidth)}${theme.fg("borderAccent", "│")}`
  );
  return [top, ...middle, bottom];
}

function padAnsi(text: string, width: number): string {
  const currentWidth = visibleWidth(text);
  if (currentWidth >= width) {
    return text;
  }

  return `${text}${" ".repeat(width - currentWidth)}`;
}

function padBlockLines(lines: string[], minLines: number): string[] {
  const next = [...lines];
  while (next.length < minLines) {
    next.push("");
  }
  return next;
}

type DialogKeybinding = Parameters<KeybindingsManager["getKeys"]>[0];

function formatKeybindingPair(
  keybindings: KeybindingsManager,
  first: DialogKeybinding,
  second: DialogKeybinding,
  description: string
): string {
  return `${formatKeyLabelList(keybindings, first)}/${formatKeyLabelList(keybindings, second)} ${description}`;
}

function formatKeybindingHint(
  keybindings: KeybindingsManager,
  keybinding: DialogKeybinding,
  description: string
): string {
  return `${formatKeyLabelList(keybindings, keybinding)} ${description}`;
}

function formatKeyLabelList(keybindings: KeybindingsManager, keybinding: DialogKeybinding): string {
  return keybindings.getKeys(keybinding).map(formatKeyLabel).join("/");
}

function formatKeyLabel(key: string): string {
  return formatShortcutKey(key)
    .replace("PageUp", "PgUp")
    .replace("PageDown", "PgDn")
    .replace("Escape", "Esc");
}
