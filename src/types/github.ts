export type PullRequestSummary = {
  additions: number;
  author: string;
  avatarUrl: string;
  deletions: number;
  draft: boolean;
  number: number;
  repository: string;
  status: "closed" | "merged" | "open";
  title: string;
  updatedAt: string;
  viewerPath: string;
};

export type DiffDocument = {
  additions?: number;
  author: string;
  avatarUrl: string;
  baseLabel?: string;
  changedFiles?: number;
  defaultBranch?: string;
  deletions?: number;
  description?: string;
  filePath?: string;
  headLabel?: string;
  repository: string;
  repositoryRef?: string;
  pullRequest?: PullRequestWorkspace;
  sourceUrl: string;
  title: string;
};

export type RepositoryFile = {
  contents: string;
  name: string;
};

export type PullRequestComment = {
  author: string;
  avatarUrl: string;
  body: string;
  context?: string;
  createdAt: string;
  key: string;
  reviewId?: number;
  updatedAt?: string;
};

export type PullRequestReviewThreadComment = {
  author: string;
  avatarUrl: string;
  body: string;
  createdAt: string;
  id: number;
  updatedAt: string;
  url: string;
};

export type PullRequestReviewThread = {
  canReply: boolean;
  canResolve: boolean;
  canUnresolve: boolean;
  comments: PullRequestReviewThreadComment[];
  diffHunk?: string;
  id?: string;
  isOutdated: boolean;
  isResolved: boolean;
  line?: number;
  originalLine?: number;
  originalStartLine?: number;
  path: string;
  resolvedBy?: string;
  reviewId?: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  statusKnown: boolean;
};

export type PullRequestCommit = {
  author: string;
  message: string;
  sha: string;
};

export type PullRequestMergeMethod = "merge" | "rebase" | "squash";

export type PullRequestReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export type PullRequestWorkflowRun = {
  conclusion: string | null;
  id: number;
  name: string;
  status: string;
  url: string;
};

export type PullRequestTimelineEvent = {
  createdAt: string;
  key: string;
  text: string;
};

export type PullRequestWorkspace = {
  canClose: boolean;
  canComment: boolean;
  canEditBody: boolean;
  canManageMerge: boolean;
  canMarkReady: boolean;
  canMerge: boolean;
  canReview: boolean;
  comments: PullRequestComment[];
  commits: PullRequestCommit[];
  commitsUnavailable: boolean;
  conversationUnavailable: boolean;
  draft: boolean;
  hasGitHubAccess: boolean;
  mergeMethods: PullRequestMergeMethod[];
  reviewThreads: PullRequestReviewThread[];
  state: "closed" | "merged" | "open";
  timelineEvents: PullRequestTimelineEvent[];
  workflowRuns: PullRequestWorkflowRun[];
};

export type PullRequestAction =
  | { action: "comment"; body: string }
  | { action: "reply"; body: string; commentId: number }
  | { action: "close" }
  | { action: "edit-body"; body: string }
  | { action: "edit-title"; title: string }
  | { action: "merge"; method: PullRequestMergeMethod }
  | { action: "ready" }
  | { action: "review"; body: string; event: PullRequestReviewEvent }
  | { action: "resolve-thread"; threadId: string }
  | { action: "unresolve-thread"; threadId: string };
