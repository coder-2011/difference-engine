import type { DiffDocument, PullRequestSummary } from "@/types/github";

const GITHUB_API = "https://api.github.com";

type GitHubUser = {
  avatar_url: string;
  login: string;
};

type SearchPullRequest = {
  closed_at: string | null;
  draft?: boolean;
  number: number;
  repository_url: string;
  title: string;
  updated_at: string;
  user: GitHubUser;
};

type PullRequestStatus = PullRequestSummary["status"];

type PullRequest = {
  additions: number;
  base: { label: string };
  body: string | null;
  changed_files: number;
  deletions: number;
  head: { label: string; sha: string };
  html_url: string;
  title: string;
  updated_at: string;
  user: GitHubUser;
};

type PullRequestFile = {
  filename: string;
  patch?: string;
  previous_filename?: string;
  status: "added" | "changed" | "copied" | "modified" | "removed" | "renamed" | "unchanged";
};

type Compare = {
  ahead_by: number;
  behind_by: number;
  files?: unknown[];
  html_url: string;
  status: string;
};

type Commit = {
  author: GitHubUser | null;
  commit: {
    author: { name: string } | null;
    message: string;
  };
  files?: unknown[];
  html_url: string;
  stats?: { additions: number; deletions: number };
};

type GitBlob = {
  content: string;
  encoding: string;
};

type GitTreeEntry = {
  path: string;
  sha: string;
  size?: number;
  type: "blob" | "commit" | "tree";
};

type GitTree = {
  tree: GitTreeEntry[];
  truncated: boolean;
};

const CONTEXT_TREE_LIMIT = 30_000;
const CONTEXT_DIFF_LIMIT = 50_000;
const CONTEXT_FILES_LIMIT = 70_000;
const CONTEXT_FILE_COUNT = 24;

export class GitHubError extends Error {
  /** Captures a safe HTTP status for a failed GitHub request. */
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Performs a typed, read-only GitHub API request with optional private-repo access. */
async function githubRequest<T>(path: string, token?: string): Promise<T> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${GITHUB_API}${path}`, {
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const fallback = response.status === 404 ? "GitHub item not found" : "GitHub request failed";
    throw new GitHubError(fallback, response.status);
  }

  return response.json() as Promise<T>;
}

/** Returns the most recently updated open pull requests involving the signed-in user. */
export async function listOpenPullRequests(token: string): Promise<PullRequestSummary[]> {
  const query = encodeURIComponent("is:pr is:open involves:@me");
  const items: SearchPullRequest[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const path = `/search/issues?q=${query}&sort=updated&order=desc&per_page=100&page=${page}`;
    const response = await githubRequest<{ items: SearchPullRequest[]; total_count: number }>(path, token);
    items.push(...response.items);
    if (items.length >= response.total_count || response.items.length < 100) break;
  }

  return items.map((pullRequest) => summarizePullRequest(pullRequest, "open"));
}

/** Returns a small, newest-first history of merged and unmerged closed pull requests involving the user. */
export async function listRecentPullRequests(token: string): Promise<PullRequestSummary[]> {
  const queries: Array<[PullRequestStatus, string]> = [
    ["merged", "is:pr is:merged involves:@me"],
    ["closed", "is:pr is:closed is:unmerged involves:@me"],
  ];
  const results = await Promise.all(queries.map(async ([status, query]) => {
    const path = `/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=12`;
    const response = await githubRequest<{ items: SearchPullRequest[] }>(path, token);
    return response.items.map((pullRequest) => summarizePullRequest(pullRequest, status));
  }));

  return results
    .flat()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 12);
}

/** Converts one GitHub search result into the compact shape shared by homepage lists. */
function summarizePullRequest(pullRequest: SearchPullRequest, status: PullRequestStatus): PullRequestSummary {
  const repository = pullRequest.repository_url.split("/repos/")[1];

  return {
    author: pullRequest.user.login,
    avatarUrl: pullRequest.user.avatar_url,
    draft: Boolean(pullRequest.draft),
    number: pullRequest.number,
    repository,
    status,
    title: pullRequest.title,
    updatedAt: pullRequest.closed_at ?? pullRequest.updated_at,
    viewerPath: `/${repository}/pull/${pullRequest.number}`,
  };
}

/** Validates and encodes a GitHub-style viewer path for API requests. */
function parseSource(source: string[]): {
  apiPath: string;
  encodedRepository: string;
  kind: "compare" | "commit" | "pull";
  publicDiffUrl: string;
  repository: string;
  value: string;
} {
  const [owner, repo, kind, value] = source;
  const validKind = kind === "pull" || kind === "compare" || kind === "commit";

  if (source.length !== 4 || !owner || !repo || !value || !validKind) {
    throw new GitHubError("This GitHub URL is not supported", 400);
  }

  const repository = `${owner}/${repo}`;
  const encodedRepository = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const collection = kind === "pull" ? "pulls" : kind === "commit" ? "commits" : "compare";
  const suffix = `${collection}/${encodeURIComponent(value)}`;
  const publicCollection = kind === "pull" ? "pull" : kind;

  return {
    apiPath: `/repos/${encodedRepository}/${suffix}`,
    encodedRepository,
    kind,
    publicDiffUrl: `https://github.com/${repository}/${publicCollection}/${encodeURIComponent(value)}.diff`,
    repository,
    value,
  };
}

