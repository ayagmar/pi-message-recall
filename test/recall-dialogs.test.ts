import assert from "node:assert/strict";
import test from "node:test";
import { RESULT_PAGE_SIZE } from "../src/recall-constants.js";
import {
  adjustRecallPickerLayoutForPreview,
  resolveRecallPickerLayout,
} from "../src/recall-dialogs.js";

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
  assert.ok(adjusted.pageSize < layout.pageSize);
});

void test("adjustRecallPickerLayoutForPreview leaves short prompts alone", () => {
  const layout = resolveRecallPickerLayout(40, 180, "balanced");
  const adjusted = adjustRecallPickerLayoutForPreview(layout, layout.previewBodyLines);

  assert.deepEqual(adjusted, layout);
});
