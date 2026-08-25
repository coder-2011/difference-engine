type DiffPreload = {
  controller: AbortController;
  endpoint: string;
  stream: Promise<ReadableStream<Uint8Array> | null>;
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
}

/** Starts a single bounded diff request that can be transferred to the parsing worker after navigation. */
export function preloadPullRequestDiff(viewerPath: string): void {
  const endpoint = pullRequestDiffEndpoint(viewerPath);
  if (activePreload?.endpoint === endpoint) return;
  if (activePreload) discardPreload(activePreload);

  const controller = new AbortController();
  const stream = fetch(endpoint, { cache: "no-store", signal: controller.signal })
    .then((response) => {
      if (response.ok && response.body) return response.body;
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
export function takePreloadedDiff(source: string[]): Promise<ReadableStream<Uint8Array> | null> | null {
  const preload = activePreload;
  if (!preload || preload.endpoint !== sourceDiffEndpoint(source)) return null;

  window.clearTimeout(preload.timer);
  activePreload = undefined;
  return preload.stream;
}
