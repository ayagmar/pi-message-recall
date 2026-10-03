import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import test from "node:test";
import { type ExecOptions } from "@earendil-works/pi-coding-agent";
import {
  type ExecCommand,
  extractUserMessages,
  findGitRepoRoot,
  getAvailableScopes,
  isWithinRoot,
  loadMessagesForScope,
  readSessionFile,
  resolveCustomSessionDir,
  resolveRecallScope,
} from "../src/recall-history.js";
import {
  type HistoryDependencies,
  type RecallLoadProgress,
  type RecallMessage,
  type RecallSessionInfo,
} from "../src/recall-types.js";

void test("extractUserMessages keeps text content and ignores image-only entries", () => {
  const messages = extractUserMessages(
    [
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-03-31T12:00:00.000Z",
        message: { role: "user", content: "Refactor the picker" },
      },
      {
        type: "message",
        id: "user-2",
        timestamp: "2026-03-31T12:01:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "image", data: "..." },
            { type: "text", text: "Keep the key hints visible" },
          ],
        },
      },
      {
        type: "message",
        id: "user-3",
        timestamp: "2026-03-31T12:02:00.000Z",
        message: {
          role: "user",
          content: [{ type: "image", data: "..." }],
        },
      },
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-03-31T12:03:00.000Z",
        message: { role: "assistant", content: "done" },
      },
    ],
    {
      sessionPath: "/sessions/project.jsonl",
      sessionCwd: "/work/project",
      sessionName: "Picker cleanup",
      isCurrentSession: false,
    }
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.text, "Refactor the picker");
  assert.equal(messages[1]?.text, "Keep the key hints visible");
  assert.match(messages[1]?.preview ?? "", /key hints visible/i);
});

void test("extractUserMessages ignores pi 1.0 system messages and non-message entries", () => {
  const messages = extractUserMessages(
    [
      { type: "session", id: "header" },
      {
        type: "message",
        id: "system-1",
        timestamp: "2026-10-03T12:00:00.000Z",
        message: { role: "system", content: [{ type: "text", text: "You are pi" }] },
      },
      { type: "usage", id: "usage-1", timestamp: "2026-10-03T12:00:01.000Z" },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-10-03T12:00:02.000Z",
        message: { role: "user", content: "First real prompt" },
      },
      {
        type: "context_edit",
        id: "edit-1",
        timestamp: "2026-10-03T12:00:03.000Z",
        message: { role: "user", content: "not a message entry" },
      },
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-10-03T12:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      },
    ],
    {
      sessionPath: "/sessions/pi-1.jsonl",
      sessionCwd: "/work/project",
      isCurrentSession: false,
    }
  );

  assert.deepEqual(
    messages.map((message) => message.text),
    ["First real prompt"]
  );
});

void test("extractUserMessages falls back to the session timestamp when entries do not have one", () => {
  const messages = extractUserMessages(
    [
      {
        type: "message",
        id: "user-1",
        message: { role: "user", content: "Missing timestamp" },
      },
    ],
    {
      sessionPath: "/sessions/project.jsonl",
      sessionCwd: "/work/project",
      isCurrentSession: false,
      fallbackTimestamp: 1_700_000_000_000,
    }
  );

  assert.equal(messages[0]?.timestamp, 1_700_000_000_000);
});

