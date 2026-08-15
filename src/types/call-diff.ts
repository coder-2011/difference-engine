export type CallDiffStatus = "added" | "removed" | "same";

export type CallDiffNode = {
  children: CallDiffNode[];
  file: string;
  kind: "branch" | "call";
  key: string;
  label: string;
  line: number;
  snippet: string;
  status: CallDiffStatus;
};

export type CallDiffEntry = {
  key: string;
  tree: CallDiffNode;
};

export type CallDiffFile = {
  additions: number;
  deletions: number;
  entries: CallDiffEntry[];
  path: string;
};

export type CallDiffDocument = {
  files: CallDiffFile[];
  filesAnalyzed: number;
  fromRef: string;
  ignoredFiles: number;
  toRef: string;
  truncated: boolean;
};
