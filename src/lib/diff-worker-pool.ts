import { WorkerPoolManager } from "@pierre/diffs/worker";
import { configureDiffHighlighting } from "./diff-highlighting";

let workerPoolSingleton: WorkerPoolManager | undefined;

/** Returns the shared, persistent WorkerPoolManager singleton for diff and file highlighting. */
export function getDiffWorkerPool(): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return undefined;

  if (!workerPoolSingleton || !workerPoolSingleton.isWorkingPool()) {
    configureDiffHighlighting();

    const poolSize = typeof navigator !== "undefined"
      ? Math.min(Math.max(navigator.hardwareConcurrency || 2, 2), 4)
      : 4;

    workerPoolSingleton = new WorkerPoolManager(
      {
        poolSize,
        workerFactory: () => new Worker(new URL("../workers/diff-highlight.worker.ts", import.meta.url), { type: "module" }),
      },
      {
        theme: "pierre-dark",
        preferredHighlighter: "shiki-wasm",
        useTokenTransformer: true,
        tokenizeMaxLineLength: 5000,
        maxLineDiffLength: 1000,
      },
    );
  }

  return workerPoolSingleton;
}
