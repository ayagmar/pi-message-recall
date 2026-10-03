import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, type PlatformPath, relative, resolve, sep } from "node:path";
import {
  type ExecOptions,
  type ExecResult,
  getAgentDir,
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  LOAD_YIELD_INTERVAL,
  MAX_PREVIEW_LENGTH,
  REPO_ROOT_LOOKUP_TIMEOUT_MS,
} from "./recall-constants.js";
import {
  type HistoryDependencies,
  type RecallHistoryRequest,
  type RecallLoadProgress,
  type RecallMessage,
  type RecallScope,
  type RecallSessionData,
  type RecallSessionInfo,
  type SessionEntryLike,
} from "./recall-types.js";

const CURRENT_SESSION_SENTINEL = "__current_session__";

const defaultHistoryDependencies: HistoryDependencies = {
  list: async (cwd, sessionDir, signal) => {
    const sessions = await SessionManager.list(cwd, sessionDir, undefined, signal);
    return sessions.map((session) => ({
      path: session.path,
      cwd: session.cwd,
      ...(session.name ? { name: session.name } : {}),
      modified: session.modified,
      isCurrentSession: false,
    }));
  },
  listAll: async (sessionDir, signal) => {
    const customSessionDir = resolveCustomSessionDir(sessionDir, getAgentDir());
    const sessions = customSessionDir
      ? await SessionManager.listAll(customSessionDir, undefined, signal)
      : await SessionManager.listAll(undefined, signal);
    return sessions.map((session) => ({
      path: session.path,
      cwd: session.cwd,
      ...(session.name ? { name: session.name } : {}),
      modified: session.modified,
      isCurrentSession: false,
    }));
  },
  readSession: readSessionFile,
  yieldToUi: () => new Promise((resolveYield) => setTimeout(resolveYield, 0)),
};

/**
 * The session directory to scan for the All and Repo scopes, or undefined for Pi's default tree.
 * Pi keeps one subdirectory per cwd under `<agentDir>/sessions`; a custom session directory
 * (`sessionDir` setting, `--session-dir`, PI_CODING_AGENT_SESSION_DIR) is flat and holds every
 * project's sessions, so it has to be listed directly, like /resume does. An empty dir is an
 * in-memory session, which uses the default tree.
 */
export function resolveCustomSessionDir(
  sessionDir: string | undefined,
  agentDir: string
): string | undefined {
  if (!sessionDir) {
    return undefined;
  }

  const resolved = resolve(sessionDir);
  return dirname(resolved) === resolve(agentDir, "sessions") ? undefined : resolved;
}

/** The scopes the picker offers; Repo needs the git root of the current cwd. */
export function getAvailableScopes(repoRoot: string | undefined): RecallScope[] {
  const scopes: RecallScope[] = ["project"];
  if (repoRoot) {
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
  const listed = await listSessionsForScope(request, dependencies, options?.signal);
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
        const session = await dependencies.readSession(sessionInfo.path, options?.signal);
        sessionEntries = session.entries;
        sessionName = session.name ?? sessionInfo.name;
        sessionCwd = session.cwd ?? sessionInfo.cwd;
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

/**
 * Reads a persisted session for recall without side effects. SessionManager.open() is not
 * read-only: it rewrites older-version session files in place when it migrates them, and recall
 * scans other projects' sessions, so the migration only happens in memory here.
 */
export async function readSessionFile(
  path: string,
  signal?: AbortSignal
): Promise<RecallSessionData> {
  const entries = parseSessionEntries(
    await readFile(path, { encoding: "utf-8", ...(signal ? { signal } : {}) })
  );
  const header = entries.find((entry) => entry.type === "session");
  if (!header) {
    throw new Error(`Not a Pi session file: ${path}`);
  }

  migrateSessionEntries(entries);

  let name: string | undefined;
  const sessionEntries: SessionEntryLike[] = [];
  for (const entry of entries) {
    if (entry.type === "session") {
      continue;
    }

    // Like SessionManager.getSessionName(): the latest session_info wins, and "" clears the name.
    if (entry.type === "session_info") {
      name = entry.name?.trim() || undefined;
    }
    sessionEntries.push(entry as SessionEntryLike);
  }

  return {
    entries: sessionEntries,
    ...(name ? { name } : {}),
    ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
  };
}

export type ExecCommand = (
  command: string,
  args: string[],
  options?: ExecOptions
) => Promise<Pick<ExecResult, "stdout" | "code" | "killed">>;

/**
 * The git root of `cwd`, or undefined outside a repository. Asynchronous and time-limited (via
 * pi.exec) so a slow or hung git never blocks the TUI.
 */
export async function findGitRepoRoot(
  exec: ExecCommand,
  cwd: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const result = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: REPO_ROOT_LOOKUP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const root = result.stdout.trim();
    return result.code === 0 && !result.killed && root ? resolve(root) : undefined;
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
  dependencies: HistoryDependencies,
  signal: AbortSignal | undefined
): Promise<{ sessions: RecallSessionInfo[]; unavailableReason?: string }> {
  if (request.scope === "project") {
    const sessions = await dependencies.list(request.currentCwd, request.currentSessionDir, signal);
    return { sessions: attachCurrentSession(sessions, request) };
  }

  const repoRoot = request.repoRoot;
  if (request.scope === "repo" && !repoRoot) {
    return {
      sessions: [],
      unavailableReason: "Repo scope is only available inside a git repository.",
    };
  }

  const [allSessions, projectSessions] = await Promise.all([
    dependencies.listAll(request.currentSessionDir, signal),
    dependencies.list(request.currentCwd, request.currentSessionDir, signal),
  ]);
  const combined = dedupeSessions([...allSessions, ...projectSessions]);

  if (request.scope === "all" || !repoRoot) {
    return { sessions: attachCurrentSession(combined, request) };
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

type PathApi = Pick<PlatformPath, "isAbsolute" | "relative" | "resolve" | "sep">;

const platformPath: PathApi = { isAbsolute, relative, resolve, sep };

/**
 * Whether `candidate` is `root` or lives below it. Uses path.relative so Windows separators and
 * drive-letter case work. An empty cwd (a session header without one) is never inside the repo.
 */
export function isWithinRoot(
  root: string,
  candidate: string,
  pathApi: PathApi = platformPath
): boolean {
  if (!candidate) {
    return false;
  }

  const fromRoot = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(fromRoot))
  );
}
