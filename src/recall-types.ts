import { type KeyId } from "@mariozechner/pi-tui";
import { type RECALL_PICKER_LAYOUTS, type RECALL_SCOPES } from "./recall-constants.js";

export type RecallScope = (typeof RECALL_SCOPES)[number];
export type RecallPickerLayoutPreference = (typeof RECALL_PICKER_LAYOUTS)[number];

export interface RecallSettings {
  defaultScope: RecallScope;
  pickerLayout: RecallPickerLayoutPreference;
  shortcutEnabled: boolean;
  shortcutKey: string;
}

export interface RecallMessage {
  id: string;
  sessionPath: string;
  sessionCwd: string;
  sessionName?: string;
  timestamp: number;
  text: string;
  preview: string;
  normalizedText: string;
  isCurrentSession: boolean;
}

export interface RecallSearchResult {
  matches: RecallMessage[];
  mode: "recent" | "text" | "regex";
  error?: string;
}

export interface ShortcutValidationResult {
  normalized?: string;
  error?: string;
}

export type ShortcutStatus =
  | {
      state: "active";
      key: KeyId;
      label: string;
    }
  | {
      state: "disabled";
      label: string;
      detail: string;
    }
  | {
      state: "skipped";
      label: string;
      detail: string;
    };

export interface RecallLoadProgress {
  scope: RecallScope;
  totalSessions: number;
  loadedSessions: number;
  loadedMessages: number;
  skippedSessions: number;
  loading: boolean;
  unavailableReason?: string;
}

export interface RecallSessionInfo {
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  isCurrentSession: boolean;
}

export interface RecallSessionLike {
  getEntries(): SessionEntryLike[];
  getSessionName(): string | undefined;
  getCwd(): string;
}

export interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
}

export interface RecallHistoryRequest {
  scope: RecallScope;
  currentCwd: string;
  currentSessionDir: string;
  currentSessionEntries: SessionEntryLike[];
  currentSessionFile?: string;
  currentSessionName?: string;
}

export interface HistoryDependencies {
  list(cwd: string, sessionDir?: string): Promise<RecallSessionInfo[]>;
  listAll(): Promise<RecallSessionInfo[]>;
  open(path: string): RecallSessionLike;
  findRepoRoot(cwd: string): string | undefined;
  yieldToUi(): Promise<void>;
}

export interface RecallPickerOptions {
  initialQuery: string;
  previousDraft: string;
  settings: RecallSettings;
}

export interface RecallSettingsFlowResult {
  settings: RecallSettings;
  reloadRequired: boolean;
}
