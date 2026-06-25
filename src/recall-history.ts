import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LOAD_YIELD_INTERVAL, MAX_PREVIEW_LENGTH } from "./recall-constants.js";
import {
  type HistoryDependencies,
  type RecallHistoryRequest,
  type RecallLoadProgress,
  type RecallMessage,
  type RecallScope,
  type RecallSessionInfo,
  type SessionEntryLike,
} from "./recall-types.js";

const CURRENT_SESSION_SENTINEL = "__current_session__";

const defaultHistoryDependencies: HistoryDependencies = {
  list: async (cwd, sessionDir) => {
    const sessions = await SessionManager.list(cwd, sessionDir);
    return sessions.map((session) => ({
      path: session.path,
      cwd: session.cwd,
      ...(session.name ? { name: session.name } : {}),
      modified: session.modified,
      isCurrentSession: false,
    }));
  },
  listAll: async () => {
    const sessions = await SessionManager.listAll();
    return sessions.map((session) => ({
      path: session.path,
      cwd: session.cwd,
      ...(session.name ? { name: session.name } : {}),
      modified: session.modified,
      isCurrentSession: false,
    }));
  },
  open: (path) => SessionManager.open(path),
  findRepoRoot: findGitRoot,
  yieldToUi: () => new Promise((resolveYield) => setTimeout(resolveYield, 0)),
};

export function getAvailableScopes(
  cwd: string,
  dependencies: Pick<HistoryDependencies, "findRepoRoot"> = defaultHistoryDependencies
): RecallScope[] {
  const scopes: RecallScope[] = ["project"];
  if (dependencies.findRepoRoot(cwd)) {
    scopes.push("repo");
  }
  scopes.push("all");
  return scopes;
}

export function resolveRecallScope(
  scope: RecallScope,
  availableScopes: RecallScope[]
): RecallScope {
  return availableScopes.includes(scope) ? scope : "project";
}

export function extractUserMessages(
  entries: SessionEntryLike[],
  meta: {
    sessionPath: string;
    sessionCwd: string;
    sessionName?: string;
    isCurrentSession: boolean;
    fallbackTimestamp?: number;
  }
): RecallMessage[] {
  const messages: RecallMessage[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message?.role !== "user") {
      continue;
    }

    const text = extractUserMessageText(entry.message.content);
    if (!text) {
      continue;
    }

    const timestamp = resolveEntryTimestamp(entry, meta.fallbackTimestamp, index);
    messages.push({
      id: `${meta.sessionPath}:${entry.id ?? index}`,
      sessionPath: meta.sessionPath,
      sessionCwd: meta.sessionCwd,
      ...(meta.sessionName ? { sessionName: meta.sessionName } : {}),
      timestamp,
      text,
      preview: buildPreview(text),
      normalizedText: normalizeWhitespace(text).toLowerCase(),
      isCurrentSession: meta.isCurrentSession,
    });
  }

  return messages;
}

export async function loadMessagesForScope(
  request: RecallHistoryRequest,
  callbacks: {
    onBatch(messages: RecallMessage[], progress: RecallLoadProgress): void;
    onProgress(progress: RecallLoadProgress): void;
  },
  options?: {
    signal?: AbortSignal;
    dependencies?: HistoryDependencies;
  }
): Promise<RecallLoadProgress> {
  const dependencies = options?.dependencies ?? defaultHistoryDependencies;
  const listed = await listSessionsForScope(request, dependencies);
  const progress: RecallLoadProgress = {
    scope: request.scope,
    totalSessions: listed.sessions.length,
    loadedSessions: 0,
    loadedMessages: 0,
    skippedSessions: 0,
    loading: true,
    ...(listed.unavailableReason ? { unavailableReason: listed.unavailableReason } : {}),
  };

  callbacks.onProgress({ ...progress });

  for (const [index, sessionInfo] of listed.sessions.entries()) {
    if (options?.signal?.aborted) {
      return { ...progress, loading: false };
    }

    try {
      const isCurrent = sessionInfo.isCurrentSession;
      let sessionEntries = request.currentSessionEntries;
      let sessionName = request.currentSessionName;
      let sessionCwd = request.currentCwd;

      if (!isCurrent) {
        const openedSession = dependencies.open(sessionInfo.path);
        sessionEntries = openedSession.getEntries();
        sessionName = openedSession.getSessionName() ?? sessionInfo.name;
        sessionCwd = openedSession.getCwd();
      }

      const messages = extractUserMessages(sessionEntries, {
        sessionPath: sessionInfo.path,
        sessionCwd,
        ...(sessionName ? { sessionName } : {}),
        isCurrentSession: isCurrent,
        fallbackTimestamp: sessionInfo.modified.getTime(),
      });

      progress.loadedSessions += 1;
      progress.loadedMessages += messages.length;
      callbacks.onBatch(messages, { ...progress });
      callbacks.onProgress({ ...progress });
    } catch {
      progress.loadedSessions += 1;
      progress.skippedSessions += 1;
      callbacks.onProgress({ ...progress });
    }

    if ((index + 1) % LOAD_YIELD_INTERVAL === 0) {
      await dependencies.yieldToUi();
    }
  }

  progress.loading = false;
  callbacks.onProgress({ ...progress });
  return { ...progress };
}

