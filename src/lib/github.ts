import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { CALL_DIFF_ANONYMOUS_FILE_LIMIT, CALL_DIFF_FILE_LIMIT, CALL_DIFF_FILE_SIZE_LIMIT, isCallDiffSourcePath } from "@/lib/call-diff-files";
import { isRecord, isString, type JsonRecord, type JsonValue } from "@/lib/json";
import { extract } from "tar-stream";
import type {
  DiffDocument,
  PullRequestAction,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeMethod,
  PullRequestReviewThread,
  PullRequestSummary,
  PullRequestTimelineEvent,
  PullRequestWorkflowRun,
  PullRequestWorkspace,
  RepositoryFile,
} from "@/types/github";

const GITHUB_API = "https://api.github.com";

type GitHubUser = {
  avatar_url: string;
  login: string;
};

type SearchPullRequest = {
  additions: number;
  author: { avatarUrl: string; login: string } | null;
  closedAt: string | null;
  deletions: number;
  isDraft: boolean;
  number: number;
  repository: { nameWithOwner: string };
  title: string;
  updatedAt: string;
};

type PullRequestSearch = {
  search: {
    nodes: SearchPullRequest[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

type PullRequestStatus = PullRequestSummary["status"];

type ParsedSource = {
  apiPath: string;
  encodedRepository: string;
  filePath?: string;
  kind: "compare" | "commit" | "pull" | "repository";
  repository: string;
  repositoryRef?: string;
  value: string;
};

type CallDiffFileSelection = {
  files: PullRequestFile[];
  ignoredFiles: number;
  truncated: boolean;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: JsonValue[];
};

type GitHubRequestBody = Record<string, JsonValue | undefined>;

type PullRequestConversation = {
  comments: PullRequestComment[];
  reviewThreads: PullRequestReviewThread[];
  unavailable: boolean;
};

type PullRequestCommitList = {
  commits: PullRequestCommit[];
  unavailable: boolean;
};

type PullRequestTimeline = {
  events: PullRequestTimelineEvent[];
  unavailable: boolean;
};

type PullRequest = {
  additions: number;
  base: { label: string; sha: string };
  body: string | null;
  changed_files: number;
  draft: boolean;
  deletions: number;
  head: { label: string; ref: string; sha: string };
  html_url: string;
  locked: boolean;
  merge_commit_sha: string | null;
  merged: boolean;
  mergeable: boolean | null;
  number: number;
  state: "closed" | "open";
  title: string;
  user: GitHubUser;
};

type IssueComment = {
  body: string;
  created_at: string;
  id: number;
  updated_at: string;
  user: GitHubUser;
};

type PullRequestReview = {
  body: string;
  id: number;
  state: string;
  submitted_at: string | null;
  user: GitHubUser;
};

type PullRequestReviewComment = {
  body: string;
  created_at: string;
  diff_hunk?: string;
  html_url: string;
  id: number;
  in_reply_to_id: number | null;
  line: number | null;
  original_line: number | null;
  original_start_line: number | null;
  path: string;
  pull_request_review_id: number | null;
  side: "LEFT" | "RIGHT" | null;
  start_line: number | null;
  updated_at: string;
  user: GitHubUser;
};

type PullRequestReviewThreadMetadata = {
  comments: { nodes: Array<{ url: string }> };
  id: string;
  isOutdated: boolean;
  isResolved: boolean;
  resolvedBy: { login: string } | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
};

type PullRequestReviewThreadConnection = {
  nodes: PullRequestReviewThreadMetadata[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
};

type PullRequestReviewThreadQuery = {
  repository: {
    pullRequest: {
      reviewThreads: PullRequestReviewThreadConnection;
    } | null;
  } | null;
};

type PullRequestReviewThreadNodeQuery = {
  node: {
    pullRequest: {
      number: number;
      repository: { nameWithOwner: string };
    };
  } | null;
};

type GitHubTimelineEvent = {
  actor: GitHubUser | null;
  assignee?: GitHubUser | null;
  created_at: string | null;
  event: string;
  id: number | null;
  label?: { name: string } | null;
  requested_reviewer?: GitHubUser | null;
};

type PullRequestCommitRecord = {
  author: GitHubUser | null;
  commit: {
    author: { name: string } | null;
    message: string;
  };
  sha: string;
};

type WorkflowRun = {
  conclusion: string | null;
  created_at: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  id: number;
  name: string;
  pull_requests?: Array<{ number: number }>;
  status: string;
};

type WorkflowRuns = {
  workflow_runs: WorkflowRun[];
};

type PullRequestCapabilities = {
  mergeMethods: PullRequestMergeMethod[];
  mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
  pullRequestId: string;
  viewerCanClose: boolean;
  viewerCanUpdate: boolean;
  viewerCanWrite: boolean;
};

type PullRequestCapabilityQuery = {
  repository: {
    mergeCommitAllowed: boolean;
    pullRequest: {
      id: string;
      mergeStateStatus: PullRequestCapabilities["mergeStateStatus"];
      viewerCanClose: boolean;
      viewerCanUpdate: boolean;
    } | null;
    rebaseMergeAllowed: boolean;
    squashMergeAllowed: boolean;
    viewerPermission: "ADMIN" | "MAINTAIN" | "READ" | "TRIAGE" | "WRITE" | null;
  } | null;
};

type PullRequestMergeResult = {
  merged: boolean;
  message: string;
};

type PullRequestAgentComment =
  | { body: string; type: "general" }
  | {
      body: string;
      line: number;
      path: string;
      side: "LEFT" | "RIGHT";
      startLine?: number;
      startSide?: "LEFT" | "RIGHT";
      type: "line";
    };

type PullRequestAgentCommentResult = {
  line?: number;
  path?: string;
  side?: "LEFT" | "RIGHT";
  type: PullRequestAgentComment["type"];
  url: string;
};

type PullRequestFile = {
  additions?: number;
  deletions?: number;
  filename: string;
  patch?: string;
  previous_filename?: string;
  status: "added" | "changed" | "copied" | "modified" | "removed" | "renamed" | "unchanged";
};

type Compare = {
  ahead_by: number;
  behind_by: number;
  files?: PullRequestFile[];
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
  sha: string;
  stats?: { additions: number; deletions: number };
};

type Repository = {
  default_branch: string;
  description: string | null;
  html_url: string;
  name: string;
  owner: GitHubUser;
};

type GitBlob = {
  content: string;
  encoding: string;
};

export type CallDiffSource = {
  files: Array<{
    additions: number;
    after?: { path: string; text: string };
    before?: { path: string; text: string };
    deletions: number;
    key: string;
  }>;
  fromRef: string;
  ignoredFiles: number;
  toRef: string;
  truncated: boolean;
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

type RepositorySnapshot = {
  encodedRepository: string;
  revision: string;
  tree: GitTree;
};

export type RepositoryContext = {
  snapshot: RepositorySnapshot;
  text: string;
};

const CONTEXT_TREE_LIMIT = 30_000;
const CONTEXT_DIFF_LIMIT = 50_000;
const CONTEXT_FILES_LIMIT = 70_000;
const CONTEXT_FILE_COUNT = 24;
const TOOL_FILE_COUNT = 8;
const TOOL_FILES_LIMIT = 48_000;
const REPOSITORY_DATA_EXTENSIONS = new Set(["csv", "done", "jsonl", "log", "sha256"]);

export class GitHubError extends Error {
  /** Captures a safe HTTP status for a failed GitHub request. */
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Builds the shared media and optional authorization headers for GitHub requests. */
function githubHeaders(accept: string, token?: string): Headers {
  const headers = new Headers({ Accept: accept });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/** Extracts GitHub's safe response message without exposing a raw failed response. */
async function githubError(response: Response): Promise<GitHubError> {
  const body = await response.json().catch(() => null);
  const fallback = response.status === 404 ? "GitHub item not found" : "GitHub request failed";
  const message = isRecord(body) && isString(body.message) ? body.message : fallback;
  return new GitHubError(message, response.status);
}

/** Performs one GitHub API request while keeping the authenticated token on the server. */
async function githubResponse(path: string, token?: string, method = "GET", body?: GitHubRequestBody): Promise<Response> {
  const headers = githubHeaders("application/vnd.github+json", token);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (body !== undefined) headers.set("Content-Type", "application/json");

  const init = {
    cache: "no-store" as const,
    headers,
    method,
  };
  const response = body === undefined
    ? await fetch(`${GITHUB_API}${path}`, init)
    : await fetch(`${GITHUB_API}${path}`, { ...init, body: JSON.stringify(body) });

  if (!response.ok) throw await githubError(response);

  return response;
}

/** Performs a typed GitHub API request with optional private-repository access. */
async function githubRequest<T>(path: string, token?: string): Promise<T> {
  const response = await githubResponse(path, token);

  // SAFETY: Each caller supplies the response type for its fixed GitHub endpoint.
  return response.json() as Promise<T>;
}

/** Confirms GitHub authentication while treating temporary API failures as an unknown, not a logout. */
export async function isGitHubConnected(token?: string): Promise<boolean> {
  if (!token) return false;

  try {
    await githubResponse("/user", token);
    return true;
  } catch (error) {
    return !(error instanceof GitHubError && error.status === 401);
  }
}

/** Reads every page in a GitHub conversation collection so older discussion is not silently omitted. */
async function githubAllItems<T>(path: string, token?: string): Promise<T[]> {
  const items: T[] = [];
  let nextPath: string | undefined = path;

  while (nextPath) {
    const response = await githubResponse(nextPath, token);
    // SAFETY: This helper is used only with the collection type documented by its GitHub endpoint.
    const page = await response.json() as T[];
    items.push(...page);
    const nextUrl = response.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];

    if (!nextUrl) break;

    const url = new URL(nextUrl, GITHUB_API);
    nextPath = `${url.pathname}${url.search}`;
  }

  return items;
}

/** Sends one GitHub mutation whose successful response body is not needed locally. */
async function githubMutation(path: string, token: string, method: "PATCH" | "POST", body?: GitHubRequestBody): Promise<void> {
  await githubResponse(path, token, method, body);
}

/** Queries the small viewer-specific capability set that REST does not return. */
async function githubGraphql<T>(token: string, query: string, variables: JsonRecord): Promise<T> {
  const headers = githubHeaders("application/vnd.github+json", token);
  headers.set("Content-Type", "application/json");
  const response = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!response.ok) throw await githubError(response);
  // SAFETY: The typed query and its selected fields define the expected GraphQL data shape.
  const result = await response.json() as GraphqlResponse<T>;
  if (!result.data || result.errors?.length) throw new GitHubError("GitHub request failed", 502);
  return result.data;
}

/** Searches pull requests with the card-level change totals unavailable from GitHub's REST search. */
async function searchPullRequests(token: string, query: string, limit = 1_000): Promise<SearchPullRequest[]> {
  const pullRequests: SearchPullRequest[] = [];
  let cursor: string | null = null;

  while (pullRequests.length < limit) {
    const first = Math.min(100, limit - pullRequests.length);
    const headers = githubHeaders("application/vnd.github+json", token);
    headers.set("Content-Type", "application/json");
    const response = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `query PullRequests($query: String!, $first: Int!, $after: String) {
          search(query: $query, type: ISSUE, first: $first, after: $after) {
            pageInfo { endCursor hasNextPage }
            nodes {
              ... on PullRequest {
                additions
                author { avatarUrl login }
                closedAt
                deletions
                isDraft
                number
                repository { nameWithOwner }
                title
                updatedAt
              }
            }
          }
        }`,
        variables: { after: cursor, first, query },
      }),
      cache: "no-store",
    });

    if (!response.ok) throw new GitHubError("GitHub request failed", response.status);
    // SAFETY: The static search query requests exactly the PullRequestSearch fields consumed below.
    const result = await response.json() as GraphqlResponse<PullRequestSearch>;
    if (!result.data || result.errors?.length) throw new GitHubError("GitHub request failed", 502);

    pullRequests.push(...result.data.search.nodes);
    cursor = result.data.search.pageInfo.endCursor;
    if (!result.data.search.pageInfo.hasNextPage || !cursor) break;
  }

  return pullRequests;
}

/** Returns the most recently updated open pull requests involving the signed-in user. */
export async function listOpenPullRequests(token: string): Promise<PullRequestSummary[]> {
  const pullRequests = await searchPullRequests(token, "is:pr is:open involves:@me sort:updated-desc");
  return pullRequests.map((pullRequest) => summarizePullRequest(pullRequest, "open"));
}

/** Returns a small, newest-first history of merged and unmerged closed pull requests involving the user. */
export async function listRecentPullRequests(token: string): Promise<PullRequestSummary[]> {
  const queries: Array<[PullRequestStatus, string]> = [
    ["merged", "is:pr is:merged involves:@me"],
    ["closed", "is:pr is:closed is:unmerged involves:@me"],
  ];
  const results = await Promise.all(queries.map(async ([status, query]) => {
    const pullRequests = await searchPullRequests(token, `${query} sort:updated-desc`, 12);
    return pullRequests.map((pullRequest) => summarizePullRequest(pullRequest, status));
  }));

  return results
    .flat()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 12);
}

