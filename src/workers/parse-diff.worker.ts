/// <reference lib="webworker" />

import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import type { RepositoryFile } from "@/types/github";

type ParseRequest = {
  cacheKey: string;
  repository: boolean;
  url: string;
};

type ParseResponse = {
  error?: string;
  files?: FileDiffMetadata[];
  repositoryFiles?: RepositoryFile[];
};

configureDiffHighlighting();

/** Fetches and parses a full patch away from the interactive browser thread. */
async function parseDiff(event: MessageEvent<ParseRequest>): Promise<void> {
  try {
    const response = await fetch(event.data.url);

    if (!response.ok) {
      const body = await response.json() as { error?: string };
      throw new Error(body.error ?? "The diff could not be loaded");
    }

    if (event.data.repository) {
      const repositoryFiles = await response.json() as RepositoryFile[];
      self.postMessage({ repositoryFiles } satisfies ParseResponse);
      return;
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
