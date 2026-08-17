import { buildCallTree, buildIndex, diffTrees, extractFunctions, treeHasChanges, type CallNode, type DiffNode, type FunctionInfo } from "calldiff";
// Bundle Rust's grammar and matching runtime so calldiff does not install them during a request.
import "tree-sitter";
import "tree-sitter-rust";
import { getCallDiffSource } from "@/lib/github";
import type { CallDiffDocument, CallDiffEntry, CallDiffFile, CallDiffNode, CallDiffStatus } from "@/types/call-diff";

type IndexedFunction = {
  fileKey: string;
  info: FunctionInfo;
  key: string;
};

const CALL_DIFF_ENTRY_LIMIT = 12;
const CALL_DIFF_MAX_DEPTH = 4;

/** Returns a rename-stable identity for one exported entrypoint in a changed file. */
function functionId(fileKey: string, symbol: string): string {
  return `${fileKey}\0${symbol}`;
}

/** Marks a whole entrypoint when it exists on only one side of the review. */
function markTree(node: CallNode, status: Exclude<CallDiffStatus, "same">): DiffNode {
  return { ...node, children: node.children.map((child) => markTree(child, status)), status };
}

/** Reads one displayable source line without treating an unavailable snapshot as an error. */
function sourceLineAt(source: string | undefined, line: number): string {
  return source?.split("\n")[Math.max(0, line - 1)]?.trim() ?? "";
}

/** Adapts calldiff's source locations and structural states to the viewer's JSON contract. */
function toCallDiffNode(node: DiffNode, beforeSources: ReadonlyMap<string, string>, afterSources: ReadonlyMap<string, string>, fallbackFile: string): CallDiffNode {
  const file = node.file ?? fallbackFile;
  const line = node.line ?? 1;
  const source = node.status === "removed" ? beforeSources.get(file) : afterSources.get(file);

  return {
    children: node.children.map((child) => toCallDiffNode(child, beforeSources, afterSources, fallbackFile)),
    file,
    kind: node.kind ?? "call",
    key: node.key,
    label: node.label,
    line,
    snippet: sourceLineAt(source, line) || node.label,
    status: node.status,
  };
}

/** Builds an entry with its definition first so duplicate names keep the selected body. */
function treeForEntry(entry: FunctionInfo, functions: FunctionInfo[]): CallNode {
  const index = buildIndex([entry, ...functions.filter((candidate) => candidate !== entry)]);
  return buildCallTree(entry.key, index, CALL_DIFF_MAX_DEPTH);
}

/** Extracts one snapshot through calldiff while letting an unreadable file leave the rest of the review usable. */
function extractSnapshotFunctions(
  fileKey: string,
  source: { path: string; text: string } | undefined,
  unparsedFiles: Set<string>,
  functions: IndexedFunction[],
  sources: Map<string, string>,
): void {
  if (!source) return;

  sources.set(source.path, source.text);
  try {
    for (const info of extractFunctions(source.path, source.text)) {
      functions.push({ fileKey, info, key: functionId(fileKey, info.key) });
    }
  } catch {
    // Report unavailable grammars instead of misrepresenting them as an empty call flow.
    unparsedFiles.add(source.path);
  }
}

/** Reads calldiff's AST call stacks from both GitHub revisions and groups changed entries by file. */
export async function getCallDiffDocument(source: string[], token?: string): Promise<CallDiffDocument> {
  const snapshot = await getCallDiffSource(source, token);
  const beforeFunctions: IndexedFunction[] = [];
  const afterFunctions: IndexedFunction[] = [];
  const beforeSources = new Map<string, string>();
  const afterSources = new Map<string, string>();
  const unparsedFiles = new Set<string>();

  for (const file of snapshot.files) {
    extractSnapshotFunctions(file.key, file.before, unparsedFiles, beforeFunctions, beforeSources);
    extractSnapshotFunctions(file.key, file.after, unparsedFiles, afterFunctions, afterSources);
  }

  const beforeByKey = new Map(beforeFunctions.map((entry) => [entry.key, entry]));
  const afterByKey = new Map(afterFunctions.map((entry) => [entry.key, entry]));
  const beforeInfos = beforeFunctions.map((entry) => entry.info);
  const afterInfos = afterFunctions.map((entry) => entry.info);
  const entriesByFile = new Map<string, Array<CallDiffEntry & { exported: boolean }>>();

  for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
    const before = beforeByKey.get(key);
    const after = afterByKey.get(key);
    const beforeTree = before && treeForEntry(before.info, beforeInfos);
    const afterTree = after && treeForEntry(after.info, afterInfos);
    if (!beforeTree && !afterTree) continue;

    const diff = beforeTree && afterTree
      ? diffTrees(beforeTree, afterTree)
      : markTree(beforeTree ?? afterTree!, beforeTree ? "removed" : "added");
    if (!treeHasChanges(diff)) continue;

    const fileKey = after?.fileKey ?? before!.fileKey;
    const entries = entriesByFile.get(fileKey) ?? [];
    entries.push({
      exported: Boolean(before?.info.exported || after?.info.exported),
      key,
      tree: toCallDiffNode(diff, beforeSources, afterSources, before?.info.file ?? after!.info.file),
    });
    entriesByFile.set(fileKey, entries);
  }

  const files: CallDiffFile[] = [];
  let entryLimitReached = false;

  for (const file of snapshot.files) {
    const fileEntries = entriesByFile.get(file.key) ?? [];
    const exportedEntries = fileEntries.filter((entry) => entry.exported);
    const visibleEntries = (exportedEntries.length ? exportedEntries : fileEntries)
      .sort((left, right) => left.tree.label.localeCompare(right.tree.label))
      .slice(0, CALL_DIFF_ENTRY_LIMIT);
    if (!visibleEntries.length) continue;

    entryLimitReached ||= visibleEntries.length < (exportedEntries.length || fileEntries.length);
    files.push({
      additions: file.additions,
      deletions: file.deletions,
      entries: visibleEntries.map((entry) => ({ key: entry.key, tree: entry.tree })),
      path: file.key,
    });
  }

  return {
    files,
    filesAnalyzed: snapshot.files.length,
    fromRef: snapshot.fromRef,
    ignoredFiles: snapshot.ignoredFiles,
    toRef: snapshot.toRef,
    truncated: snapshot.truncated || entryLimitReached,
    unparsedFiles: unparsedFiles.size,
  };
}
