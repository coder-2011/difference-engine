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
  deletions?: number;
  description?: string;
  headLabel?: string;
  repository: string;
  pullRequest?: PullRequestWorkspace;
  sourceUrl: string;
  title: string;
};

export type PullRequestComment = {
  author: string;
  avatarUrl: string;
  body: string;
  context?: string;
  createdAt: string;
  key: string;
};

export type PullRequestMergeMethod = "merge" | "rebase" | "squash";

export type PullRequestWorkflowRun = {
  canRerun: boolean;
  conclusion: string | null;
  id: number;
  name: string;
  status: string;
  url: string;
};

export type PullRequestWorkspace = {
  canClose: boolean;
  canComment: boolean;
  canMerge: boolean;
  comments: PullRequestComment[];
  conversationUnavailable: boolean;
  mergeMethods: PullRequestMergeMethod[];
  state: "closed" | "merged" | "open";
  workflowRuns: PullRequestWorkflowRun[];
};

export type PullRequestAction =
  | { action: "comment"; body: string }
  | { action: "close" }
  | { action: "merge"; method: PullRequestMergeMethod }
  | { action: "rerun"; runId: number };
