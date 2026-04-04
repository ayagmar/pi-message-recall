import assert from "node:assert/strict";
import test from "node:test";
import { searchRecallMessages } from "../src/recall-search.js";
import { type RecallMessage } from "../src/recall-types.js";

const messages: RecallMessage[] = [
  {
    id: "newest",
    sessionPath: "/sessions/current.jsonl",
    sessionCwd: "/work/project",
    timestamp: 3,
    text: "Fix the loading spinner regression",
    preview: "Fix the loading spinner regression",
    normalizedText: "fix the loading spinner regression",
    isCurrentSession: true,
  },
  {
    id: "middle",
    sessionPath: "/sessions/middle.jsonl",
    sessionCwd: "/work/project",
    timestamp: 2,
    text: "Keep the key hints visible in the picker",
    preview: "Keep the key hints visible in the picker",
    normalizedText: "keep the key hints visible in the picker",
    isCurrentSession: false,
  },
  {
    id: "oldest",
    sessionPath: "/sessions/oldest.jsonl",
    sessionCwd: "/work/project",
    timestamp: 1,
    text: "Add pagination before loading all sessions",
    preview: "Add pagination before loading all sessions",
    normalizedText: "add pagination before loading all sessions",
    isCurrentSession: false,
  },
];

void test("empty queries return recent messages first", () => {
  const result = searchRecallMessages(messages, "");

  assert.equal(result.mode, "recent");
  assert.deepEqual(
    result.matches.map((message) => message.id),
    ["newest", "middle", "oldest"]
  );
});

void test("text queries support quoted phrases", () => {
  const result = searchRecallMessages(messages, '"key hints" picker');

  assert.equal(result.mode, "text");
  assert.deepEqual(
    result.matches.map((message) => message.id),
    ["middle"]
  );
});

void test("regex queries match against original message text", () => {
  const result = searchRecallMessages(messages, "re:/loading.*regression/g");

  assert.equal(result.mode, "regex");
  assert.deepEqual(
    result.matches.map((message) => message.id),
    ["newest"]
  );
});

void test("invalid regex queries report a helpful error", () => {
  const result = searchRecallMessages(messages, "re:[");

  assert.equal(result.mode, "regex");
  assert.match(result.error ?? "", /regex search/i);
  assert.equal(result.matches.length, 0);
});

void test("explicit searches return every loaded match", () => {
  const matchingMessages = Array.from(
    { length: 250 },
    (_, index) =>
      ({
        id: `match-${index}`,
        sessionPath: `/sessions/${index}.jsonl`,
        sessionCwd: "/work/project",
        timestamp: 500 - index,
        text: `Recall this repeated prompt ${index}`,
        preview: `Recall this repeated prompt ${index}`,
        normalizedText: `recall this repeated prompt ${index}`,
        isCurrentSession: false,
      }) satisfies RecallMessage
  );

  const result = searchRecallMessages(matchingMessages, "repeated prompt");

  assert.equal(result.mode, "text");
  assert.equal(result.matches.length, 250);
  assert.equal(result.matches.at(-1)?.id, "match-249");
});
