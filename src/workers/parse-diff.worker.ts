/// <reference lib="webworker" />

import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles, processFile } from "@pierre/diffs";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import type { RepositoryFile } from "@/types/github";

type ParseRequest = {
  cacheKey: string;
  repository: boolean;
  stream?: ReadableStream<Uint8Array>;
  url: string;
};

type ParseResponse = {
  complete?: boolean;
  error?: string;
  files?: FileDiffMetadata[];
  repositoryFiles?: RepositoryFile[];
};

type ParsedDiffChunk = {
  files: FileDiffMetadata[];
  nextFileIndex: number;
  remainder: string;
};

configureDiffHighlighting();

/** Parses only files that end before the final incomplete Git diff boundary. */
function parseCompleteDiffFiles(patch: string, cacheKey: string, fileIndex: number): ParsedDiffChunk {
  const nextFileStart = patch.lastIndexOf("\ndiff --git ");
  if (nextFileStart === -1) return { files: [], nextFileIndex: fileIndex, remainder: patch };

  const completeFiles = patch.slice(0, nextFileStart).split(/(?=^diff --git )/m);
  const files: FileDiffMetadata[] = [];

  for (const filePatch of completeFiles) {
    if (!filePatch.startsWith("diff --git ")) continue;

    const file = processFile(filePatch, { cacheKey: `${cacheKey}-0-${fileIndex}` });
    if (!file) continue;

    files.push(file);
    fileIndex += 1;
  }

  return { files, nextFileIndex: fileIndex, remainder: patch.slice(nextFileStart + 1) };
}

/** Parses the final Git diff file after the response stream finishes. */
function parseFinalDiffFiles(patch: string, cacheKey: string, fileIndex: number): FileDiffMetadata[] {
  if (!patch.startsWith("diff --git ")) {
    return parsePatchFiles(patch, cacheKey).flatMap((parsedPatch) => parsedPatch.files);
  }

  const file = processFile(patch, { cacheKey: `${cacheKey}-0-${fileIndex}` });
  return file ? [file] : [];
}

/** Reads one patch stream and posts each completed file without blocking the browser thread. */
async function parseDiffStream(stream: ReadableStream<Uint8Array>, cacheKey: string): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let fileIndex = 0;
  let patch = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      patch += decoder.decode(value, { stream: true });
      const parsed = parseCompleteDiffFiles(patch, cacheKey, fileIndex);
      patch = parsed.remainder;
      fileIndex = parsed.nextFileIndex;
      if (parsed.files.length) self.postMessage({ files: parsed.files } satisfies ParseResponse);
    }

    patch += decoder.decode();
    const files = parseFinalDiffFiles(patch, cacheKey, fileIndex);
    self.postMessage({ complete: true, files } satisfies ParseResponse);
  } finally {
    reader.releaseLock();
  }
}

/** Fetches or receives GitHub's patch and parses it away from the interactive browser thread. */
async function parseDiff(event: MessageEvent<ParseRequest>): Promise<void> {
  try {
    if (event.data.repository) {
      const response = await fetch(event.data.url);
      if (!response.ok) {
        // SAFETY: The same-origin diff route returns this documented error envelope.
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "The diff could not be loaded");
      }
      // SAFETY: Repository mode reads the same RepositoryFile array rendered by the main viewer.
      const repositoryFiles = await response.json() as RepositoryFile[];
      self.postMessage({ repositoryFiles } satisfies ParseResponse);
      return;
    }

    if (event.data.stream) {
      await parseDiffStream(event.data.stream, event.data.cacheKey);
      return;
    }

    const response = await fetch(event.data.url);
    if (!response.ok) {
      // SAFETY: The same-origin diff route returns this documented error envelope.
      const body = await response.json() as { error?: string };
      throw new Error(body.error ?? "The diff could not be loaded");
    }

    if (!response.body) {
      const files = parsePatchFiles(await response.text(), event.data.cacheKey).flatMap((parsedPatch) => parsedPatch.files);
      self.postMessage({ complete: true, files } satisfies ParseResponse);
      return;
    }

    await parseDiffStream(response.body, event.data.cacheKey);
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "The diff could not be loaded";
    self.postMessage({ error } satisfies ParseResponse);
  }
}

self.addEventListener("message", parseDiff);