void test("loadMessagesForScope includes the current live session alongside persisted sessions", async () => {
  const sessions = new Map<string, { cwd: string; entries: unknown[]; name?: string }>([
    [
      "/sessions/older.jsonl",
      {
        cwd: "/work/project",
        name: "Older session",
        entries: [
          {
            type: "message",
            id: "older-1",
            timestamp: "2026-03-30T12:00:00.000Z",
            message: { role: "user", content: "Investigate stale cache" },
          },
        ],
      },
    ],
  ]);
  const batches: RecallMessage[] = [];
  const progress: RecallLoadProgress[] = [];

  const dependencies: HistoryDependencies = {
    list: async () => [
      {
        path: "/sessions/older.jsonl",
        cwd: "/work/project",
        name: "Older session",
        modified: new Date("2026-03-30T12:00:00.000Z"),
        isCurrentSession: false,
      },
    ],
    listAll: async () => [],
    readSession: async (path) => {
      const session = sessions.get(path);
      if (!session) {
        throw new Error(`Unknown session: ${path}`);
      }
      return {
        entries: session.entries as Parameters<typeof extractUserMessages>[0],
        ...(session.name ? { name: session.name } : {}),
        cwd: session.cwd,
      };
    },
    yieldToUi: async () => {},
  };

  const result = await loadMessagesForScope(
    {
      scope: "project",
      currentCwd: "/work/project",
      currentSessionDir: "/tmp/sessions",
      currentSessionEntries: [
        {
          type: "message",
          id: "current-1",
          timestamp: "2026-03-31T12:00:00.000Z",
          message: { role: "user", content: "Ship the polished picker" },
        },
      ],
      currentSessionName: "Current session",
    },
    {
      onBatch: (messages) => {
        batches.push(...messages);
      },
      onProgress: (next) => {
        progress.push(next);
      },
    },
    { dependencies }
  );

  assert.equal(result.loading, false);
  assert.equal(result.loadedMessages, 2);
  assert.equal(batches.length, 2);
  assert.ok(batches.some((message) => message.isCurrentSession));
  assert.ok(batches.some((message) => /stale cache/i.test(message.text)));
  assert.ok(progress.some((entry) => entry.totalSessions === 2));
});

void test("repo scope filters sessions to the current git root", async () => {
  const repoSession: RecallSessionInfo = {
    path: "/sessions/repo.jsonl",
    cwd: "/work/repo/app",
    modified: new Date("2026-03-31T10:00:00.000Z"),
    isCurrentSession: false,
  };
  const otherSession: RecallSessionInfo = {
    path: "/sessions/other.jsonl",
    cwd: "/work/other-project",
    modified: new Date("2026-03-31T11:00:00.000Z"),
    isCurrentSession: false,
  };
  const sessions = new Map<string, { cwd: string; entries: unknown[] }>([
    [
      repoSession.path,
      {
        cwd: repoSession.cwd,
        entries: [
          {
            type: "message",
            id: "repo-1",
            timestamp: "2026-03-31T10:00:00.000Z",
            message: { role: "user", content: "repo message" },
          },
        ],
      },
    ],
    [
      otherSession.path,
      {
        cwd: otherSession.cwd,
        entries: [
          {
            type: "message",
            id: "other-1",
            timestamp: "2026-03-31T11:00:00.000Z",
            message: { role: "user", content: "other message" },
          },
        ],
      },
    ],
  ]);
  const loadedTexts: string[] = [];

  const dependencies: HistoryDependencies = {
    list: async () => [repoSession],
    listAll: async () => [repoSession, otherSession],
    readSession: async (path) => {
      const session = sessions.get(path);
      if (!session) {
        throw new Error(`Unknown session: ${path}`);
      }
      return {
        entries: session.entries as Parameters<typeof extractUserMessages>[0],
        cwd: session.cwd,
      };
    },
    yieldToUi: async () => {},
  };

  const result = await loadMessagesForScope(
    {
      scope: "repo",
      currentCwd: "/work/repo/app",
      currentSessionDir: "/tmp/sessions",
      repoRoot: "/work/repo",
      currentSessionEntries: [
        {
          type: "message",
          id: "repo-1",
          timestamp: "2026-03-31T10:00:00.000Z",
          message: { role: "user", content: "repo message" },
        },
      ],
      currentSessionFile: "/sessions/repo.jsonl",
    },
    {
      onBatch: (messages) => {
        loadedTexts.push(...messages.map((message) => message.text));
      },
      onProgress: () => {},
    },
    { dependencies }
  );

  assert.equal(result.loadedMessages, 1);
  assert.deepEqual(loadedTexts, ["repo message"]);
});

void test("available scopes expose repo only when git metadata is available", () => {
  assert.deepEqual(getAvailableScopes("/work/repo"), ["project", "repo", "all"]);
  assert.deepEqual(getAvailableScopes(undefined), ["project", "all"]);
  assert.equal(resolveRecallScope("repo", ["project", "all"]), "project");
});

void test("findGitRepoRoot runs git asynchronously with a timeout", async () => {
  const calls: { command: string; args: string[]; options: ExecOptions | undefined }[] = [];
  const exec: ExecCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "/work/repo\n", code: 0, killed: false };
  };

  assert.equal(await findGitRepoRoot(exec, "/work/repo/app"), resolve("/work/repo"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "git");
  assert.deepEqual(calls[0]?.args, ["-C", "/work/repo/app", "rev-parse", "--show-toplevel"]);
  assert.ok((calls[0]?.options?.timeout ?? 0) > 0);
});