/** Converts one GitHub search result into the compact shape shared by homepage lists. */
function summarizePullRequest(pullRequest: SearchPullRequest, status: PullRequestStatus): PullRequestSummary {
  const repository = pullRequest.repository.nameWithOwner;

  return {
    additions: pullRequest.additions,
    author: pullRequest.author?.login ?? "ghost",
    avatarUrl: pullRequest.author?.avatarUrl ?? "https://github.com/ghost.png",
    deletions: pullRequest.deletions,
    draft: pullRequest.isDraft,
    number: pullRequest.number,
    repository,
    status,
    title: pullRequest.title,
    updatedAt: pullRequest.closedAt ?? pullRequest.updatedAt,
    viewerPath: `/${repository}/pull/${pullRequest.number}`,
  };
}

/** Validates and encodes a GitHub-style viewer path for API requests. */
function parseSource(source: string[]): ParsedSource {
  const [owner, repo, kind, value, ...filePath] = source;
  const parsedKind = kind === "pull" || kind === "compare" || kind === "commit" ? kind : undefined;

  if (!owner || !repo) throw new GitHubError("This GitHub URL is not supported", 400);

  const repository = `${owner}/${repo}`;
  const encodedRepository = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  if (source.length === 2) {
    return {
      apiPath: `/repos/${encodedRepository}`,
      encodedRepository,
      kind: "repository",
      repository,
      value: "",
    };
  }
  if (kind === "blob" && value && filePath.length) {
    return {
      apiPath: `/repos/${encodedRepository}`,
      encodedRepository,
      filePath: filePath.join("/"),
      kind: "repository",
      repository,
      repositoryRef: value,
      value: "",
    };
  }
  if (kind === "tree") {
    const repositoryRef = source.slice(3).join("/");
    if (!repositoryRef) throw new GitHubError("This GitHub URL is not supported", 400);

    return {
      apiPath: `/repos/${encodedRepository}`,
      encodedRepository,
      kind: "repository",
      repository,
      repositoryRef,
      value: "",
    };
  }
  // A trailing path without GitHub's /blob/<ref> prefix targets the default branch.
  if (!parsedKind && source.length > 2) {
    return {
      apiPath: `/repos/${encodedRepository}`,
      encodedRepository,
      filePath: source.slice(2).join("/"),
      kind: "repository",
      repository,
      value: "",
    };
  }
  if (source.length !== 4 || !value || !parsedKind) {
    throw new GitHubError("This GitHub URL is not supported", 400);
  }

  const collection = parsedKind === "pull" ? "pulls" : parsedKind === "commit" ? "commits" : "compare";

  return {
    apiPath: `/repos/${encodedRepository}/${collection}/${encodeURIComponent(value)}`,
    encodedRepository,
    kind: parsedKind,
    repository,
    value,
  };
}

