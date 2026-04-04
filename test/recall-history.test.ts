import assert from "node:assert/strict";
import test from "node:test";
import {
  extractUserMessages,
  getAvailableScopes,
  loadMessagesForScope,
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
    open: (path) => {
      const session = sessions.get(path);
      if (!session) {
        throw new Error(`Unknown session: ${path}`);
      }
      return {
        getEntries: () => session.entries as Parameters<typeof extractUserMessages>[0],
        getSessionName: () => session.name,
        getCwd: () => session.cwd,
      };
    },
    findRepoRoot: () => undefined,
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
    open: (path) => {
      const session = sessions.get(path);
      if (!session) {
        throw new Error(`Unknown session: ${path}`);
      }
      return {
        getEntries: () => session.entries as Parameters<typeof extractUserMessages>[0],
        getSessionName: () => undefined,
        getCwd: () => session.cwd,
      };
    },
    findRepoRoot: () => "/work/repo",
    yieldToUi: async () => {},
  };

  const result = await loadMessagesForScope(
    {
      scope: "repo",
      currentCwd: "/work/repo/app",
      currentSessionDir: "/tmp/sessions",
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
  assert.deepEqual(getAvailableScopes("/work/repo/app", { findRepoRoot: () => "/work/repo" }), [
    "project",
    "repo",
    "all",
  ]);
  assert.deepEqual(getAvailableScopes("/work/misc", { findRepoRoot: () => undefined }), [
    "project",
    "all",
  ]);
  assert.equal(resolveRecallScope("repo", ["project", "all"]), "project");
});
