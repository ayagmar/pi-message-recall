import { homedir } from "node:os";
import { sep } from "node:path";
import {
  type ExtensionContext,
  type KeybindingsManager,
  keyHint,
  keyText,
  rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  getKeybindings,
  Input,
  type KeybindingsConfig,
  parseKey,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_SHORTCUT_KEY,
  RECALL_PICKER_LAYOUTS,
  RECALL_SCOPES,
  RESULT_PAGE_SIZE,
} from "./recall-constants.js";
import { getAvailableScopes, loadMessagesForScope, resolveRecallScope } from "./recall-history.js";
import { searchRecallMessages } from "./recall-search.js";
import {
  createRecallSettings,
  formatRecallPickerLayout,
  formatRecallScope,
  saveRecallSettings,
} from "./recall-settings.js";
import {
  formatShortcutKey,
  getDefaultReservedAppKeybindings,
  normalizeShortcutKey,
  validateShortcutKey,
} from "./recall-shortcut.js";
import {
  type RecallLoadProgress,
  type RecallMessage,
  type RecallPickerLayoutPreference,
  type RecallPickerOptions,
  type RecallScope,
  type RecallSearchResult,
  type RecallSettings,
  type RecallSettingsFlowResult,
  type SessionEntryLike,
} from "./recall-types.js";