/** Restricts collaboration features to a real pull-request source. */
function pullRequestSource(source: string[]): ReturnType<typeof parseSource> {
  const parsed = parseSource(source);
  if (parsed.kind !== "pull") throw new GitHubError("This action is only available on pull requests", 400);
  if (!/^\d+$/.test(parsed.value)) throw new GitHubError("This pull request number is not supported", 400);
  return parsed;
}

/** Maps GitHub's raw issue-comment response into the small client-side conversation shape. */
function summarizeComment(comment: IssueComment): PullRequestComment {
  return {
    author: comment.user.login,
    avatarUrl: comment.user.avatar_url,
    body: comment.body,
    createdAt: comment.created_at,
    key: `comment-${comment.id}`,
    updatedAt: comment.updated_at,
  };
}

/** Maps a submitted PR review into the shared conversation timeline. */
function summarizeReview(review: PullRequestReview): PullRequestComment {
  const state = review.state.toLowerCase().replaceAll("_", " ");

  return {
    author: review.user.login,
    avatarUrl: review.user.avatar_url,
    body: review.body,
    context: state,
    createdAt: review.submitted_at ?? "",
    key: `review-${review.id}`,
    reviewId: review.id,
  };
}

/** Maps GitHub's thread metadata to the REST root comment it enriches. */
async function getPullRequestReviewThreadMetadata(parsed: ReturnType<typeof parseSource>, token: string): Promise<Map<string, PullRequestReviewThreadMetadata>> {
  const [owner, repo] = parsed.repository.split("/");
  const metadata = new Map<string, PullRequestReviewThreadMetadata>();
  let cursor: string | null = null;

  do {
    const data: PullRequestReviewThreadQuery = await githubGraphql<PullRequestReviewThreadQuery>(token, `query PullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              id
              isOutdated
              isResolved
              resolvedBy { login }
              viewerCanReply
              viewerCanResolve
              viewerCanUnresolve
              comments(first: 1) { nodes { url } }
            }
            pageInfo { endCursor hasNextPage }
          }
        }
      }
    }`, { after: cursor, number: Number(parsed.value), owner, repo });
    const threads: PullRequestReviewThreadConnection | undefined = data.repository?.pullRequest?.reviewThreads;
    if (!threads) break;

    for (const thread of threads.nodes) {
      const rootUrl = thread.comments.nodes[0]?.url;
      if (rootUrl) metadata.set(rootUrl, thread);
    }
    cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (cursor);

  return metadata;
}

/** Confirms that an opaque review-thread ID belongs to the pull request named by the action route. */
async function reviewThreadBelongsToPullRequest(parsed: ReturnType<typeof parseSource>, threadId: string, token: string): Promise<boolean> {
  const data = await githubGraphql<PullRequestReviewThreadNodeQuery>(token, `query PullRequestReviewThread($threadId: ID!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        pullRequest {
          number
          repository { nameWithOwner }
        }
      }
    }
  }`, { threadId });
  const pullRequest = data.node?.pullRequest;

  return pullRequest?.number === Number(parsed.value) && pullRequest.repository.nameWithOwner === parsed.repository;
}

/** Reconstructs one GitHub inline discussion from its root comment and direct replies. */
function summarizeReviewThread(
  root: PullRequestReviewComment,
  replies: PullRequestReviewComment[],
  metadata?: PullRequestReviewThreadMetadata,
): PullRequestReviewThread {
  const comments = [root, ...replies].map((comment) => ({
    author: comment.user.login,
    avatarUrl: comment.user.avatar_url,
    body: comment.body,
    createdAt: comment.created_at,
    id: comment.id,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  }));

  return {
    canReply: metadata?.viewerCanReply ?? false,
    canResolve: metadata?.viewerCanResolve ?? false,
    canUnresolve: metadata?.viewerCanUnresolve ?? false,
    comments,
    diffHunk: root.diff_hunk,
    id: metadata?.id,
    isOutdated: metadata?.isOutdated ?? false,
    isResolved: metadata?.isResolved ?? false,
    line: root.line ?? undefined,
    originalLine: root.original_line ?? undefined,
    originalStartLine: root.original_start_line ?? undefined,
    path: root.path,
    resolvedBy: metadata?.resolvedBy?.login,
    reviewId: root.pull_request_review_id ?? undefined,
    side: root.side ?? undefined,
    startLine: root.start_line ?? undefined,
    statusKnown: Boolean(metadata),
  };
}

/** Maps GitHub's nested commit response into the compact PR conversation record. */
function summarizePullRequestCommit(commit: PullRequestCommitRecord): PullRequestCommit {
  return {
    author: commit.author?.login ?? commit.commit.author?.name ?? "Unknown author",
    message: commit.commit.message,
    sha: commit.sha,
  };
}

/** Names the actor and target represented by one GitHub activity event. */
function timelineEventText(event: GitHubTimelineEvent): string {
  const actor = event.actor?.login ?? "GitHub";
  const target = event.requested_reviewer?.login ?? event.assignee?.login;
  const label = event.label?.name;

  switch (event.event) {
    case "assigned": return target ? `${actor} assigned ${target}` : `${actor} assigned a collaborator`;
    case "unassigned": return target ? `${actor} unassigned ${target}` : `${actor} removed an assignee`;
    case "labeled": return label ? `${actor} added the ${label} label` : `${actor} added a label`;
    case "unlabeled": return label ? `${actor} removed the ${label} label` : `${actor} removed a label`;
    case "review_requested": return target ? `${actor} requested a review from ${target}` : `${actor} requested a review`;
    case "review_request_removed": return target ? `${actor} removed ${target} as a reviewer` : `${actor} removed a reviewer`;
    case "deployed": return `${actor} deployed this pull request`;
    case "ready_for_review": return `${actor} marked this pull request ready for review`;
    case "converted_to_draft": return `${actor} converted this pull request to draft`;
    case "head_ref_force_pushed": return `${actor} force-pushed the head branch`;
    case "base_ref_force_pushed": return `${actor} force-pushed the base branch`;
    case "merged": return `${actor} merged this pull request`;
    case "closed": return `${actor} closed this pull request`;
    case "reopened": return `${actor} reopened this pull request`;
    case "locked": return `${actor} locked this conversation`;
    case "unlocked": return `${actor} unlocked this conversation`;
    default: return `${actor} ${event.event.replaceAll("_", " ")}`;
  }
}

/** Converts GitHub's varied activity payloads into the one sentence shown in the compact timeline. */
function summarizeTimelineEvent(event: GitHubTimelineEvent): PullRequestTimelineEvent | undefined {
  if (!event.created_at || ["commented", "committed", "mentioned", "reviewed", "subscribed"].includes(event.event)) return undefined;

  return {
    createdAt: event.created_at,
    key: `event-${event.id ?? `${event.event}-${event.created_at}`}`,
    text: timelineEventText(event),
  };
}

/** Loads the recent commit history without preventing the rest of the PR workspace from rendering. */
async function getPullRequestCommits(parsed: ReturnType<typeof parseSource>, token?: string): Promise<PullRequestCommitList> {
  try {
    const commits = await githubAllItems<PullRequestCommitRecord>(`${parsed.apiPath}/commits?per_page=100`, token);
    return { commits: commits.map(summarizePullRequestCommit), unavailable: false };
  } catch {
    return { commits: [], unavailable: true };
  }
}

/** Loads the non-comment activity records that GitHub places between conversation messages. */
async function getPullRequestTimeline(parsed: ReturnType<typeof parseSource>, token?: string): Promise<PullRequestTimeline> {
  try {
    const path = `${parsed.apiPath.replace("/pulls/", "/issues/")}/timeline?per_page=100`;
    const events = await githubAllItems<GitHubTimelineEvent>(path, token);
    return { events: events.flatMap((event) => {
      const summary = summarizeTimelineEvent(event);
      return summary ? [summary] : [];
    }), unavailable: false };
  } catch {
    return { events: [], unavailable: true };
  }
}

/** Loads the authenticated conversation records shown in the PR workspace. */
async function getPullRequestConversation(parsed: ReturnType<typeof parseSource>, token?: string): Promise<PullRequestConversation> {
  // Preserve available records while telling the UI when GitHub could not provide the full conversation.
  const [commentsResult, reviewsResult, reviewCommentsResult, threadMetadataResult] = await Promise.allSettled([
    githubAllItems<IssueComment>(`${parsed.apiPath.replace("/pulls/", "/issues/")}/comments?per_page=100&sort=created&direction=asc`, token),
    githubAllItems<PullRequestReview>(`${parsed.apiPath}/reviews?per_page=100`, token),
    githubAllItems<PullRequestReviewComment>(`${parsed.apiPath}/comments?per_page=100&sort=created&direction=asc`, token),
    token ? getPullRequestReviewThreadMetadata(parsed, token) : Promise.resolve(new Map<string, PullRequestReviewThreadMetadata>()),
  ]);
  const comments = commentsResult.status === "fulfilled" ? commentsResult.value : [];
  const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];
  const reviewComments = reviewCommentsResult.status === "fulfilled" ? reviewCommentsResult.value : [];
  const threadMetadata = threadMetadataResult.status === "fulfilled" ? threadMetadataResult.value : new Map<string, PullRequestReviewThreadMetadata>();
  const repliesByRoot = new Map<number, PullRequestReviewComment[]>();
  const roots: PullRequestReviewComment[] = [];

  for (const comment of reviewComments) {
    if (comment.in_reply_to_id) {
      const replies = repliesByRoot.get(comment.in_reply_to_id) ?? [];
      replies.push(comment);
      repliesByRoot.set(comment.in_reply_to_id, replies);
    } else {
      roots.push(comment);
    }
  }

  return {
    comments: [
      ...comments.map(summarizeComment),
      ...reviews.filter((review) => Boolean(review.submitted_at)).map(summarizeReview),
    ].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
    reviewThreads: roots
      .map((root) => summarizeReviewThread(root, repliesByRoot.get(root.id) ?? [], threadMetadata.get(root.html_url)))
      .sort((left, right) => Date.parse(left.comments[0]?.createdAt ?? "") - Date.parse(right.comments[0]?.createdAt ?? "")),
    unavailable: [commentsResult, reviewsResult, reviewCommentsResult, threadMetadataResult].some((result) => result.status === "rejected"),
  };
}