/** Resolves the exact repository revision represented by a pull request, comparison, or commit. */
async function getSourceRevision(parsed: ReturnType<typeof parseSource>, token?: string): Promise<string> {
  if (parsed.kind === "pull") {
    const pullRequest = await githubRequest<PullRequest>(`${parsed.apiPath}?context=1`, token);
    return pullRequest.head.sha;
  }

  if (parsed.kind === "compare") {
    return parsed.value.split("...").at(-1) ?? parsed.value;
  }

  return parsed.value;
}

/** Extracts unique destination paths from a standard Git patch. */
function changedPathsFromDiff(diff: string): string[] {
  const paths = Array.from(diff.matchAll(/^\+\+\+ b\/(.+)$/gm), (match) => match[1]);
  return [...new Set(paths)];
}

/** Decodes one textual Git blob while ignoring binary repository content. */
function decodeGitBlob(blob: GitBlob): string {
  if (blob.encoding !== "base64") return "";
  const content = Buffer.from(blob.content.replaceAll("\n", ""), "base64").toString("utf8");
  return content.includes("\0") ? "" : content;
}

/** Builds bounded repository-wide context around the exact revision being reviewed. */
export async function getRepositoryContext(source: string[], token?: string): Promise<string> {
  const parsed = parseSource(source);
  const revision = await getSourceRevision(parsed, token);
  const encodedRevision = encodeURIComponent(revision);
  const [tree, diff] = await Promise.all([
    githubRequest<GitTree>(`/repos/${parsed.encodedRepository}/git/trees/${encodedRevision}?recursive=1`, token),
    getDiffResponse(source, token).then((response) => response.text()),
  ]);
  const blobs = tree.tree.filter((entry) => entry.type === "blob");
  const blobByPath = new Map(blobs.map((entry) => [entry.path, entry]));
  const rootFiles = ["AGENTS.md", "README.md", "package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml"];
  const preferredPaths = [...changedPathsFromDiff(diff), ...rootFiles];
  const entries = [...new Set(preferredPaths)]
    .map((path) => blobByPath.get(path))
    .filter((entry): entry is GitTreeEntry => Boolean(entry && (entry.size ?? 0) <= CONTEXT_FILES_LIMIT))
    .slice(0, CONTEXT_FILE_COUNT);

  const contents = await Promise.all(entries.map(async (entry) => {
    const blob = await githubRequest<GitBlob>(`/repos/${parsed.encodedRepository}/git/blobs/${entry.sha}`, token);
    return { path: entry.path, text: decodeGitBlob(blob) };
  }));
  let fileContext = "";

  // Changed files come first, and the shared budget prevents oversized model requests.
  for (const file of contents) {
    const remaining = CONTEXT_FILES_LIMIT - fileContext.length;
    if (!file.text || remaining <= 0) break;
    fileContext += `\n### ${file.path}\n${file.text.slice(0, remaining)}\n`;
  }

  const treeText = blobs.map((entry) => entry.path).join("\n").slice(0, CONTEXT_TREE_LIMIT);
  const truncation = tree.truncated ? "\n(GitHub truncated this unusually large tree.)" : "";
  return [
    `Repository: ${parsed.repository}`,
    `Revision: ${revision}`,
    `Repository tree:\n${treeText}${truncation}`,
    `Changed and root file contents:${fileContext || "\nNo textual files were available."}`,
    `Full change diff:\n${diff.slice(0, CONTEXT_DIFF_LIMIT)}`,
  ].join("\n\n");
}

