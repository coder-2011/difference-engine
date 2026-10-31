import assert from "node:assert/strict";
import test from "node:test";
import { draftStatus } from "../src/lib/pull-request-draft.ts";

test("an untouched draft never overwrites a newer remote value", () => {
  assert.equal(draftStatus({ base: "old", value: "old" }, "new"), "unchanged");
});

test("a locally edited draft conflicts when the remote value changes", () => {
  assert.equal(draftStatus({ base: "old", value: "local" }, "remote"), "conflict");
});

test("a draft can be saved when the remote value has not changed", () => {
  assert.equal(draftStatus({ base: "old", value: "local" }, "old"), "save");
});

test("a draft already matching the remote value needs no save", () => {
  assert.equal(draftStatus({ base: "old", value: "same" }, "same"), "unchanged");
});