export async function openRecallPicker(
  ctx: ExtensionContext,
  options: RecallPickerOptions
): Promise<RecallMessage | undefined> {
  const layoutPreset = getRecallPickerLayoutPreset(options.settings.pickerLayout);

  // Nothing is awaited before ctx.ui.custom(): keys typed right after the shortcut must reach the
  // picker's search field, not the editor whose draft was already captured. The git root (which
  // decides whether Repo scope is offered) is resolved by the dialog once it is open.
  return ctx.ui.custom<RecallMessage | undefined>(
    (tui, theme, keybindings, done) => {
      return new RecallPickerDialog(
        theme,
        keybindings,
        {
          initialQuery: options.initialQuery,
          defaultScope: options.settings.defaultScope,
          findRepoRoot: (signal) => options.findRepoRoot(ctx.cwd, signal),
          layoutPreference: options.settings.pickerLayout,
          currentCwd: ctx.cwd,
          currentSessionDir: ctx.sessionManager.getSessionDir(),
          // All branches on purpose (not getBranch()): prompts from abandoned branches are still
          // text the user typed. Only role "user" message entries are read, so system messages and
          // usage/context_edit entries are ignored.
          currentSessionEntries: ctx.sessionManager.getEntries() as SessionEntryLike[],
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
          getTerminalRows: () => tui.terminal.rows,
          getTerminalColumns: () => tui.terminal.columns,
        }
      );
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: `${layoutPreset.overlayWidthPercent}%`,
        minWidth: RECALL_PICKER_OVERLAY_MIN_WIDTH,
        maxHeight: `${RECALL_PICKER_OVERLAY_MAX_HEIGHT_PERCENT}%`,
        margin: RECALL_PICKER_OVERLAY_MARGIN,
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
      `Picker layout · ${formatRecallPickerLayout(settings.pickerLayout)}`,
      `Shortcut · ${settings.shortcutEnabled ? "Enabled" : "Disabled"}`,
      `Shortcut key · ${formatShortcutKey(settings.shortcutKey)}`,
      "Reset to defaults",
    ];
    const selected = await ctx.ui.select("Message Recall settings", choices);
    if (!selected) {
      // Scope and layout changes are saved as soon as they are picked, so report them on exit too.
      return settings === options.settings ? undefined : { settings, reloadRequired: false };
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
        const next = await updatePickerLayout(ctx, settings, options.settingsPath);
        if (!next) {
          continue;
        }

        settings = next;
        continue;
      }

      case 2: {
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

      case 3: {
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

      case 4: {
        const confirmed = await ctx.ui.confirm(
          "Reset Message Recall settings",
          "Restore the default scope, picker layout, and shortcut?"
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

const RECALL_PICKER_OVERLAY_MIN_WIDTH = 72;
const RECALL_PICKER_OVERLAY_MARGIN = 1;
const RECALL_PICKER_OVERLAY_MAX_HEIGHT_PERCENT = 84;

const RESULT_PRIMARY_COLUMN_WIDTH = 38;

type RecallPickerLayoutPreset = {
  overlayWidthPercent: number;
  resultPrimaryColumnWidthRatio: number;
  maxResultPrimaryColumnWidth: number;
};

const RECALL_PICKER_LAYOUT_PRESETS: Record<RecallPickerLayoutPreference, RecallPickerLayoutPreset> =
  {
    compact: {
      overlayWidthPercent: 72,
      resultPrimaryColumnWidthRatio: 0.46,
      maxResultPrimaryColumnWidth: 68,
    },
    balanced: {
      overlayWidthPercent: 76,
      resultPrimaryColumnWidthRatio: 0.5,
      maxResultPrimaryColumnWidth: 80,
    },
    wide: {
      overlayWidthPercent: 82,
      resultPrimaryColumnWidthRatio: 0.55,
      maxResultPrimaryColumnWidth: 88,
    },
  };
const BASE_RESULT_PANEL_LINES = RESULT_PAGE_SIZE;
const BASE_PREVIEW_BODY_LINES = 4;
const BASE_PREVIEW_PANEL_LINES = BASE_PREVIEW_BODY_LINES + 1;
const MIN_RESULT_PANEL_LINES = 4;
const MIN_PREVIEW_PANEL_LINES = 3;
const MAX_PREVIEW_PANEL_FRACTION = 0.4;
const PICKER_FIXED_LINES = 12;

export interface RecallPickerLayout {
  overlayWidth: number;
  resultPrimaryColumnWidth: number;
  maxHeight: number;
  totalLines: number;
  resultLines: number;
  previewLines: number;
  previewBodyLines: number;
  pageSize: number;
}

export interface RecallPickerWindow {
  pageIndex: number;
  pageCount: number;
  pageStart: number;
  pageEnd: number;
  visibleStart: number;
  visibleEnd: number;
  selectedIndexInView: number;
}

function getRecallPickerLayoutPreset(
  layoutPreference: RecallPickerLayoutPreference
): RecallPickerLayoutPreset {
  return RECALL_PICKER_LAYOUT_PRESETS[layoutPreference];
}

function resolveRecallPickerOverlayWidth(
  terminalColumns: number,
  overlayWidthPercent: number
): number {
  const maxWidth = Math.max(1, terminalColumns - RECALL_PICKER_OVERLAY_MARGIN * 2);
  return Math.max(
    1,
    Math.min(
      Math.max(
        Math.floor((terminalColumns * overlayWidthPercent) / 100),
        RECALL_PICKER_OVERLAY_MIN_WIDTH
      ),
      maxWidth
    )
  );
}

export function resolveRecallPickerLayout(
  terminalRows: number,
  terminalColumns = RECALL_PICKER_OVERLAY_MIN_WIDTH,
  layoutPreference: RecallPickerLayoutPreference = "balanced"
): RecallPickerLayout {
  const preset = getRecallPickerLayoutPreset(layoutPreference);
  const overlayWidth = resolveRecallPickerOverlayWidth(terminalColumns, preset.overlayWidthPercent);
  const innerWidth = Math.max(20, overlayWidth - 2);
  const resultPrimaryColumnWidth = Math.max(
    RESULT_PRIMARY_COLUMN_WIDTH,
    Math.min(
      preset.maxResultPrimaryColumnWidth,
      Math.floor(innerWidth * preset.resultPrimaryColumnWidthRatio)
    )
  );
  const maxHeight = Math.max(
    1,
    Math.min(
      Math.floor((terminalRows * RECALL_PICKER_OVERLAY_MAX_HEIGHT_PERCENT) / 100),
      terminalRows - RECALL_PICKER_OVERLAY_MARGIN * 2
    )
  );
  const availablePanelLines = Math.max(0, maxHeight - PICKER_FIXED_LINES);

  if (availablePanelLines <= 0) {
    return {
      overlayWidth,
      resultPrimaryColumnWidth,
      maxHeight,
      totalLines: PICKER_FIXED_LINES,
      resultLines: 0,
      previewLines: 0,
      previewBodyLines: 0,
      pageSize: 1,
    };
  }

  let resultLines = 0;
  let previewLines = 0;

  if (availablePanelLines <= MIN_RESULT_PANEL_LINES + MIN_PREVIEW_PANEL_LINES) {
    resultLines = Math.max(1, availablePanelLines - 1);
    previewLines = Math.max(0, availablePanelLines - resultLines);
  } else {
    resultLines = Math.min(BASE_RESULT_PANEL_LINES, availablePanelLines - MIN_PREVIEW_PANEL_LINES);
    previewLines = Math.min(BASE_PREVIEW_PANEL_LINES, availablePanelLines - resultLines);

    const extraLines = availablePanelLines - resultLines - previewLines;
    if (extraLines > 0) {
      const previewExtra = Math.floor(extraLines / 3);
      previewLines += previewExtra;
      resultLines += extraLines - previewExtra;
    }
  }

  return {
    overlayWidth,
    resultPrimaryColumnWidth,
    maxHeight,
    totalLines: PICKER_FIXED_LINES + resultLines + previewLines,
    resultLines,
    previewLines,
    previewBodyLines: Math.max(0, previewLines - 1),
    pageSize: Math.max(1, resultLines),
  };
}

export function adjustRecallPickerLayoutForPreview(
  layout: RecallPickerLayout,
  previewBodyLineCount: number
): RecallPickerLayout {
  if (previewBodyLineCount <= layout.previewBodyLines) {
    return layout;
  }

  const panelLines = layout.resultLines + layout.previewLines;
  const maxPreviewLines = Math.max(
    layout.previewLines,
    Math.floor(panelLines * MAX_PREVIEW_PANEL_FRACTION)
  );
  const desiredPreviewLines = Math.min(maxPreviewLines, previewBodyLineCount + 1);
  const maxBorrow = Math.max(0, layout.resultLines - MIN_RESULT_PANEL_LINES);
  const borrowedLines = Math.min(maxBorrow, desiredPreviewLines - layout.previewLines);

  if (borrowedLines <= 0) {
    return layout;
  }

  const resultLines = layout.resultLines - borrowedLines;
  const previewLines = layout.previewLines + borrowedLines;

  return {
    ...layout,
    resultLines,
    previewLines,
    previewBodyLines: Math.max(0, previewLines - 1),
  };
}

export function resolveRecallPickerWindow(
  resultCount: number,
  selectedIndex: number,
  pageSize: number,
  visibleCount: number
): RecallPickerWindow {
  const safePageSize = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(resultCount / safePageSize));

  if (resultCount <= 0) {
    return {
      pageIndex: 0,
      pageCount,
      pageStart: 0,
      pageEnd: 0,
      visibleStart: 0,
      visibleEnd: 0,
      selectedIndexInView: 0,
    };
  }

  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, resultCount - 1));
  const pageIndex = Math.floor(safeSelectedIndex / safePageSize);
  const pageStart = pageIndex * safePageSize;
  const pageEnd = Math.min(pageStart + safePageSize, resultCount);
  const pageLength = pageEnd - pageStart;
  const safeVisibleCount = Math.max(1, Math.min(pageLength, visibleCount));
  const localIndex = safeSelectedIndex - pageStart;
  const maxOffset = Math.max(0, pageLength - safeVisibleCount);
  const centeredOffset = Math.max(0, localIndex - Math.floor(safeVisibleCount / 2));
  const visibleStart = pageStart + Math.min(centeredOffset, maxOffset);

  return {
    pageIndex,
    pageCount,
    pageStart,
    pageEnd,
    visibleStart,
    visibleEnd: Math.min(visibleStart + safeVisibleCount, pageEnd),
    selectedIndexInView: safeSelectedIndex - visibleStart,
  };
}

export function resolveRetainedSelectionIndex(
  results: RecallMessage[],
  previousSelectionId: string | undefined,
  previousSelectionText: string | undefined
): number {
  if (results.length === 0) {
    return -1;
  }

  if (previousSelectionId) {
    const byId = results.findIndex((message) => message.id === previousSelectionId);
    if (byId >= 0) {
      return byId;
    }
  }

  if (previousSelectionText) {
    return results.findIndex((message) => message.text === previousSelectionText);
  }

  return -1;
}

/**
 * Creates the picker's search field with the cursor after `initialQuery`, so typing refines the
 * prefilled query instead of being inserted in front of it (Input.setValue() keeps the cursor at 0).
 */
export function createSearchInput(initialQuery: string): Input {
  const input = new Input();
  if (initialQuery) {
    // A bracketed paste inserts at the cursor and moves past the text, whatever the keybindings.
    input.handleInput(`\x1b[200~${initialQuery}\x1b[201~`);
  }
  return input;
}

class RecallPickerDialog implements Component, Focusable {
  private readonly searchInput: Input;
  private readonly searchHint =
    'Search with words, "quoted phrases", or re:<pattern>. Empty query shows recent unique prompts.';

  private currentPageSize = RESULT_PAGE_SIZE;
  private currentVisibleResultCount = RESULT_PAGE_SIZE;
  private currentResultPrimaryColumnWidth = RESULT_PRIMARY_COLUMN_WIDTH;
  private selectList: SelectList = this.createSelectList(
    [],
    this.currentVisibleResultCount,
    this.currentPageSize,
    this.currentResultPrimaryColumnWidth
  );
  private selectedMessageId: string | undefined;
  private selectedIndex = 0;
  private loadAbort?: AbortController;
  private readonly repoRootAbort = new AbortController();
  private repoRoot: string | undefined;
  private availableScopes: RecallScope[] = getAvailableScopes(undefined);
  private scopeChangedByUser = false;
  private disposed = false;
  private _focused = false;

  private readonly state: PickerLoadState;
  private scope: RecallScope;

  constructor(
    private readonly theme: DialogTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: {
      initialQuery: string;
      defaultScope: RecallScope;
      findRepoRoot: (signal: AbortSignal) => Promise<string | undefined>;
      layoutPreference: RecallPickerLayoutPreference;
      currentCwd: string;
      currentSessionDir: string;
      currentSessionEntries: SessionEntryLike[];
      currentSessionFile: string | undefined;
      currentSessionName: string | undefined;
    },
    private readonly callbacks: {
      onDone: (value: RecallMessage | undefined) => void;
      requestRender: () => void;
      getTerminalRows: () => number;
      getTerminalColumns: () => number;
    }
  ) {
    // Repo scope is only offered once the git root is known; until then start in Project.
    this.scope = resolveRecallScope(options.defaultScope, this.availableScopes);
    this.searchInput = createSearchInput(options.initialQuery);
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
    this.refreshResults();

    void this.reloadScope(this.scope);
    void this.resolveRepoRoot();
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
    const layout = this.syncLayout(innerWidth);
    const lines: string[] = [
      this.renderHeaderLine(innerWidth),
      this.theme.fg("dim", truncateToWidth(this.buildMetaLine(), innerWidth)),
      this.renderScopeLine(innerWidth),
      ...this.renderSearchLines(innerWidth),
      this.renderDivider(innerWidth),
      this.theme.fg("accent", truncateToWidth(this.buildResultsLine(layout.pageSize), innerWidth)),
      ...this.renderResultsPanel(innerWidth, layout.resultLines),
      this.renderDivider(innerWidth),
      this.theme.fg(
        "accent",
        truncateToWidth(this.buildPreviewLine(innerWidth, layout.previewBodyLines), innerWidth)
      ),
      ...this.renderPreviewLines(innerWidth, layout.previewLines, layout.previewBodyLines),
      truncateToWidth(this.buildHelpLine(layout.pageSize), innerWidth),
    ];

    return renderDialogBox(this.theme, innerWidth, lines);
  }
  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.scopeChangedByUser = true;
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

  private async resolveRepoRoot(): Promise<void> {
    let repoRoot: string | undefined;
    try {
      repoRoot = await this.options.findRepoRoot(this.repoRootAbort.signal);
    } catch {
      repoRoot = undefined;
    }

    if (this.disposed || !repoRoot) {
      return;
    }

    this.repoRoot = repoRoot;
    this.availableScopes = getAvailableScopes(repoRoot);
    if (!this.scopeChangedByUser) {
      const defaultScope = resolveRecallScope(this.options.defaultScope, this.availableScopes);
      if (defaultScope !== this.scope) {
        void this.reloadScope(defaultScope);
        return;
      }
    }

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
    this.selectedIndex = 0;
    this.selectedMessageId = undefined;
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
          ...(this.repoRoot ? { repoRoot: this.repoRoot } : {}),
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
    this.repoRootAbort.abort();
    this.callbacks.onDone(value);
  }

  private getLayout(): RecallPickerLayout {
    return resolveRecallPickerLayout(
      this.callbacks.getTerminalRows(),
      this.callbacks.getTerminalColumns(),
      this.options.layoutPreference
    );
  }

  private applyLayout(layout: RecallPickerLayout): void {
    this.currentPageSize = layout.pageSize;
    this.currentVisibleResultCount = layout.resultLines;
    this.currentResultPrimaryColumnWidth = layout.resultPrimaryColumnWidth;
  }

  private rebuildSelectList(items: SelectItem[]): void {
    this.selectList = this.createSelectList(
      items,
      this.currentVisibleResultCount,
      this.currentPageSize,
      this.currentResultPrimaryColumnWidth
    );
  }

  private rebuildSelectListForCurrentPage(): void {
    this.rebuildSelectList(
      this.visibleResults(this.currentPageSize, this.currentVisibleResultCount)
    );
  }

  private syncLayout(width: number): RecallPickerLayout {
    const selected = this.state.results[this.selectedIndex];
    const layout = selected
      ? adjustRecallPickerLayoutForPreview(
          this.getLayout(),
          this.getWrappedPreviewLines(selected, width).length
        )
      : this.getLayout();

    if (
      layout.pageSize !== this.currentPageSize ||
      layout.resultLines !== this.currentVisibleResultCount ||
      layout.resultPrimaryColumnWidth !== this.currentResultPrimaryColumnWidth
    ) {
      this.applyLayout(layout);
      this.state.results.length === 0
        ? this.rebuildSelectList([])
        : this.rebuildSelectListForCurrentPage();
    }
    return layout;
  }

  private refreshResults(): void {
    const previousSelectionId = this.selectedMessageId;
    const previousSelectionText = this.state.results[this.selectedIndex]?.text;
    const result = searchRecallMessages(this.state.messages, this.searchInput.getValue());
    this.state.results = result.matches;
    this.state.resultMode = result.mode;
    this.state.queryError = result.error;
    this.applyLayout(this.getLayout());

    if (this.state.results.length === 0) {
      this.selectedIndex = 0;
      this.selectedMessageId = undefined;
      this.rebuildSelectList([]);
      return;
    }

    const selectedIndex = resolveRetainedSelectionIndex(
      this.state.results,
      previousSelectionId,
      previousSelectionText
    );
    this.selectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
    this.selectedMessageId = this.state.results[this.selectedIndex]?.id;
    this.rebuildSelectListForCurrentPage();
  }

  private createSelectList(
    items: SelectItem[],
    visibleCount: number,
    pageSize: number,
    resultPrimaryColumnWidth: number
  ): SelectList {
    const list = new SelectList(
      items,
      Math.max(1, Math.min(items.length, visibleCount)),
      {
        selectedPrefix: (text) => this.highlightSelected(text),
        selectedText: (text) => this.highlightSelected(text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
      {
        minPrimaryColumnWidth: resultPrimaryColumnWidth,
        maxPrimaryColumnWidth: resultPrimaryColumnWidth,
      }
    );

    if (items.length > 0) {
      list.setSelectedIndex(this.getCurrentWindow(pageSize, visibleCount).selectedIndexInView);
    }

    return list;
  }

  private visibleResults(pageSize: number, visibleCount: number): SelectItem[] {
    const window = this.getCurrentWindow(pageSize, visibleCount);
    return this.state.results.slice(window.visibleStart, window.visibleEnd).map((message) => ({
      value: message.id,
      label: message.preview,
      description: formatMessageDescription(message),
    }));
  }

  private getCurrentPageIndex(pageSize: number): number {
    return this.getCurrentWindow(pageSize, this.currentVisibleResultCount).pageIndex;
  }

  private getCurrentWindow(pageSize: number, visibleCount: number): RecallPickerWindow {
    return resolveRecallPickerWindow(
      this.state.results.length,
      this.selectedIndex,
      pageSize,
      visibleCount
    );
  }

  private moveSelection(delta: number): void {
    if (this.state.results.length === 0) {
      return;
    }

    const nextIndex = Math.max(
      0,
      Math.min(this.selectedIndex + delta, this.state.results.length - 1)
    );
    if (nextIndex === this.selectedIndex) {
      return;
    }

    this.selectedIndex = nextIndex;
    this.selectedMessageId = this.state.results[this.selectedIndex]?.id;
    this.applyLayout(this.getLayout());
    this.rebuildSelectListForCurrentPage();
    this.callbacks.requestRender();
  }

  private movePage(delta: number): void {
    const layout = this.getLayout();
    const pageSize = layout.pageSize;
    const pageCount = Math.max(1, Math.ceil(this.state.results.length / pageSize));
    if (pageCount <= 1) {
      return;
    }

    const currentPageIndex = this.getCurrentPageIndex(pageSize);
    const nextPageIndex = Math.max(0, Math.min(currentPageIndex + delta, pageCount - 1));
    if (nextPageIndex === currentPageIndex) {
      return;
    }

    const localIndex = this.selectedIndex - currentPageIndex * pageSize;
    this.selectedIndex = Math.min(
      nextPageIndex * pageSize + localIndex,
      this.state.results.length - 1
    );
    this.selectedMessageId = this.state.results[this.selectedIndex]?.id;
    this.applyLayout(layout);
    this.rebuildSelectListForCurrentPage();
    this.callbacks.requestRender();
  }

  private nextScope(): RecallScope {
    const currentIndex = this.availableScopes.indexOf(this.scope);
    const nextIndex = (currentIndex + 1) % this.availableScopes.length;
    return this.availableScopes[nextIndex] ?? this.scope;
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
    const pills = this.availableScopes.map((scope) => this.renderScopePill(scope)).join(" ");
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

  private renderResultsPanel(width: number, resultLines: number): string[] {
    const lines =
      this.state.results.length > 0 ? this.selectList.render(width) : this.renderEmptyState(width);
    return fitBlockLines(lines, resultLines);
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
          truncateToWidth(
            `Switch scope with ${keyText("tui.input.tab")} or try another directory.`,
            width
          )
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
          truncateToWidth(
            `Try ${keyText("tui.input.tab")} for a wider scope once you have more history.`,
            width
          )
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
              ? `Try shorter terms, quotes, regex, or press ${keyText("tui.input.tab")} to widen the scope.`
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

  private renderPreviewLines(
    width: number,
    previewLines: number,
    previewBodyLines: number
  ): string[] {
    const selected = this.state.results[this.selectedIndex];
    if (!selected) {
      return fitBlockLines(
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
            truncateToWidth(
              `Press ${keyText("tui.select.confirm")} to restore the highlighted prompt into the editor.`,
              width
            )
          ),
        ],
        previewLines
      );
    }

    return fitBlockLines(
      [
        this.theme.fg("dim", truncateToWidth(formatMessageDescription(selected), width)),
        ...this.getWrappedPreviewLines(selected, width).slice(0, previewBodyLines),
      ],
      previewLines
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
      return "Text mode · direct matches first, with fuzzy fallback for unquoted words.";
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

  private buildResultsLine(pageSize: number): string {
    const pageCount = Math.max(1, Math.ceil(this.state.results.length / pageSize));
    const parts = [
      `${formatResultMode(this.state.resultMode)} results`,
      `${this.state.results.length} match${this.state.results.length === 1 ? "" : "es"}`,
    ];

    if (this.state.results.length > 0) {
      parts.push(`selected ${this.selectedIndex + 1}/${this.state.results.length}`);
      parts.push(`page ${this.getCurrentPageIndex(pageSize) + 1}/${pageCount}`);
    }

    return parts.join(" · ");
  }

  private buildPreviewLine(width: number, previewBodyLines: number): string {
    if (this.state.results.length === 0) {
      return "Preview";
    }

    const selected = this.state.results[this.selectedIndex];
    const parts = ["Preview", `${this.selectedIndex + 1}/${this.state.results.length}`];
    if (selected?.isCurrentSession) {
      parts.push("current session");
    }

    if (selected) {
      const hiddenLines = this.getWrappedPreviewLines(selected, width).length - previewBodyLines;
      if (hiddenLines > 0) {
        parts.push(`+${hiddenLines} more`);
      }
    }

    return parts.join(" · ");
  }

  private getWrappedPreviewLines(message: RecallMessage, width: number): string[] {
    return wrapTextWithAnsi(message.text.trim(), width).filter(Boolean);
  }

  private buildHelpLine(pageSize: number): string {
    const parts = [rawKeyHint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "move")];

    if (this.state.results.length > pageSize) {
      parts.push(
        rawKeyHint(`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`, "pages")
      );
    }

    parts.push(
      keyHint("tui.input.tab", "scope"),
      keyHint("tui.select.confirm", "restore"),
      keyHint("tui.select.cancel", "cancel")
    );

    return parts.join(this.theme.fg("dim", " · "));
  }

  private highlightSelected(text: string): string {
    return this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(text)));
  }
}

export async function captureShortcutKey(
  ctx: ExtensionContext,
  options?: { currentValue?: string }
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    return promptShortcutKey(ctx, options);
  }

  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => {
      return new ShortcutCaptureDialog(theme, {
        ...(options?.currentValue ? { currentValue: options.currentValue } : {}),
        keybindings: keybindings.getResolvedBindings(),
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

// ctx.ui.custom() resolves to undefined outside the TUI (e.g. RPC clients), so ask for the key as
// text there instead of silently treating the capture as cancelled.
async function promptShortcutKey(
  ctx: ExtensionContext,
  options?: { currentValue?: string }
): Promise<string | undefined> {
  const typed = await ctx.ui.input(
    "Message Recall shortcut (e.g. alt+r, ctrl+alt+r)",
    options?.currentValue ?? DEFAULT_SHORTCUT_KEY
  );
  if (!typed?.trim()) {
    return undefined;
  }

  const validation = validateShortcutKey(typed, readFallbackKeybindings());
  if (!validation.normalized) {
    ctx.ui.notify(validation.error ?? "That shortcut is not valid.", "error");
    return undefined;
  }

  return validation.normalized;
}

/**
 * Keybindings to validate against when Pi's resolved bindings are not available (outside the TUI):
 * Pi's default reserved app.* keys plus the tui.* bindings pi-tui falls back to.
 */
function readFallbackKeybindings(): KeybindingsConfig {
  let tuiKeybindings: KeybindingsConfig = {};
  try {
    tuiKeybindings = getKeybindings().getResolvedBindings();
  } catch {
    // Keep the app.* defaults alone.
  }
  return { ...getDefaultReservedAppKeybindings(), ...tuiKeybindings };
}

class ShortcutCaptureDialog implements Component {
  private hint = "Press a shortcut. Esc cancels.";

  constructor(
    private readonly theme: DialogTheme,
    private readonly callbacks: {
      currentValue?: string;
      keybindings?: KeybindingsConfig;
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
      const validation = validateShortcutKey(DEFAULT_SHORTCUT_KEY, this.callbacks.keybindings);
      if (validation.normalized) {
        this.callbacks.onDone(validation.normalized);
        return;
      }

      this.hint = validation.error ?? "The default shortcut is not available right now.";
      this.callbacks.requestRender();
      return;
    }

    const validation = validateShortcutKey(parsed, this.callbacks.keybindings);
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

async function updatePickerLayout(
  ctx: ExtensionContext,
  settings: RecallSettings,
  settingsPath: string
): Promise<RecallSettings | undefined> {
  const availableLayouts = [...RECALL_PICKER_LAYOUTS];
  const labels = availableLayouts.map((layout) => formatRecallPickerLayout(layout));
  const selected = await ctx.ui.select("Message Recall picker layout", labels);
  if (!selected) {
    return undefined;
  }

  const nextLayout = availableLayouts[labels.indexOf(selected)];
  if (!nextLayout || nextLayout === settings.pickerLayout) {
    return undefined;
  }

  const nextSettings = { ...settings, pickerLayout: nextLayout };
  saveRecallSettings(nextSettings, settingsPath);
  ctx.ui.notify(
    `Message Recall picker layout saved: ${formatRecallPickerLayout(nextLayout)}.`,
    "info"
  );
  return nextSettings;
}

async function toggleShortcut(
  ctx: ExtensionContext,
  settings: RecallSettings
): Promise<RecallSettings | undefined> {
  if (settings.shortcutEnabled) {
    const nextSettings = { ...settings, shortcutEnabled: false };
    ctx.ui.notify("Recall shortcut disabled.", "info");
    return nextSettings;
  }

  ctx.ui.notify(
    ctx.mode === "tui"
      ? "Press the shortcut you want to enable for Message Recall."
      : "Enter the shortcut you want to enable for Message Recall.",
    "info"
  );
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
  ctx.ui.notify(`Recall shortcut enabled: ${formatShortcutKey(captured)}.`, "info");
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

  let existingMessage = existing[existingIndex];
  let incomingMessage = sortedIncoming[incomingIndex];

  while (existingMessage !== undefined && incomingMessage !== undefined) {
    if (existingMessage.timestamp >= incomingMessage.timestamp) {
      merged.push(existingMessage);
      existingIndex += 1;
      existingMessage = existing[existingIndex];
      continue;
    }

    merged.push(incomingMessage);
    incomingIndex += 1;
    incomingMessage = sortedIncoming[incomingIndex];
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

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const deltaMs = Math.max(0, now - timestamp);
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

  // Local calendar date: toISOString() is UTC and can be a day off from what the user expects.
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

export function compactPath(path: string, home = homedir()): string {
  if (!home) {
    return path;
  }

  if (path === home) {
    return "~";
  }

  const homePrefix = home.endsWith(sep) ? home : `${home}${sep}`;
  if (path.startsWith(homePrefix)) {
    return `~${sep}${path.slice(homePrefix.length)}`;
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
      `${theme.fg("borderAccent", "│")}${truncateToWidth(line, innerWidth, "...", true)}${theme.fg("borderAccent", "│")}`
  );
  return [top, ...middle, bottom];
}

function fitBlockLines(lines: string[], lineCount: number): string[] {
  if (lineCount <= 0) {
    return [];
  }

  const next = lines.slice(0, lineCount);
  while (next.length < lineCount) {
    next.push("");
  }
  return next;
}