void test("findGitRepoRoot hides repo scope when git fails, times out or is missing", async () => {
  const outcomes: ExecCommand[] = [
    // Not a repository.
    async () => ({ stdout: "", code: 128, killed: false }),
    // Killed by the timeout or the abort signal.
    async () => ({ stdout: "/work/repo\n", code: 0, killed: true }),
    // Empty output.
    async () => ({ stdout: "  \n", code: 0, killed: false }),
    async () => {
      throw new Error("spawn git ENOENT");
    },
  ];

  for (const exec of outcomes) {
    const repoRoot = await findGitRepoRoot(exec, "/work/misc");
    assert.equal(repoRoot, undefined);
    assert.deepEqual(getAvailableScopes(repoRoot), ["project", "all"]);
  }
});

void test("repo scope without a resolved repo root loads nothing and explains why", async () => {
  let listed = 0;
  const dependencies: HistoryDependencies = {
    list: async () => {
      listed += 1;
      return [];
    },
    listAll: async () => {
      listed += 1;
      return [];
    },
    readSession: async () => {
      throw new Error("no sessions to read");
    },
    yieldToUi: async () => {},
  };

  const result = await loadMessagesForScope(
    {
      scope: "repo",
      currentCwd: "/work/misc",
      currentSessionDir: "/tmp/sessions",
      currentSessionEntries: [],
    },
    { onBatch: () => {}, onProgress: () => {} },
    { dependencies }
  );

  assert.equal(result.totalSessions, 0);
  assert.match(result.unavailableReason ?? "", /git repository/i);
  assert.equal(listed, 0);
});