export function findGitRoot(cwd: string): string | undefined {
  try {
    const result = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return result ? resolve(result) : undefined;
  } catch {
    return undefined;
  }
}

function extractUserMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() ? content : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      parts.push(block.text);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  const joined = parts.join("\n\n").trim();
  return joined || undefined;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function resolveEntryTimestamp(
  entry: SessionEntryLike,
  fallbackTimestamp: number | undefined,
  fallbackIndex: number
): number {
  if (typeof entry.message?.timestamp === "number" && Number.isFinite(entry.message.timestamp)) {
    return entry.message.timestamp;
  }

  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (typeof fallbackTimestamp === "number" && Number.isFinite(fallbackTimestamp)) {
    return fallbackTimestamp + fallbackIndex;
  }

  return fallbackIndex;
}

function buildPreview(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= MAX_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function listSessionsForScope(
  request: RecallHistoryRequest,
  dependencies: HistoryDependencies
): Promise<{ sessions: RecallSessionInfo[]; unavailableReason?: string }> {
  if (request.scope === "project") {
    const sessions = await dependencies.list(request.currentCwd, request.currentSessionDir);
    return { sessions: attachCurrentSession(sessions, request) };
  }

  const [allSessions, projectSessions] = await Promise.all([
    dependencies.listAll(),
    dependencies.list(request.currentCwd, request.currentSessionDir),
  ]);
  const combined = dedupeSessions([...allSessions, ...projectSessions]);

  if (request.scope === "all") {
    return { sessions: attachCurrentSession(combined, request) };
  }

  const repoRoot = dependencies.findRepoRoot(request.currentCwd);
  if (!repoRoot) {
    return {
      sessions: [],
      unavailableReason: "Repo scope is only available inside a git repository.",
    };
  }

  const filtered = combined.filter((session) => isWithinRoot(repoRoot, session.cwd));
  return { sessions: attachCurrentSession(filtered, request) };
}

function attachCurrentSession(
  sessions: RecallSessionInfo[],
  request: RecallHistoryRequest
): RecallSessionInfo[] {
  const nextSessions = dedupeSessions(sessions).sort(compareSessions);
  if (!request.currentSessionFile) {
    return [createSyntheticCurrentSession(request), ...nextSessions];
  }

  const existingIndex = nextSessions.findIndex(
    (session) => session.path === request.currentSessionFile
  );
  if (existingIndex >= 0) {
    return nextSessions
      .map((session, index) =>
        index === existingIndex
          ? {
              ...session,
              isCurrentSession: true,
              modified: new Date(),
            }
          : session
      )
      .sort(compareSessions);
  }

  return [createSyntheticCurrentSession(request), ...nextSessions].sort(compareSessions);
}

function createSyntheticCurrentSession(request: RecallHistoryRequest): RecallSessionInfo {
  return {
    path: request.currentSessionFile ?? `${CURRENT_SESSION_SENTINEL}:${request.currentCwd}`,
    cwd: request.currentCwd,
    ...(request.currentSessionName ? { name: request.currentSessionName } : {}),
    modified: new Date(),
    isCurrentSession: true,
  };
}

function dedupeSessions(sessions: RecallSessionInfo[]): RecallSessionInfo[] {
  const byPath = new Map<string, RecallSessionInfo>();

  for (const session of sessions) {
    const previous = byPath.get(session.path);
    if (!previous || previous.modified < session.modified || session.isCurrentSession) {
      byPath.set(session.path, session);
    }
  }

  return [...byPath.values()];
}

function compareSessions(left: RecallSessionInfo, right: RecallSessionInfo): number {
  return right.modified.getTime() - left.modified.getTime();
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}