/** Matches direct PR triggers or the current head and synthetic merge commits only. */
function isPullRequestWorkflow(run: WorkflowRun, pullRequest: PullRequest): boolean {
  if (run.pull_requests?.length) return run.pull_requests.some((candidate) => candidate.number === pullRequest.number);
  if (run.head_branch !== pullRequest.head.ref) return false;
  if (run.event === "push") return run.head_sha === pullRequest.head.sha;
  return ["pull_request", "pull_request_target"].includes(run.event)
    && (run.head_sha === pullRequest.head.sha || run.head_sha === pullRequest.merge_commit_sha);
}

/** Combines head and synthetic-merge workflow queries into the newest unique PR runs. */
function mergePullRequestWorkflowRuns(workflowRuns: WorkflowRuns[], pullRequest: PullRequest): WorkflowRun[] {
  const runs = new Map<number, WorkflowRun>();

  for (const { workflow_runs } of workflowRuns) {
    for (const run of workflow_runs) {
      if (isPullRequestWorkflow(run, pullRequest)) runs.set(run.id, run);
    }
  }

  return [...runs.values()].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

/** Maps one GitHub Actions response into the compact CI summary and details item consumed by the client. */
function summarizeWorkflowRun(run: WorkflowRun): PullRequestWorkflowRun {
  return {
    conclusion: run.conclusion,
    id: run.id,
    name: run.name,
    status: run.status,
    url: run.html_url,
  };
}

/** Loads the controls that only an open pull request can render or act on. */
async function getPullRequestControls(parsed: ReturnType<typeof parseSource>, pullRequest: PullRequest, token?: string) {
  if (pullRequest.state !== "open" || pullRequest.merged) {
    return { capabilities: undefined, workflowRuns: [] };
  }

  const workflowRunsPath = `/repos/${parsed.encodedRepository}/actions/runs`;
  const capabilitiesRequest = token
    ? getPullRequestCapabilities(parsed, pullRequest.number, token).catch(() => undefined)
    : Promise.resolve(undefined);
  const [headWorkflowRuns, branchPullRequestWorkflowRuns, pullRequestTargetWorkflowRuns, capabilities] = await Promise.all([
    githubRequest<WorkflowRuns>(`${workflowRunsPath}?head_sha=${encodeURIComponent(pullRequest.head.sha)}&per_page=100`, token).catch(() => ({ workflow_runs: [] })),
    githubRequest<WorkflowRuns>(`${workflowRunsPath}?branch=${encodeURIComponent(pullRequest.head.ref)}&event=pull_request&per_page=100`, token).catch(() => ({ workflow_runs: [] })),
    githubRequest<WorkflowRuns>(`${workflowRunsPath}?branch=${encodeURIComponent(pullRequest.head.ref)}&event=pull_request_target&per_page=100`, token).catch(() => ({ workflow_runs: [] })),
    capabilitiesRequest,
  ]);

  return {
    capabilities,
    workflowRuns: mergePullRequestWorkflowRuns([headWorkflowRuns, branchPullRequestWorkflowRuns, pullRequestTargetWorkflowRuns], pullRequest),
  };
}

/** Reads the exact authenticated viewer and repository capabilities required for PR mutations. */
async function getPullRequestCapabilities(parsed: ReturnType<typeof parseSource>, number: number, token: string): Promise<PullRequestCapabilities | undefined> {
  const [owner, repo] = parsed.repository.split("/");
  const data = await githubGraphql<PullRequestCapabilityQuery>(token, `query PullRequestCapabilities($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      viewerPermission
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      pullRequest(number: $number) {
        id
        mergeStateStatus
        viewerCanClose
        viewerCanUpdate
      }
    }
  }`, { number, owner, repo });
  const repository = data.repository;

  if (!repository?.pullRequest) return undefined;

  const mergeMethods: PullRequestMergeMethod[] = [];
  if (repository.mergeCommitAllowed) mergeMethods.push("merge");
  if (repository.squashMergeAllowed) mergeMethods.push("squash");
  if (repository.rebaseMergeAllowed) mergeMethods.push("rebase");
  const viewerCanWrite = repository.viewerPermission === "ADMIN" || repository.viewerPermission === "MAINTAIN" || repository.viewerPermission === "WRITE";

  return {
    mergeMethods,
    mergeStateStatus: repository.pullRequest.mergeStateStatus,
    pullRequestId: repository.pullRequest.id,
    viewerCanClose: repository.pullRequest.viewerCanClose,
    viewerCanUpdate: repository.pullRequest.viewerCanUpdate,
    viewerCanWrite,
  };
}

/** Applies GitHub's current PR state, repository settings, and viewer permission to merge visibility. */
function canMergePullRequest(pullRequest: PullRequest, capabilities: PullRequestCapabilities | undefined): boolean {
  if (!capabilities) return false;

  return pullRequest.state === "open" && !pullRequest.merged && !pullRequest.draft && pullRequest.mergeable === true && ["BEHIND", "CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(capabilities.mergeStateStatus) && capabilities.viewerCanWrite && Boolean(capabilities.mergeMethods.length);
}

/** Builds the PR-only conversation and action state without blocking the page on optional data. */
async function buildPullRequestWorkspace(parsed: ReturnType<typeof parseSource>, pullRequest: PullRequest, token?: string): Promise<PullRequestWorkspace> {
  const [conversation, commits, timeline, { capabilities, workflowRuns }] = await Promise.all([
    getPullRequestConversation(parsed, token),
    getPullRequestCommits(parsed, token),
    getPullRequestTimeline(parsed, token),
    getPullRequestControls(parsed, pullRequest, token),
  ]);
  const state = pullRequest.merged ? "merged" : pullRequest.state;

  return {
    canClose: state === "open" && Boolean(capabilities?.viewerCanClose),
    canComment: Boolean(token) && !pullRequest.locked,
    canEditBody: Boolean(capabilities?.viewerCanUpdate),
    canManageMerge: state === "open" && !pullRequest.draft && Boolean(capabilities?.viewerCanWrite && capabilities.mergeMethods.length),
    canMarkReady: state === "open" && pullRequest.draft && Boolean(capabilities?.viewerCanUpdate),
    canMerge: canMergePullRequest(pullRequest, capabilities),
    canReview: state === "open" && !pullRequest.locked && Boolean(token),
    comments: conversation.comments,
    commits: commits.commits,
    commitsUnavailable: commits.unavailable,
    conversationUnavailable: conversation.unavailable || timeline.unavailable,
    draft: pullRequest.draft,
    hasGitHubAccess: Boolean(token),
    mergeMethods: capabilities?.mergeMethods ?? [],
    reviewThreads: conversation.reviewThreads,
    state,
    timelineEvents: timeline.events,
    workflowRuns: workflowRuns.slice(0, 8).map(summarizeWorkflowRun),
  };
}

/** Loads the current PR workspace after a client mutation refreshes its canonical GitHub state. */
export async function getPullRequestWorkspace(source: string[], token: string): Promise<PullRequestWorkspace> {
  const parsed = pullRequestSource(source);
  const pullRequest = await githubRequest<PullRequest>(parsed.apiPath, token);
  return buildPullRequestWorkspace(parsed, pullRequest, token);
}

/** Requires a GitHub sign-in before attempting a user-authorized mutation. */
function requireGitHubToken(token?: string): string {
  if (!token) throw new GitHubError("Sign in with GitHub to use pull request actions", 401);
  return token;
}

/** Fetches current PR state and matching viewer capabilities before a GitHub mutation. */
async function currentPullRequest(parsed: ReturnType<typeof parseSource>, token: string): Promise<{ capabilities: PullRequestCapabilities | undefined; pullRequest: PullRequest }> {
  const [pullRequest, capabilities] = await Promise.all([
    githubRequest<PullRequest>(parsed.apiPath, token),
    getPullRequestCapabilities(parsed, Number(parsed.value), token),
  ]);
  return { capabilities, pullRequest };
}

/** Runs one GitHub-native PR action and returns the refreshed UI state plus confirmed merge status. */
export async function performPullRequestAction(source: string[], token: string | undefined, action: PullRequestAction): Promise<{ celebrate: boolean; workspace: PullRequestWorkspace }> {
  const accessToken = requireGitHubToken(token);
  const parsed = pullRequestSource(source);

  if (action.action === "comment") {
    const body = action.body.trim();
    if (!body || body.length > 65_536) throw new GitHubError("Comments must be between 1 and 65,536 characters", 400);
    await githubMutation(`${parsed.apiPath.replace("/pulls/", "/issues/")}/comments`, accessToken, "POST", { body });
    return { celebrate: false, workspace: await getPullRequestWorkspace(source, accessToken) };
  }

  if (action.action === "reply") {
    const body = action.body.trim();
    if (!Number.isInteger(action.commentId) || action.commentId < 1 || !body || body.length > 65_536) {
      throw new GitHubError("Replies must target one comment and be between 1 and 65,536 characters", 400);
    }
    await githubMutation(`${parsed.apiPath}/comments/${action.commentId}/replies`, accessToken, "POST", { body });
    return { celebrate: false, workspace: await getPullRequestWorkspace(source, accessToken) };
  }

  if (action.action === "resolve-thread" || action.action === "unresolve-thread") {
    if (!await reviewThreadBelongsToPullRequest(parsed, action.threadId, accessToken)) {
      throw new GitHubError("Review thread does not belong to this pull request", 400);
    }
    const mutation = action.action === "resolve-thread" ? "resolveReviewThread" : "unresolveReviewThread";
    await githubGraphql(accessToken, `mutation ReviewThreadResolution($threadId: ID!) {
      ${mutation}(input: { threadId: $threadId }) {
        thread { id isResolved }
      }
    }`, { threadId: action.threadId });
    return { celebrate: false, workspace: await getPullRequestWorkspace(source, accessToken) };
  }

  if (action.action === "review") {
    const body = action.body.trim();
    if (["COMMENT", "REQUEST_CHANGES"].includes(action.event) && !body) {
      throw new GitHubError("GitHub requires a comment when requesting changes or leaving a review comment", 400);
    }
    if (body.length > 65_536) throw new GitHubError("Review comments must be at most 65,536 characters", 400);
    await githubMutation(`${parsed.apiPath}/reviews`, accessToken, "POST", { body, event: action.event });
    return { celebrate: false, workspace: await getPullRequestWorkspace(source, accessToken) };
  }

  const { capabilities, pullRequest } = await currentPullRequest(parsed, accessToken);

  if (action.action === "edit-title") {
    const title = action.title.trim();
    if (!title || title.length > 256) throw new GitHubError("Pull request titles must be between 1 and 256 characters", 400);
    if (!capabilities?.viewerCanUpdate) {
      throw new GitHubError("GitHub does not allow this pull request title to be edited", 403);
    }
    await githubMutation(parsed.apiPath, accessToken, "PATCH", { title });
  }

  if (action.action === "edit-body") {
    if (!capabilities?.viewerCanUpdate) {
      throw new GitHubError("GitHub does not allow this pull request body to be edited", 403);
    }
    await githubMutation(parsed.apiPath, accessToken, "PATCH", { body: action.body });
  }

  if (action.action === "close") {
    if (pullRequest.state !== "open" || pullRequest.merged || !capabilities?.viewerCanClose) {
      throw new GitHubError("GitHub does not allow this pull request to be closed", 403);
    }
    await githubMutation(parsed.apiPath, accessToken, "PATCH", { state: "closed" });
  }

  if (action.action === "merge") {
    if (!canMergePullRequest(pullRequest, capabilities) || !capabilities?.mergeMethods.includes(action.method)) {
      throw new GitHubError("GitHub does not allow this pull request to be merged", 403);
    }

    const response = await githubResponse(`${parsed.apiPath}/merge`, accessToken, "PUT", { merge_method: action.method, sha: pullRequest.head.sha });
    // SAFETY: GitHub's merge endpoint returns the documented PullRequestMergeResult contract.
    const result = await response.json() as PullRequestMergeResult;
    if (!result.merged) throw new GitHubError(result.message || "GitHub could not merge this pull request", 409);
    return { celebrate: true, workspace: await getPullRequestWorkspace(source, accessToken) };
  }

  if (action.action === "ready") {
    if (pullRequest.state !== "open" || pullRequest.merged || !pullRequest.draft || !capabilities?.viewerCanUpdate) {
      throw new GitHubError("GitHub does not allow this pull request to be marked ready for review", 403);
    }

    await githubGraphql<{ markPullRequestReadyForReview: { pullRequest: { id: string } } }>(accessToken, `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest { id }
      }
    }`, { pullRequestId: capabilities.pullRequestId });
  }

  return { celebrate: false, workspace: await getPullRequestWorkspace(source, accessToken) };
}

/** Resolves the exact repository revision represented by a pull request, comparison, or commit. */
async function getSourceRevision(parsed: ReturnType<typeof parseSource>, token?: string): Promise<string> {
  if (parsed.kind === "commit") return parsed.value;
  if (parsed.kind === "compare") return parsed.value.split("...").at(-1) ?? parsed.value;
  if (parsed.kind === "repository") {
    const repository = await githubRequest<Repository>(parsed.apiPath, token);
    const repositoryRef = parsed.repositoryRef ?? repository.default_branch;
    const commit = await githubRequest<Commit>(`${parsed.apiPath}/commits/${encodeURIComponent(repositoryRef)}`, token);
    return commit.sha;
  }
  const pullRequest = await githubRequest<PullRequest>(`${parsed.apiPath}?context=1`, token);
  return pullRequest.head.sha;
}

/** Loads the immutable revision and file tree shared by one code-question request. */
async function getRepositorySnapshot(parsed: ReturnType<typeof parseSource>, token?: string): Promise<RepositorySnapshot> {
  const revision = await getSourceRevision(parsed, token);
  const tree = await githubRequest<GitTree>(`/repos/${parsed.encodedRepository}/git/trees/${encodeURIComponent(revision)}?recursive=1`, token);
  return { encodedRepository: parsed.encodedRepository, revision, tree };
}

/** Posts one model-authored comment to the current PR after validating its GitHub target. */
export async function postPullRequestAgentComment(
  source: string[],
  token: string | undefined,
  comment: PullRequestAgentComment,
): Promise<PullRequestAgentCommentResult> {
  const accessToken = requireGitHubToken(token);
  const parsed = pullRequestSource(source);
  const body = comment.body.trim();
  if (!body || body.length > 65_536) throw new GitHubError("Comments must be between 1 and 65,536 characters", 400);

  let response: Response;

  if (comment.type === "general") {
    const path = `${parsed.apiPath.replace("/pulls/", "/issues/")}/comments`;
    response = await githubResponse(path, accessToken, "POST", { body });
  } else {
    const path = comment.path.trim();
    const startLine = comment.startLine;
    const validLine = Number.isInteger(comment.line) && comment.line > 0;
    const hasRange = startLine !== undefined || comment.startSide !== undefined;
    const validRange = !hasRange || (
      Number.isInteger(startLine)
      && (startLine ?? 0) > 0
      && (startLine ?? 0) < comment.line
      && comment.startSide === comment.side
    );

    if (!path || path.length > 1_024 || !validLine || !validRange) {
      throw new GitHubError("The GitHub line-comment target is invalid", 400);
    }

    const commitId = await getSourceRevision(parsed, accessToken);
    response = await githubResponse(`${parsed.apiPath}/comments`, accessToken, "POST", {
      body,
      commit_id: commitId,
      line: comment.line,
      path,
      side: comment.side,
      start_line: comment.startLine,
      start_side: comment.startSide,
    });
  }

  const created = await response.json();
  if (!isRecord(created) || !isString(created.html_url)) {
    throw new GitHubError("GitHub did not return the created comment", 502);
  }

  return comment.type === "general"
    ? { type: "general", url: created.html_url }
    : { line: comment.line, path: comment.path.trim(), side: comment.side, type: "line", url: created.html_url };
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

/** Keeps source-like text files while excluding bulky benchmark and log artifacts. */
function isRepositorySourceFile(path: string): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return !extension || !REPOSITORY_DATA_EXTENSIONS.has(extension);
}

/** Builds bounded repository-wide context and retains its exact revision for later file lookups. */
export async function getRepositoryContext(source: string[], token?: string): Promise<RepositoryContext> {
  const parsed = parseSource(source);
  const [snapshot, diff] = await Promise.all([
    getRepositorySnapshot(parsed, token),
    parsed.kind === "repository" ? "" : getDiffResponse(source, token).then((response) => response.text()),
  ]);
  const { revision, tree } = snapshot;
  const rootFiles = ["AGENTS.md", "README.md", "package.json", "tsconfig.json", "Cargo.toml", "go.mod", "pyproject.toml"];
  const preferredPaths = [...new Set([...changedPathsFromDiff(diff), ...rootFiles])];
  const preferredPathSet = new Set(preferredPaths);
  const preferredBlobsByPath = new Map<string, GitTreeEntry>();
  let treeText = "";

  // Keep only model-context candidates while building the bounded tree summary.
  for (const entry of tree.tree) {
    if (entry.type !== "blob") continue;
    if (preferredPathSet.has(entry.path)) preferredBlobsByPath.set(entry.path, entry);
    if (treeText.length < CONTEXT_TREE_LIMIT) treeText += `${treeText ? "\n" : ""}${entry.path}`;
  }

  const entries: GitTreeEntry[] = [];
  for (const path of preferredPaths) {
    const entry = preferredBlobsByPath.get(path);
    if (!entry || (entry.size ?? 0) > CONTEXT_FILES_LIMIT) continue;
    entries.push(entry);
    if (entries.length === CONTEXT_FILE_COUNT) break;
  }

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

  treeText = treeText.slice(0, CONTEXT_TREE_LIMIT);
  const truncation = tree.truncated ? "\n(GitHub truncated this unusually large tree.)" : "";
  const text = [
    `Repository: ${parsed.repository}`,
    `Revision: ${revision}`,
    `Repository tree:\n${treeText}${truncation}`,
    `Changed and root file contents:${fileContext || "\nNo textual files were available."}`,
    `Full change diff:\n${diff.slice(0, CONTEXT_DIFF_LIMIT)}`,
  ].join("\n\n");
  return { snapshot, text };
}

/** Reads a small, exact set of files from the same revision that supplied the model context. */
export async function readRepositoryFiles(source: string[], paths: string[], token?: string, snapshot?: RepositorySnapshot): Promise<{ files: Array<{ path: string; text?: string; error?: string }>; revision: string }> {
  const repositorySnapshot = snapshot ?? await getRepositorySnapshot(parseSource(source), token);
  const { revision, tree } = repositorySnapshot;
  const requestedPaths = [...new Set(paths)].slice(0, TOOL_FILE_COUNT);
  const requestedPathSet = new Set(requestedPaths);
  const filesByPath = new Map<string, GitTreeEntry>();

  // Stop retaining tree entries once every requested blob has been found.
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !requestedPathSet.has(entry.path)) continue;
    filesByPath.set(entry.path, entry);
    if (filesByPath.size === requestedPaths.length) break;
  }

  const files: Array<{ path: string; text?: string; error?: string }> = [];
  let remaining = TOOL_FILES_LIMIT;

  for (const path of requestedPaths) {
    const entry = filesByPath.get(path);
    if (!entry) {
      files.push({ error: "File not found at this revision.", path });
      continue;
    }
    if ((entry.size ?? 0) > CONTEXT_FILES_LIMIT || remaining <= 0) {
      files.push({ error: "File is too large to include.", path });
      continue;
    }

    const blob = await githubRequest<GitBlob>(`/repos/${repositorySnapshot.encodedRepository}/git/blobs/${entry.sha}`, token);
    const text = decodeGitBlob(blob).slice(0, remaining);
    if (!text) {
      files.push({ error: "File is binary or empty.", path });
      continue;
    }

    remaining -= text.length;
    files.push({ path, text });
  }

  return { files, revision };
}