/** Loads the title, description, author, and change totals shown above a diff. */
export async function getDiffDocument(source: string[], token?: string): Promise<DiffDocument> {
  const parsed = parseSource(source);

  if (parsed.kind === "pull") {
    const pullRequest = await githubRequest<PullRequest>(parsed.apiPath, token);

    return {
      additions: pullRequest.additions,
      author: pullRequest.user.login,
      avatarUrl: pullRequest.user.avatar_url,
      baseLabel: pullRequest.base.label,
      changedFiles: pullRequest.changed_files,
      deletions: pullRequest.deletions,
      description: pullRequest.body ?? undefined,
      headLabel: pullRequest.head.label,
      repository: parsed.repository,
      sourceUrl: pullRequest.html_url,
      title: pullRequest.title,
      updatedAt: pullRequest.updated_at,
    };
  }

  if (parsed.kind === "compare") {
    const comparison = await githubRequest<Compare>(parsed.apiPath, token);
    const [baseLabel, headLabel] = parsed.value.split("...");

    return {
      author: parsed.repository.split("/")[0],
      avatarUrl: `https://github.com/${parsed.repository.split("/")[0]}.png`,
      baseLabel,
      changedFiles: comparison.files?.length,
      description: `${comparison.ahead_by} commits ahead and ${comparison.behind_by} behind · ${comparison.status}`,
      headLabel,
      repository: parsed.repository,
      sourceUrl: comparison.html_url,
      title: `${baseLabel}…${headLabel}`,
    };
  }

  const commit = await githubRequest<Commit>(parsed.apiPath, token);
  const author = commit.author?.login ?? commit.commit.author?.name ?? "Unknown author";
  const [title, ...description] = commit.commit.message.split("\n");

  return {
    additions: commit.stats?.additions,
    author,
    avatarUrl: commit.author?.avatar_url ?? "",
    changedFiles: commit.files?.length,
    deletions: commit.stats?.deletions,
    description: description.join("\n").trim() || undefined,
    repository: parsed.repository,
    sourceUrl: commit.html_url,
    title,
  };
}

/** Streams the raw GitHub diff so large comparisons are not serialized through React. */
export async function getDiffResponse(source: string[], token?: string): Promise<Response> {
  const parsed = parseSource(source);
  const headers: HeadersInit = { Accept: "application/vnd.github.diff" };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${GITHUB_API}${parsed.apiPath}`, {
    headers,
    cache: "no-store",
  });

  if (response.ok && response.body) {
    return new Response(response.body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      status: 200,
    });
  }

  // GitHub's REST media type rejects public diffs above 300 files, while its
  // streaming web endpoint still serves them in full.
  if (response.status === 406) {
    const publicResponse = await fetch(parsed.publicDiffUrl, {
      cache: "no-store",
      redirect: "follow",
    });
    const contentType = publicResponse.headers.get("content-type") ?? "";

    if (publicResponse.ok && publicResponse.body && contentType.startsWith("text/plain")) {
      return new Response(publicResponse.body, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        status: 200,
      });
    }

    if (parsed.kind === "pull" && token) {
      const largePrivateDiff = await getLargePullRequestDiff(parsed.apiPath, token);
      return new Response(largePrivateDiff, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        status: 200,
      });
    }
  }

  throw new GitHubError("The diff could not be loaded", response.status);
}

/** Reconstructs an oversized private PR from GitHub's paginated file patches. */
async function getLargePullRequestDiff(apiPath: string, token: string): Promise<string> {
  const files: PullRequestFile[] = [];

  for (let page = 1; page <= 30; page += 1) {
    const batch = await githubRequest<PullRequestFile[]>(`${apiPath}/files?per_page=100&page=${page}`, token);
    files.push(...batch);
    if (batch.length < 100) break;
  }

  return files.map(formatPullRequestFile).join("\n");
}

/** Wraps one GitHub file patch in the headers expected by standard diff parsers. */
function formatPullRequestFile(file: PullRequestFile): string {
  const previousName = file.previous_filename ?? file.filename;
  const oldPath = file.status === "added" ? "/dev/null" : `a/${previousName}`;
  const newPath = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
  const metadata = file.status === "renamed"
    ? `similarity index 100%\nrename from ${previousName}\nrename to ${file.filename}`
    : "";
  const body = file.patch ?? `Binary files ${oldPath} and ${newPath} differ`;

  return [
    `diff --git a/${previousName} b/${file.filename}`,
    metadata,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    body,
    "",
  ].filter(Boolean).join("\n");
}

/** Converts a supported GitHub URL into this app's equivalent viewer path. */
export function viewerPathFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const source = url.pathname.replace(/\.(diff|patch)$/, "").split("/").filter(Boolean);

    if (url.hostname !== "github.com") {
      return null;
    }

    parseSource(source);
    return `/${source.join("/")}`;
  } catch {
    return null;
  }
}
