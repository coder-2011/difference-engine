/// <reference lib="webworker" />

import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";

type ParseRequest = {
  cacheKey: string;
  url: string;
};

type ParseResponse = {
  error?: string;
  files?: FileDiffMetadata[];
};

/** Fetches and parses a full patch away from the interactive browser thread. */
async function parseDiff(event: MessageEvent<ParseRequest>): Promise<void> {
  try {
    const response = await fetch(event.data.url);

    if (!response.ok) {
      const body = await response.json() as { error?: string };
      throw new Error(body.error ?? "The diff could not be loaded");
    }

    const patch = await response.text();
    const files = parsePatchFiles(patch, event.data.cacheKey).flatMap((parsedPatch) => parsedPatch.files);
    self.postMessage({ files } satisfies ParseResponse);
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "The diff could not be loaded";
    self.postMessage({ error } satisfies ParseResponse);
  }
}

self.addEventListener("message", parseDiff);