/** Loads the title, description, author, change totals, and optionally the interactive PR workspace. */
export async function getDiffDocument(source: string[], token?: string, includePullRequestWorkspace = false): Promise<DiffDocument> {
  const parsed = parseSource(source);

  if (parsed.kind === "repository") {
    const repository = await githubRequest<Repository>(parsed.apiPath, token);
    const repositoryRef = parsed.repositoryRef ?? repository.default_branch;
    const sourcePath = parsed.filePath
      ? `/blob/${encodeURIComponent(repositoryRef)}/${parsed.filePath.split("/").map(encodeURIComponent).join("/")}`
      : parsed.repositoryRef ? `/tree/${encodeURIComponent(repositoryRef)}` : "";

    return {
      author: repository.owner.login,
      avatarUrl: repository.owner.avatar_url,
      defaultBranch: repository.default_branch,
      description: repository.description ?? undefined,
      filePath: parsed.filePath,
      repository: parsed.repository,
      repositoryRef,
      sourceUrl: `${repository.html_url}${sourcePath}`,
      title: repository.name,
    };
  }

  if (parsed.kind === "pull") {
    const pullRequest = await githubRequest<PullRequest>(parsed.apiPath, token);
    const workspace = includePullRequestWorkspace ? await buildPullRequestWorkspace(parsed, pullRequest, token) : undefined;

    return {
      additions: pullRequest.additions,
      author: pullRequest.user.login,
      avatarUrl: pullRequest.user.avatar_url,
      baseLabel: pullRequest.base.label,
      changedFiles: pullRequest.changed_files,
      deletions: pullRequest.deletions,
      description: pullRequest.body ?? undefined,
      headLabel: pullRequest.head.label,
      pullRequest: workspace,
      repository: parsed.repository,
      sourceUrl: pullRequest.html_url,
      title: pullRequest.title,
    };
  }

  if (parsed.kind === "compare") {
    const comparison = await githubRequest<Compare>(parsed.apiPath, token);
    const [baseLabel, headLabel] = parsed.value.split("...");
    const owner = parsed.repository.split("/")[0];

    return {
      author: owner,
      avatarUrl: `https://github.com/${owner}.png`,
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

/** Wraps raw diff content with the response contract shared by every GitHub source. */
function diffResponse(body: BodyInit): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Downloads one repository snapshot and returns its requested file or every textual file. */
async function getRepositoryFiles(parsed: ReturnType<typeof parseSource>, token?: string): Promise<RepositoryFile[]> {
  const revision = await getSourceRevision(parsed, token);
  const response = await githubResponse(`${parsed.apiPath}/tarball/${encodeURIComponent(revision)}`, token);
  if (!response.body) throw new GitHubError("The repository could not be loaded", 502);

  const archive = extract();
  const extraction = pipeline(
    Readable.from([Buffer.from(await response.arrayBuffer())]),
    createGunzip(),
    archive,
  );
  const files: RepositoryFile[] = [];

  for await (const entry of archive) {
    const name = entry.header.name.split("/").slice(1).join("/");
    const requestedFile = !parsed.filePath || name === parsed.filePath;
    if (entry.header.type !== "file" || !name || !requestedFile || !isRepositorySourceFile(name)) {
      entry.resume();
      continue;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(Buffer.from(chunk));
    const contents = Buffer.concat(chunks).toString("utf8");
    if (!contents.includes("\0")) files.push({ contents, name });
  }

  await extraction;
  if (parsed.filePath && !files.length) {
    throw new GitHubError("The requested file was not found or cannot be displayed", 404);
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

/** Streams the raw GitHub diff so large comparisons are not serialized through React. */
export async function getDiffResponse(source: string[], token?: string): Promise<Response> {
  const parsed = parseSource(source);
  if (parsed.kind === "repository") return Response.json(await getRepositoryFiles(parsed, token));

  const response = await fetch(`${GITHUB_API}${parsed.apiPath}`, {
    headers: githubHeaders("application/vnd.github.diff", token),
    cache: "no-store",
  });

  if (response.ok && response.body) return diffResponse(response.body);

  // GitHub's REST media type rejects public diffs above 300 files, while its
  // streaming web endpoint still serves them in full.
  if (response.status === 406) {
    const publicDiffUrl = `https://github.com/${parsed.repository}/${parsed.kind}/${encodeURIComponent(parsed.value)}.diff`;
    const publicResponse = await fetch(publicDiffUrl, {
      cache: "no-store",
      redirect: "follow",
    });
    const contentType = publicResponse.headers.get("content-type") ?? "";

    if (publicResponse.ok && publicResponse.body && contentType.startsWith("text/plain")) {
      return diffResponse(publicResponse.body);
    }

    if (parsed.kind === "pull" && token) {
      return diffResponse(await getLargePullRequestDiff(parsed.apiPath, token));
    }
  }

  throw new GitHubError("The diff could not be loaded", response.status);
}

/** Encodes a repository path segment-by-segment for GitHub's contents endpoint. */
function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Reads one bounded text file at a specific revision, treating absent or oversized files as unavailable. */
async function getCallDiffFileText(encodedRepository: string, path: string, ref: string, token?: string): Promise<string | undefined> {
  try {
    const file = await githubRequest<{ content?: string; encoding?: string; size?: number }>(
      `/repos/${encodedRepository}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if ((file.size ?? 0) > CALL_DIFF_FILE_SIZE_LIMIT || file.encoding !== "base64" || !isString(file.content)) return undefined;

    const text = Buffer.from(file.content.replaceAll("\n", ""), "base64").toString("utf8");
    return text.length <= CALL_DIFF_FILE_SIZE_LIMIT && !text.includes("\0") ? text : undefined;
  } catch (error) {
    if (error instanceof GitHubError && [404, 409, 422].includes(error.status)) return undefined;
    throw error;
  }
}

/** Fetches the before and after snapshots for one changed Call Flow source file. */
async function getCallDiffFileSnapshot(
  encodedRepository: string,
  file: PullRequestFile,
  fromRef: string,
  toRef: string,
  token?: string,
): Promise<CallDiffSource["files"][number]> {
  const beforePath = file.status === "added" ? undefined : file.previous_filename ?? file.filename;
  const afterPath = file.status === "removed" ? undefined : file.filename;
  const [before, after] = await Promise.all([
    beforePath ? getCallDiffFileText(encodedRepository, beforePath, fromRef, token) : undefined,
    afterPath ? getCallDiffFileText(encodedRepository, afterPath, toRef, token) : undefined,
  ]);
  return {
    additions: file.additions ?? 0,
    after: after && afterPath ? { path: afterPath, text: after } : undefined,
    before: before && beforePath ? { path: beforePath, text: before } : undefined,
    deletions: file.deletions ?? 0,
    key: afterPath ?? beforePath ?? file.filename,
  };
}

/** Pages through changed PR files until the bounded source-analysis budget is full. */
async function getPullRequestCallDiffFiles(
  apiPath: string,
  token?: string,
  onCandidate?: (file: PullRequestFile) => void,
): Promise<CallDiffFileSelection> {
  const files: PullRequestFile[] = [];
  let ignoredFiles = 0;
  const fileLimit = token ? CALL_DIFF_FILE_LIMIT : CALL_DIFF_ANONYMOUS_FILE_LIMIT;

  for (let page = 1; page <= 30; page += 1) {
    const batch = await githubRequest<PullRequestFile[]>(`${apiPath}/files?per_page=100&page=${page}`, token);
    for (const file of batch) {
      if (!isCallDiffSourcePath(file.filename) && !isCallDiffSourcePath(file.previous_filename ?? "")) {
        ignoredFiles += 1;
        continue;
      }
      if (files.length === fileLimit) return { files, ignoredFiles, truncated: true };
      files.push(file);
      onCandidate?.(file);
    }
    if (batch.length < 100) return { files, ignoredFiles, truncated: false };
  }

  return { files, ignoredFiles, truncated: true };
}

/** Chooses bounded TypeScript-parseable files from GitHub's non-paginated comparison payload. */
function getCompareCallDiffFiles(comparison: Compare, token?: string): CallDiffFileSelection {
  const sourceFiles = comparison.files ?? [];
  const fileLimit = token ? CALL_DIFF_FILE_LIMIT : CALL_DIFF_ANONYMOUS_FILE_LIMIT;
  const files: PullRequestFile[] = [];
  let ignoredFiles = 0;

  for (const file of sourceFiles) {
    if (!isCallDiffSourcePath(file.filename) && !isCallDiffSourcePath(file.previous_filename ?? "")) {
      ignoredFiles += 1;
      continue;
    }
    if (files.length === fileLimit) return { files, ignoredFiles, truncated: true };
    files.push(file);
  }

  return { files, ignoredFiles, truncated: sourceFiles.length === 300 };
}

/** Fetches the two revision snapshots required for a changed-file call-flow comparison. */
export async function getCallDiffSource(source: string[], token?: string): Promise<CallDiffSource> {
  const parsed = parseSource(source);
  const snapshotPromises = new Map<PullRequestFile, Promise<CallDiffSource["files"][number]>>();
  let fromRef: string;
  let toRef: string;
  let candidateFiles: PullRequestFile[];
  let ignoredFiles: number;
  let truncated: boolean;

  if (parsed.kind === "pull") {
    // Begin each eligible source snapshot as soon as its page identifies it, while later pages keep loading.
    const pullRequestPromise = githubRequest<PullRequest>(parsed.apiPath, token);
    const candidatesPromise = getPullRequestCallDiffFiles(parsed.apiPath, token, (file) => {
      const snapshot = pullRequestPromise.then((pullRequest) =>
        getCallDiffFileSnapshot(parsed.encodedRepository, file, pullRequest.base.sha, pullRequest.head.sha, token),
      );
      // Keep failures for the final Promise.all without reporting an unhandled rejection during pagination.
      void snapshot.catch(() => undefined);
      snapshotPromises.set(file, snapshot);
    });
    const [pullRequest, candidates] = await Promise.all([pullRequestPromise, candidatesPromise]);
    fromRef = pullRequest.base.sha;
    toRef = pullRequest.head.sha;
    candidateFiles = candidates.files;
    ignoredFiles = candidates.ignoredFiles;
    truncated = candidates.truncated;
  } else if (parsed.kind === "compare") {
    const comparison = await githubRequest<Compare>(parsed.apiPath, token);
    const candidates = getCompareCallDiffFiles(comparison, token);
    const [from, to] = parsed.value.split("...");
    fromRef = from ?? "";
    toRef = to ?? "";
    candidateFiles = candidates.files;
    ignoredFiles = candidates.ignoredFiles;
    truncated = candidates.truncated;
  } else {
    throw new GitHubError("Call flow is available for pull requests and comparisons", 400);
  }

  const snapshots = await Promise.all(candidateFiles.map((file) =>
    snapshotPromises.get(file) ?? getCallDiffFileSnapshot(parsed.encodedRepository, file, fromRef, toRef, token),
  ));

  const files = snapshots.filter((file) => {
    if (file.before || file.after) return true;
    ignoredFiles += 1;
    return false;
  });
  return { files, fromRef, ignoredFiles, toRef, truncated };
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
    const bareSource = /^\/?[\w.-]+\/[\w.-]+(?:\/[^?#]+)*\/?(?:#L[1-9]\d*(?:-L[1-9]\d*)?)?$/.test(value);
    const url = new URL(bareSource ? `https://github.com/${value.replace(/^\/+/, "")}` : value);
    const source = url.pathname.replace(/\.(diff|patch)$/, "").split("/").filter(Boolean);

    if (url.hostname !== "github.com") {
      return null;
    }

    parseSource(source);
    const lineHash = /^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(url.hash) ? url.hash : "";
    return `/${source.join("/")}${lineHash}`;
  } catch {
    return null;
  }
}
