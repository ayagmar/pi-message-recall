import assert from "node:assert/strict";
import test from "node:test";
import { getRecallArgumentCompletions, parseRecallCommandArgs } from "../src/recall-command.js";

void test("parseRecallCommandArgs routes settings and status", () => {
  assert.deepEqual(parseRecallCommandArgs("settings"), { kind: "settings" });
  assert.deepEqual(parseRecallCommandArgs(" STATUS "), { kind: "status" });
});

void test("parseRecallCommandArgs treats other input as picker query", () => {
  assert.deepEqual(parseRecallCommandArgs(""), { kind: "picker", initialQuery: "" });
  assert.deepEqual(parseRecallCommandArgs("fix failing test"), {
    kind: "picker",
    initialQuery: "fix failing test",
  });
});

void test("getRecallArgumentCompletions filters known subcommands", () => {
  assert.deepEqual(getRecallArgumentCompletions("s"), [
    { value: "settings", label: "settings" },
    { value: "status", label: "status" },
  ]);
  assert.equal(getRecallArgumentCompletions("rec"), null);
});
