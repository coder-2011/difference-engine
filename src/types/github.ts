export type PullRequestSummary = {
  author: string;
  avatarUrl: string;
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
  sourceUrl: string;
  title: string;
};