void test("readSessionFile reads an old-version session without rewriting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-history-"));
  const sessionPath = join(root, "legacy.jsonl");
  // A version 1 session: entries have no ids, so SessionManager.open() would migrate the file
  // and write it back to disk.
  const content = `${[
    { type: "session", id: "legacy", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/work/legacy" },
    {
      type: "message",
      timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "user", content: "Legacy prompt" },
    },
    { type: "session_info", timestamp: "2025-01-01T00:00:02.000Z", name: " Legacy work " },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;

  try {
    writeFileSync(sessionPath, content);
    const before = statSync(sessionPath).mtimeMs;

    const session = await readSessionFile(sessionPath);

    assert.equal(session.cwd, "/work/legacy");
    assert.equal(session.name, "Legacy work");
    assert.ok(session.entries.every((entry) => entry.type !== "session"));
    assert.deepEqual(
      extractUserMessages(session.entries, {
        sessionPath,
        sessionCwd: "/work/legacy",
        isCurrentSession: false,
      }).map((message) => message.text),
      ["Legacy prompt"]
    );
    assert.equal(readFileSync(sessionPath, "utf-8"), content);
    assert.equal(statSync(sessionPath).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("readSessionFile rejects files that are not Pi sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-message-recall-history-"));
  const sessionPath = join(root, "empty.jsonl");

  try {
    writeFileSync(sessionPath, "");
    await assert.rejects(readSessionFile(sessionPath), /not a pi session file/i);
    assert.equal(readFileSync(sessionPath, "utf-8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("isWithinRoot matches the repo root and its subdirectories only", () => {
  assert.equal(isWithinRoot("/work/repo", "/work/repo", posix), true);
  assert.equal(isWithinRoot("/work/repo", "/work/repo/app", posix), true);
  assert.equal(isWithinRoot("/work/repo", "/work/repo/..data", posix), true);
  assert.equal(isWithinRoot("/work/repo", "/work/repo-other", posix), false);
  assert.equal(isWithinRoot("/work/repo", "/work", posix), false);
  assert.equal(isWithinRoot("/work/repo", "", posix), false);
});

void test("isWithinRoot handles Windows paths", () => {
  // `git rev-parse --show-toplevel` prints forward slashes; session cwds use backslashes.
  assert.equal(isWithinRoot("C:/Users/me/repo", "C:\\Users\\me\\repo\\app", win32), true);
  assert.equal(isWithinRoot("C:/Users/me/repo", "c:\\users\\me\\repo", win32), true);
  assert.equal(isWithinRoot("C:/Users/me/repo", "C:\\Users\\me\\repo-other", win32), false);
  assert.equal(isWithinRoot("C:/Users/me/repo", "D:\\Users\\me\\repo", win32), false);
});

void test("loadMessagesForScope passes the abort signal to session listing", async () => {
  const controller = new AbortController();
  const seenSignals: (AbortSignal | undefined)[] = [];
  const dependencies: HistoryDependencies = {
    list: async (_cwd, _sessionDir, signal) => {
      seenSignals.push(signal);
      return [];
    },
    listAll: async (_sessionDir, signal) => {
      seenSignals.push(signal);
      return [];
    },
    readSession: async () => {
      throw new Error("no sessions to read");
    },
    yieldToUi: async () => {},
  };

  await loadMessagesForScope(
    {
      scope: "all",
      currentCwd: "/work/project",
      currentSessionDir: "/tmp/sessions",
      currentSessionEntries: [],
    },
    { onBatch: () => {}, onProgress: () => {} },
    { dependencies, signal: controller.signal }
  );

  assert.deepEqual(seenSignals, [controller.signal, controller.signal]);
});

void test("resolveCustomSessionDir keeps the default per-cwd tree and passes custom dirs through", () => {
  const agentDir = "/home/me/.pi/agent";
  assert.equal(
    resolveCustomSessionDir("/home/me/.pi/agent/sessions/--work-project--", agentDir),
    undefined
  );
  assert.equal(resolveCustomSessionDir("", agentDir), undefined);
  assert.equal(resolveCustomSessionDir(undefined, agentDir), undefined);
  assert.equal(resolveCustomSessionDir("/data/pi-sessions", agentDir), "/data/pi-sessions");
  assert.equal(
    resolveCustomSessionDir("/data/pi-sessions/", agentDir),
    "/data/pi-sessions",
    "trailing separators are normalized"
  );
});

void test("all and repo scopes list every project in a custom session directory", async () => {
  const customDir = "/data/pi-sessions";
  const sessionsInCustomDir: RecallSessionInfo[] = [
    {
      path: `${customDir}/current.jsonl`,
      cwd: "/work/repo/app",
      modified: new Date("2026-03-31T10:00:00.000Z"),
      isCurrentSession: false,
    },
    {
      path: `${customDir}/sibling.jsonl`,
      cwd: "/work/repo/lib",
      modified: new Date("2026-03-31T11:00:00.000Z"),
      isCurrentSession: false,
    },
    {
      path: `${customDir}/other.jsonl`,
      cwd: "/work/other-project",
      modified: new Date("2026-03-31T12:00:00.000Z"),
      isCurrentSession: false,
    },
  ];
  const listAllDirs: (string | undefined)[] = [];
  const dependencies: HistoryDependencies = {
    // Like SessionManager.list() with a custom dir: filtered to the current cwd.
    list: async (cwd) => sessionsInCustomDir.filter((session) => session.cwd === cwd),
    listAll: async (sessionDir) => {
      listAllDirs.push(sessionDir);
      return sessionDir === customDir ? sessionsInCustomDir : [];
    },
    readSession: async (path) => {
      const session = sessionsInCustomDir.find((candidate) => candidate.path === path);
      if (!session) {
        throw new Error(`Unknown session: ${path}`);
      }
      return {
        entries: [
          {
            type: "message",
            id: "user-1",
            timestamp: session.modified.toISOString(),
            message: { role: "user", content: `prompt from ${session.cwd}` },
          },
        ],
        cwd: session.cwd,
      };
    },
    yieldToUi: async () => {},
  };

  const loadTexts = async (scope: "all" | "repo") => {
    const texts: string[] = [];
    await loadMessagesForScope(
      {
        scope,
        currentCwd: "/work/repo/app",
        currentSessionDir: customDir,
        currentSessionEntries: [],
        currentSessionFile: `${customDir}/current.jsonl`,
        repoRoot: "/work/repo",
      },
      {
        onBatch: (messages) => {
          texts.push(...messages.map((message) => message.text));
        },
        onProgress: () => {},
      },
      { dependencies }
    );
    return texts.sort();
  };

  assert.deepEqual(await loadTexts("all"), [
    "prompt from /work/other-project",
    "prompt from /work/repo/lib",
  ]);
  assert.deepEqual(await loadTexts("repo"), ["prompt from /work/repo/lib"]);
  assert.deepEqual(listAllDirs, [customDir, customDir]);
});
