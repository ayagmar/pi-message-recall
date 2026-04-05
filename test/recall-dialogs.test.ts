import assert from "node:assert/strict";
import test from "node:test";
import { RESULT_PAGE_SIZE } from "../src/recall-constants.js";
import {
  adjustRecallPickerLayoutForPreview,
  resolveRecallPickerLayout,
  resolveRecallPickerWindow,
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
  assert.equal(adjusted.pageSize, layout.pageSize);
});

void test("adjustRecallPickerLayoutForPreview leaves short prompts alone", () => {
  const layout = resolveRecallPickerLayout(40, 180, "balanced");
  const adjusted = adjustRecallPickerLayoutForPreview(layout, layout.previewBodyLines);

  assert.deepEqual(adjusted, layout);
});

void test("resolveRecallPickerWindow keeps pagination stable when preview shrinks the list", () => {
  const layout = resolveRecallPickerLayout(40, 180, "balanced");
  const adjusted = adjustRecallPickerLayoutForPreview(layout, 18);
  const window = resolveRecallPickerWindow(1048, 61, adjusted.pageSize, adjusted.resultLines);

  assert.equal(window.pageCount, Math.ceil(1048 / layout.pageSize));
  assert.equal(window.pageIndex, Math.floor(61 / layout.pageSize));
  assert.equal(window.pageStart, Math.floor(61 / layout.pageSize) * layout.pageSize);
  assert.equal(window.selectedIndexInView, 61 - window.visibleStart);
  assert.equal(window.visibleEnd - window.visibleStart, adjusted.resultLines);
});

void test("resolveRecallPickerWindow keeps the selected item visible on the last page", () => {
  const window = resolveRecallPickerWindow(25, 24, 10, 4);

  assert.equal(window.pageIndex, 2);
  assert.equal(window.pageStart, 20);
  assert.equal(window.pageEnd, 25);
  assert.equal(window.visibleStart, 21);
  assert.equal(window.visibleEnd, 25);
  assert.equal(window.selectedIndexInView, 3);
});
