/// <reference lib="webworker" />

import type {
  DiffsHighlighter,
  FileContents,
  FileDiffMetadata,
  RenderDiffOptions,
  RenderFileOptions,
  ThemeRegistrationResolved,
} from "@pierre/diffs";
import {
  attachResolvedLanguages,
  attachResolvedThemes,
  renderDiffWithHighlighter,
  renderFileWithHighlighter,
  replaceCustomExtensions,
} from "@pierre/diffs";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";

configureDiffHighlighting();

type InitializeRequest = {
  customExtensionMap?: Record<string, string>;
  customExtensionsVersion?: number;
  id: string;
  preferredHighlighter?: string;
  renderOptions: RenderDiffOptions;
  resolvedLanguages?: Array<{ data: unknown; name: string }>;
  resolvedThemes: ThemeRegistrationResolved[];
  type: "initialize";
};

type SetRenderOptionsRequest = {
  id: string;
  renderOptions: RenderDiffOptions;
  resolvedThemes: ThemeRegistrationResolved[];
  type: "set-render-options";
};

type RenderFileRequest = {
  customExtensionMap?: Record<string, string>;
  customExtensionsVersion?: number;
  file: FileContents;
  id: string;
  resolvedLanguages?: Array<{ data: unknown; name: string }>;
  type: "file";
};

type RenderDiffRequest = {
  customExtensionMap?: Record<string, string>;
  customExtensionsVersion?: number;
  diff: FileDiffMetadata;
  id: string;
  resolvedLanguages?: Array<{ data: unknown; name: string }>;
  type: "diff";
};

type WorkerRequest = InitializeRequest | SetRenderOptionsRequest | RenderFileRequest | RenderDiffRequest;

let highlighterPromise: Promise<DiffsHighlighter> | undefined;
let renderOptions: RenderDiffOptions = {
  lineDiffType: "word-alt",
  maxLineDiffLength: 1000,
  theme: "pierre-dark",
  tokenizeMaxLineLength: 5000,
  useTokenTransformer: true,
};

async function getHighlighter(): Promise<DiffsHighlighter> {
  if (!highlighterPromise) {
    // SAFETY: createHighlighterCore returns a Shiki instance structurally compatible with DiffsHighlighter.
    highlighterPromise = createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      langs: [],
      themes: [],
    }) as Promise<DiffsHighlighter>;
  }
  return highlighterPromise;
}

function syncCustomExtensions(version?: number, map?: Record<string, string>) {
  if (version != null && map != null) {
    replaceCustomExtensions(version, map);
  }
}

async function handleInitialize(request: InitializeRequest) {
  const highlighter = await getHighlighter();
  syncCustomExtensions(request.customExtensionsVersion, request.customExtensionMap);
  attachResolvedThemes(request.resolvedThemes, highlighter);
  if (request.resolvedLanguages) {
    attachResolvedLanguages(request.resolvedLanguages, highlighter);
  }
  renderOptions = request.renderOptions;
  self.postMessage({
    id: request.id,
    requestType: "initialize",
    sentAt: Date.now(),
    type: "success",
  });
}

async function handleSetRenderOptions(request: SetRenderOptionsRequest) {
  const highlighter = await getHighlighter();
  attachResolvedThemes(request.resolvedThemes, highlighter);
  renderOptions = request.renderOptions;
  self.postMessage({
    id: request.id,
    requestType: "set-render-options",
    sentAt: Date.now(),
    type: "success",
  });
}

async function handleRenderFile(request: RenderFileRequest) {
  const highlighter = await getHighlighter();
  syncCustomExtensions(request.customExtensionsVersion, request.customExtensionMap);
  if (request.resolvedLanguages) {
    attachResolvedLanguages(request.resolvedLanguages, highlighter);
  }
  const fileOptions: RenderFileOptions = {
    theme: renderOptions.theme,
    tokenizeMaxLineLength: renderOptions.tokenizeMaxLineLength,
    useTokenTransformer: renderOptions.useTokenTransformer,
  };
  const result = renderFileWithHighlighter(request.file, highlighter, fileOptions);
  self.postMessage({
    id: request.id,
    options: fileOptions,
    requestType: "file",
    result,
    sentAt: Date.now(),
    type: "success",
  });
}

async function handleRenderDiff(request: RenderDiffRequest) {
  const highlighter = await getHighlighter();
  syncCustomExtensions(request.customExtensionsVersion, request.customExtensionMap);
  if (request.resolvedLanguages) {
    attachResolvedLanguages(request.resolvedLanguages, highlighter);
  }
  const result = renderDiffWithHighlighter(request.diff, highlighter, renderOptions);
  self.postMessage({
    id: request.id,
    options: renderOptions,
    requestType: "diff",
    result,
    sentAt: Date.now(),
    type: "success",
  });
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const promise = (() => {
    switch (request.type) {
      case "initialize":
        return handleInitialize(request);
      case "set-render-options":
        return handleSetRenderOptions(request);
      case "file":
        return handleRenderFile(request);
      case "diff":
        return handleRenderDiff(request);
      default:
        // SAFETY: Type assertion is unreachable for valid WorkerRequest types.
        throw new Error(`Unknown request type: ${(request as { type: string }).type}`);
    }
  })();

  promise.catch((error: Error | { message?: string; stack?: string }) => {
    self.postMessage({
      error: error instanceof Error ? error.message : (error.message ?? String(error)),
      id: request.id,
      stack: error instanceof Error ? error.stack : error.stack,
      type: "error",
    });
  });
});
