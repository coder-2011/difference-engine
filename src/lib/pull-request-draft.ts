export type PullRequestDraft = { base: string; value: string };

export function draftStatus(draft: PullRequestDraft, latest: string): "unchanged" | "conflict" | "save" {
  if (draft.value === draft.base || draft.value === latest) return "unchanged";
  return draft.base === latest ? "save" : "conflict";
}
