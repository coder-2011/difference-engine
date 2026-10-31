export type PreloadedDiff = { stream: ReadableStream<Uint8Array>; revision: string };

type DiffPreload = {
  controller: AbortController;
  endpoint: string;
  stream: Promise<PreloadedDiff | null>;
  timer: number;
};

const DIFF_PRELOAD_TIMEOUT = 15_000;
let activePreload: DiffPreload | undefined;

/** Converts a dashboard PR path into the same encoded diff endpoint used by the viewer. */
function pullRequestDiffEndpoint(viewerPath: string): string {
  const path = viewerPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/diff/${path}`;
}

/** Converts parsed route segments into the same encoded diff endpoint used by the viewer. */
function sourceDiffEndpoint(source: string[]): string {
  return `/api/diff/${source.map(encodeURIComponent).join("/")}`;
}

/** Aborts and forgets one speculative response before it can retain another PR's stream. */
function discardPreload(preload: DiffPreload): void {
  window.clearTimeout(preload.timer);
  if (activePreload === preload) activePreload = undefined;
  preload.controller.abort();
  void preload.stream.then((result) => result?.stream.cancel()).catch(() => {});
}

/** Starts a single bounded diff request that can be transferred to the parsing worker after navigation. */
export function preloadPullRequestDiff(viewerPath: string): void {
  const endpoint = pullRequestDiffEndpoint(viewerPath);
  if (activePreload?.endpoint === endpoint) return;
  if (activePreload) discardPreload(activePreload);

  const controller = new AbortController();
  const stream = fetch(`${endpoint}?preload=1`, { signal: controller.signal })
    .then((response) => {
      const revision = response.headers.get("x-diff-revision");
      if (!controller.signal.aborted && response.ok && response.body && revision) return { stream: response.body, revision };
      void response.body?.cancel().catch(() => {});
      return null;
    })
    .catch(() => null);
  const preload: DiffPreload = { controller, endpoint, stream, timer: 0 };
  preload.timer = window.setTimeout(() => discardPreload(preload), DIFF_PRELOAD_TIMEOUT);
  activePreload = preload;

  // Failed preloads have no useful stream to hand to the viewer.
  void stream.then((response) => {
    if (!response && activePreload === preload) discardPreload(preload);
  });
}

/** Cancels a hover request only when it still belongs to the card that was left. */
export function cancelPullRequestDiffPreload(viewerPath: string): void {
  const endpoint = pullRequestDiffEndpoint(viewerPath);
  if (activePreload?.endpoint === endpoint) discardPreload(activePreload);
}

/** Gives the destination worker the one matching hovered response and clears its short-lived cache slot. */
export function takePreloadedDiff(source: string[]): Promise<PreloadedDiff | null> | null {
  const preload = activePreload;
  if (!preload || preload.endpoint !== sourceDiffEndpoint(source)) return null;

  activePreload = undefined;
  return preload.stream.then((result) => {
    window.clearTimeout(preload.timer);
    if (!preload.controller.signal.aborted) return result;
    void result?.stream.cancel().catch(() => {});
    return null;
  });
}
