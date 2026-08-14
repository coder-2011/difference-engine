import assert from "node:assert/strict";
import { areOptionsEqual } from "../src/vendor/pierre-diffs/dist/utils/areOptionsEqual.js";
import { parsePatchFiles } from "../src/vendor/pierre-diffs/dist/utils/parsePatchFiles.js";

const PARSER_SAMPLES = 15;
const PARSER_ITERATIONS = 4;
const OPTION_SAMPLES = 17;
const OPTION_ITERATIONS = 300_000;

/** Builds a repeatable multi-file review patch without timing fixture generation. */
function createPatch(fileCount, hunkCount, changesPerHunk) {
  const files = [];

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const hunks = [];
    let line = 1;

    for (let hunkIndex = 0; hunkIndex < hunkCount; hunkIndex++) {
      const body = [" context before"];

      for (let changeIndex = 0; changeIndex < changesPerHunk; changeIndex++) {
        body.push(`-const value_${fileIndex}_${hunkIndex}_${changeIndex} = ${changeIndex};`);
        body.push(`+const value_${fileIndex}_${hunkIndex}_${changeIndex} = ${changeIndex + 1};`);
      }

      body.push(" context after");
      const count = changesPerHunk + 2;
      hunks.push(`@@ -${line},${count} +${line},${count} @@\n${body.join("\n")}`);
      line += count + 3;
    }

    files.push([
      `diff --git a/src/file-${fileIndex}.ts b/src/file-${fileIndex}.ts`,
      "index 1111111..2222222 100644",
      `--- a/src/file-${fileIndex}.ts`,
      `+++ b/src/file-${fileIndex}.ts`,
      ...hunks,
    ].join("\n"));
  }

  return files.join("\n");
}

/** Returns the middle sample so one noisy run cannot define the result. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Measures one synchronous operation in milliseconds while consuming its result. */
function measure(operation, iterations) {
  const start = performance.now();
  let result;

  for (let iteration = 0; iteration < iterations; iteration++) result = operation();

  return { milliseconds: (performance.now() - start) / iterations, result };
}

/** Benchmarks Pierre's worker-side patch parser on a large, repeatable review. */
function benchmarkParser(patch) {
  for (let warmup = 0; warmup < 12; warmup++) parsePatchFiles(patch, "warmup", true);

  const samples = [];
  let files = 0;

  for (let sample = 0; sample < PARSER_SAMPLES; sample++) {
    const measured = measure(() => parsePatchFiles(patch, "benchmark", true), PARSER_ITERATIONS);
    files = measured.result[0].files.length;
    samples.push(measured.milliseconds);
  }

  return { files, medianMilliseconds: median(samples) };
}

/** Benchmarks the stable-options fast path used by React CodeView commits. */
function benchmarkStableOptions(options) {
  for (let warmup = 0; warmup < 5; warmup++) measure(() => areOptionsEqual(options, options), OPTION_ITERATIONS);

  const samples = [];

  for (let sample = 0; sample < OPTION_SAMPLES; sample++) {
    const measured = measure(() => areOptionsEqual(options, options), OPTION_ITERATIONS);
    assert.equal(measured.result, true);
    samples.push(measured.milliseconds);
  }

  return { medianMilliseconds: median(samples) };
}

const patch = createPatch(48, 6, 4);
const options = {
  diffStyle: "split",
  hunkSeparators: "line-info",
  lineDiffType: "word-alt",
  preferredHighlighter: "shiki-wasm",
  theme: "pierre-dark",
};
const parser = benchmarkParser(patch);
const stableOptions = benchmarkStableOptions(options);

console.log(JSON.stringify({
  node: process.version,
  parser: {
    bytes: patch.length,
    files: parser.files,
    medianMilliseconds: Number(parser.medianMilliseconds.toFixed(3)),
  },
  stableOptions: {
    iterations: OPTION_ITERATIONS,
    medianMilliseconds: Number(stableOptions.medianMilliseconds.toFixed(6)),
  },
}, null, 2));
