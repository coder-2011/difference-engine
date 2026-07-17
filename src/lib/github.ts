import type {
  DiffDocument,
  PullRequestAction,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeMethod,
  PullRequestSummary,
  PullRequestWorkflowRun,
  PullRequestWorkspace,
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

type PullRequestConversation = {
  comments: PullRequestComment[];
  unavailable: boolean;
};

type PullRequestCommitList = {
  commits: PullRequestCommit[];
  unavailable: boolean;
};

type PullRequest = {
  additions: number;
  base: { label: string };
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
  id: number;
  path: string;
  user: GitHubUser;
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
const TOOL_FILE_COUNT = 8;
const TOOL_FILES_LIMIT = 48_000;

export class GitHubError extends Error {
  /** Captures a safe HTTP status for a failed GitHub request. */
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Builds the shared media and optional authorization headers for GitHub requests. */
function githubHeaders(accept: string, token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Extracts GitHub's safe response message without exposing a raw failed response. */
async function githubError(response: Response): Promise<GitHubError> {
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  const fallback = response.status === 404 ? "GitHub item not found" : "GitHub request failed";
  const message = typeof body?.message === "string" ? body.message : fallback;
  return new GitHubError(message, response.status);
}

/** Performs one GitHub API request while keeping the authenticated token on the server. */
async function githubResponse(path: string, token?: string, method = "GET", body?: unknown): Promise<Response> {
  const headers = githubHeaders("application/vnd.github+json", token);
  headers["X-GitHub-Api-Version"] = "2022-11-28";
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${GITHUB_API}${path}`, {
    headers,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) throw await githubError(response);

  return response;
}

/** Performs a typed GitHub API request with optional private-repository access. */
async function githubRequest<T>(path: string, token?: string): Promise<T> {
  const response = await githubResponse(path, token);

  return response.json() as Promise<T>;
}

/** Reads enough newest items from a chronological GitHub collection to fill the requested window. */
async function githubNewestItems<T>(path: string, token: string | undefined, limit: number): Promise<T[]> {
  const response = await githubResponse(path, token);
  const lastPage = response.headers.get("link")?.match(/<([^>]+)>; rel="last"/)?.[1];

  if (!lastPage) return response.json() as Promise<T[]>;

  const url = new URL(lastPage, GITHUB_API);
  const items = await githubRequest<T[]>(`${url.pathname}${url.search}`, token);
  const page = Number(url.searchParams.get("page"));
  if (items.length >= limit || !Number.isInteger(page) || page <= 1) return items.slice(-limit);

  url.searchParams.set("page", String(page - 1));
  const previousItems = await githubRequest<T[]>(`${url.pathname}${url.search}`, token);
  return [...previousItems, ...items].slice(-limit);
}

/** Sends one GitHub mutation whose successful response body is not needed locally. */
async function githubMutation(path: string, token: string, method: "PATCH" | "POST", body?: unknown): Promise<void> {
  await githubResponse(path, token, method, body);
}

/** Queries the small viewer-specific capability set that REST does not return. */
async function githubGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      ...githubHeaders("application/vnd.github+json", token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!response.ok) throw await githubError(response);
  const result = await response.json() as { data?: T; errors?: unknown[] };
  if (!result.data || result.errors?.length) throw new GitHubError("GitHub request failed", 502);
  return result.data;
}

/** Searches pull requests with the card-level change totals unavailable from GitHub's REST search. */
async function searchPullRequests(token: string, query: string, limit = 1_000): Promise<SearchPullRequest[]> {
  const pullRequests: SearchPullRequest[] = [];
  let cursor: string | null = null;

  while (pullRequests.length < limit) {
    const first = Math.min(100, limit - pullRequests.length);
    const response = await fetch(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: {
        ...githubHeaders("application/vnd.github+json", token),
        "Content-Type": "application/json",
      },
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
    const result = await response.json() as { data?: PullRequestSearch; errors?: unknown[] };
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
function parseSource(source: string[]): {
  apiPath: string;
  encodedRepository: string;
  kind: "compare" | "commit" | "pull";
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

  return {
    apiPath: `/repos/${encodedRepository}/${collection}/${encodeURIComponent(value)}`,
    encodedRepository,
    kind,
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
  };
}

/** Maps an inline diff comment into the top-level conversation with its source path. */
function summarizeReviewComment(comment: PullRequestReviewComment): PullRequestComment {
  return {
    author: comment.user.login,
    avatarUrl: comment.user.avatar_url,
    body: comment.body,
    context: `review comment · ${comment.path}`,
    createdAt: comment.created_at,
    key: `review-comment-${comment.id}`,
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

/** Loads the recent commit history without preventing the rest of the PR workspace from rendering. */
async function getPullRequestCommits(parsed: ReturnType<typeof parseSource>, token?: string): Promise<PullRequestCommitList> {
  try {
    const commits = await githubNewestItems<PullRequestCommitRecord>(`${parsed.apiPath}/commits?per_page=100`, token, 100);
    return { commits: commits.map(summarizePullRequestCommit), unavailable: false };
  } catch {
    return { commits: [], unavailable: true };
  }
}

/** Loads the authenticated conversation records shown in the PR workspace. */
async function getPullRequestConversation(parsed: ReturnType<typeof parseSource>, token?: string): Promise<PullRequestConversation> {
  // Preserve available records while telling the UI when GitHub could not provide the full conversation.
  const [commentsResult, reviewsResult, reviewCommentsResult] = await Promise.allSettled([
    githubRequest<IssueComment[]>(`${parsed.apiPath.replace("/pulls/", "/issues/")}/comments?per_page=100&sort=created&direction=desc`, token),
    githubNewestItems<PullRequestReview>(`${parsed.apiPath}/reviews?per_page=100`, token, 100),
    githubRequest<PullRequestReviewComment[]>(`${parsed.apiPath}/comments?per_page=100&sort=created&direction=desc`, token),
  ]);
  const comments = commentsResult.status === "fulfilled" ? commentsResult.value : [];
  const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];
  const reviewComments = reviewCommentsResult.status === "fulfilled" ? reviewCommentsResult.value : [];

  return {
    comments: [
      ...comments.map(summarizeComment),
      ...reviews.filter((review) => Boolean(review.submitted_at && review.body.trim())).map(summarizeReview),
      ...reviewComments.map(summarizeReviewComment),
    ].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)).slice(-100),
    unavailable: [commentsResult, reviewsResult, reviewCommentsResult].some((result) => result.status === "rejected"),
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
  const [conversation, commits, { capabilities, workflowRuns }] = await Promise.all([
    getPullRequestConversation(parsed, token),
    getPullRequestCommits(parsed, token),
    getPullRequestControls(parsed, pullRequest, token),
  ]);
  const state = pullRequest.merged ? "merged" : pullRequest.state;

  return {
    canClose: state === "open" && Boolean(capabilities?.viewerCanClose),
    canComment: Boolean(token) && !pullRequest.locked,
    canManageMerge: state === "open" && !pullRequest.draft && Boolean(capabilities?.viewerCanWrite && capabilities.mergeMethods.length),
    canMarkReady: state === "open" && pullRequest.draft && Boolean(capabilities?.viewerCanUpdate),
    canMerge: canMergePullRequest(pullRequest, capabilities),
    comments: conversation.comments,
    commits: commits.commits,
    commitsUnavailable: commits.unavailable,
    conversationUnavailable: conversation.unavailable,
    draft: pullRequest.draft,
    hasGitHubAccess: Boolean(token),
    mergeMethods: capabilities?.mergeMethods ?? [],
    state,
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

  const { capabilities, pullRequest } = await currentPullRequest(parsed, accessToken);

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
  const pullRequest = await githubRequest<PullRequest>(`${parsed.apiPath}?context=1`, token);
  return pullRequest.head.sha;
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
  const blobByPath = new Map<string, GitTreeEntry>();
  let treeText = "";

  // Build the lookup once, but stop materializing path text at the model's fixed budget.
  for (const entry of tree.tree) {
    if (entry.type !== "blob") continue;
    blobByPath.set(entry.path, entry);
    if (treeText.length < CONTEXT_TREE_LIMIT) treeText += `${treeText ? "\n" : ""}${entry.path}`;
  }
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

  treeText = treeText.slice(0, CONTEXT_TREE_LIMIT);
  const truncation = tree.truncated ? "\n(GitHub truncated this unusually large tree.)" : "";
  return [
    `Repository: ${parsed.repository}`,
    `Revision: ${revision}`,
    `Repository tree:\n${treeText}${truncation}`,
    `Changed and root file contents:${fileContext || "\nNo textual files were available."}`,
    `Full change diff:\n${diff.slice(0, CONTEXT_DIFF_LIMIT)}`,
  ].join("\n\n");
}

/** Reads a small, exact set of files so the code-question agent can inspect missing context. */
export async function readRepositoryFiles(source: string[], paths: string[], token?: string): Promise<{ files: Array<{ path: string; text?: string; error?: string }>; revision: string }> {
  const parsed = parseSource(source);
  const revision = await getSourceRevision(parsed, token);
  const tree = await githubRequest<GitTree>(`/repos/${parsed.encodedRepository}/git/trees/${encodeURIComponent(revision)}?recursive=1`, token);
  const filesByPath = new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry]));
  const requestedPaths = [...new Set(paths)].slice(0, TOOL_FILE_COUNT);
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

    const blob = await githubRequest<GitBlob>(`/repos/${parsed.encodedRepository}/git/blobs/${entry.sha}`, token);
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

/** Streams the raw GitHub diff so large comparisons are not serialized through React. */
export async function getDiffResponse(source: string[], token?: string): Promise<Response> {
  const parsed = parseSource(source);

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
