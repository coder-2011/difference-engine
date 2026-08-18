"use client";

import { AlertCircle, ChevronDown, ChevronRight, ClipboardCopy, ExternalLink, FileText, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import { Fragment, type MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { CallDiffDocument, CallDiffNode } from "@/types/call-diff";
import { configureDiffHighlighting } from "@/lib/diff-highlighting";
import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";

configureDiffHighlighting();

type CallDiffViewerProps = {
  onSelect?: (selection: CallDiffSelection) => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  source: string[];
};

export type CallDiffSelection = {
  file: string;
  line: number;
  text: string;
  x: number;
  y: number;
};

type CallDiffState =
  | { status: "loading" }
  | { document: CallDiffDocument; status: "ready" }
  | { error: string; status: "error" };

type SyntaxToken = {
  color?: string;
  content: string;
};

type CallDiffDisplayStatus = "added" | "changed" | "removed" | "same";

/** Builds a viewer link for the exact source revision and location used by one call-tree node. */
function sourceLocationUrl(source: string[], ref: string, file: string, line: number): string {
  const repository = source.slice(0, 2).map(encodeURIComponent).join("/");
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `/${repository}/blob/${encodeURIComponent(ref)}/${path}#L${line}`;
}

/** Colors retained parents by the added and removed calls they contain. */
function displayStatus(node: CallDiffNode): CallDiffDisplayStatus {
  if (node.status !== "same") return node.status;

  const childStatuses = node.children.map(displayStatus);
  const hasAdded = childStatuses.some((status) => status === "added" || status === "changed");
  const hasRemoved = childStatuses.some((status) => status === "removed" || status === "changed");
  if (hasAdded && hasRemoved) return "changed";
  if (hasAdded) return "added";
  if (hasRemoved) return "removed";
  return "same";
}

/** Keeps only call-tree branches that lead to a changed call. */
function treeHasChanges(node: CallDiffNode): boolean {
  return node.status !== "same" || node.children.some(treeHasChanges);
}

const LANGUAGE_MAP = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cu: "cpp",
  cuh: "cpp",
  cxx: "cpp",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  go: "go",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  pyi: "python",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  html: "html",
  css: "css",
  scss: "css",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  zig: "zig",
  lua: "lua",
} satisfies Record<string, string>;

/** Resolves the proper Shiki-supported language ID for a source file. */
function resolveLanguage(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  // SAFETY: `ext` is only used to index a static extension map and missing keys fallback to fileName detection.
  const mappedLanguage = LANGUAGE_MAP[ext as keyof typeof LANGUAGE_MAP] as string | undefined;
  return mappedLanguage || getFiletypeFromFileName(file) || "text";
}

const CALL_CODE_CACHE = new Map<string, SyntaxToken[][]>();

/** Renders a Call Flow source line with the same shared Shiki theme as the main diff. */
function HighlightedCallCode({ file, text }: { file: string; text: string }) {
  const language = resolveLanguage(file);
  const key = `${language}\0${text}`;
  const cachedTokens = CALL_CODE_CACHE.get(key);
  const [highlight, setHighlight] = useState<{ key: string; tokens: SyntaxToken[][] } | null>(
    () => (cachedTokens ? { key, tokens: cachedTokens } : null),
  );

  useEffect(() => {
    if (CALL_CODE_CACHE.has(key) || !text) return;

    let cancelled = false;

    void getSharedHighlighter({
      langs: [language],
      preferredHighlighter: "shiki-wasm",
      themes: ["pierre-dark"],
    })
      .then((highlighter) =>
        highlighter.codeToTokens(text, {
          lang: language,
          theme: "pierre-dark",
        }),
      )
      .then((result) => {
        if (CALL_CODE_CACHE.size >= 2000) {
          const firstKey = CALL_CODE_CACHE.keys().next().value;
          if (firstKey) CALL_CODE_CACHE.delete(firstKey);
        }
        CALL_CODE_CACHE.set(key, result.tokens);
        if (!cancelled) setHighlight({ key, tokens: result.tokens });
      })
      .catch(() => {
        // Fall back to un-highlighted text if grammar is missing
      });

    return () => {
      cancelled = true;
    };
  }, [key, language, text]);

  const activeTokens = cachedTokens ?? (highlight?.key === key ? highlight.tokens : undefined);

  return (
    <code>
      {activeTokens
        ? activeTokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {line.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  style={{
                    color: token.color || "#e2e2e8",
                    fontStyle: token.fontStyle === 1 ? "italic" : undefined,
                    fontWeight: token.fontStyle === 2 ? "bold" : undefined,
                  }}
                >
                  {token.content}
                </span>
              ))}
              {lineIndex < activeTokens.length - 1 ? "\n" : null}
            </Fragment>
          ))
        : text}
    </code>
  );
}

/** Renders one recursive call-flow node with source navigation and selection actions. */
function CallDiffNodeRow({
  depth = 0,
  fromRef,
  node,
  onSelect,
  source,
  toRef,
}: {
  depth?: number;
  fromRef: string;
  node: CallDiffNode;
  onSelect?: (selection: CallDiffSelection) => void;
  source: string[];
  toRef: string;
}) {
  const ref = node.status === "removed" ? fromRef : toRef;
  const location = `${node.file}:${node.line}`;
  const sourceLine = node.snippet.trim() || node.label;
  const status = displayStatus(node);
  const children = node.children.filter(treeHasChanges);

  /** Places one Call Flow source line into the existing annotation and Ask Diffs selection flow. */
  function selectNode(event: ReactMouseEvent<HTMLButtonElement>): void {
    onSelect?.({
      file: node.file,
      line: node.line,
      text: node.snippet,
      x: event.clientX,
      y: event.clientY,
    });
  }

  return (
    <li className={`call-diff-node ${node.kind} ${status}`}>
      <div className="call-diff-node-line">
        <div className="call-diff-node-gutter">
          <span aria-hidden="true" className="call-diff-node-line-number">{node.line}</span>
        </div>
        <div className="call-diff-node-content">
          <div className="call-diff-tree-indent" aria-hidden="true">
            {Array.from({ length: depth }, (_, i) => (
              <span className="call-diff-indent-guide" key={i} />
            ))}
          </div>
          {onSelect ? (
            <button className="call-diff-node-select" onClick={selectNode} title={`Ask or annotate ${location}`} type="button">
              <HighlightedCallCode file={node.file} text={sourceLine} />
            </button>
          ) : (
            <a className="call-diff-node-link" href={sourceLocationUrl(source, ref, node.file, node.line)} title={`Open ${location}`}>
              <HighlightedCallCode file={node.file} text={sourceLine} />
            </a>
          )}
          {onSelect && (
            <a aria-label={`Open ${location}`} className="call-diff-node-source" href={sourceLocationUrl(source, ref, node.file, node.line)} title={`Open ${location}`}>
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      </div>
      {children.length > 0 && (
        <ol className="call-diff-subtree">
          {children.map((child, index) => (
            <CallDiffNodeRow
              depth={depth + 1}
              fromRef={fromRef}
              key={`${child.key}-${child.line}-${index}`}
              node={child}
              onSelect={onSelect}
              source={source}
              toRef={toRef}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

/** Shows lazy call-flow analysis and exposes one bounded source line for each selected node. */
export function CallDiffViewer({ onSelect, onToggleSidebar, sidebarOpen, source }: CallDiffViewerProps) {
  const sourcePath = useMemo(() => source.map(encodeURIComponent).join("/"), [source]);
  const [state, setState] = useState<CallDiffState>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [rawCallDiffCopyStatus, setRawCallDiffCopyStatus] = useState("");

  /** Resets the visible request state before fetching this source again. */
  function retryCallDiff(): void {
    setState({ status: "loading" });
    setRetry((value) => value + 1);
  }

  useEffect(() => {
    const controller = new AbortController();

    /** Reads the server-only analysis once and ignores a response from a superseded review. */
    async function loadCallDiff(): Promise<void> {
      try {
        // Bypass the prior document shape during the brief public edge-cache window after this view ships.
        const response = await fetch(`/api/call-diff/${sourcePath}?v=2`, { signal: controller.signal });
        // SAFETY: The same-origin Call Flow endpoint returns this document or its error envelope.
        const result = await response.json() as CallDiffDocument & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "The call flow could not be loaded");
        setState({ document: result, status: "ready" });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ error: error instanceof Error ? error.message : "The call flow could not be loaded", status: "error" });
      }
    }

    void loadCallDiff();
    return () => controller.abort();
  }, [retry, sourcePath]);

  if (state.status === "loading") {
    return <section aria-busy="true" className="call-diff-loading"><LoaderCircle className="spinner" size={19} /><strong>Tracing changed call flow</strong><span>Reading the before and after source snapshots…</span></section>;
  }

  if (state.status === "error") {
    return (
      <section className="call-diff-error">
        <AlertCircle size={18} />
        <div><strong>Couldn’t trace this call flow</strong><span>{state.error}</span></div>
        <button onClick={retryCallDiff} type="button"><RefreshCw size={13} /> Retry</button>
      </section>
    );
  }

  const document = state.document;
  const additions = document.files.reduce((total, file) => total + file.additions, 0);
  const deletions = document.files.reduce((total, file) => total + file.deletions, 0);
  const changedLines = additions + deletions;

  /** Copies the exact Call Flow API document so its intersection is available outside the viewer. */
  async function copyRawCallDiff(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(document, null, 2));
      setRawCallDiffCopyStatus("Copied");
      window.setTimeout(() => setRawCallDiffCopyStatus(""), 2_000);
    } catch {
      setRawCallDiffCopyStatus("Copy failed");
    }
  }

  return (
    <section className="call-diff-viewer" aria-label="Call flow">
      <header className="call-diff-toolbar viewer-toolbar">
        <div className="change-stats">
          <span><FileText size={13} /> {document.files.length}/{document.filesAnalyzed} files</span>
          <span>{changedLines.toLocaleString()} LOC</span>
          <span className="additions">+{additions.toLocaleString()}</span>
          <span className="deletions">−{deletions.toLocaleString()}</span>
        </div>
        <div className="viewer-actions">
          <button aria-label="Copy raw call diff as JSON" onClick={() => void copyRawCallDiff()} title="Copy raw call diff" type="button"><ClipboardCopy size={14} /> {rawCallDiffCopyStatus || "Copy raw call diff"}</button>
          <button className="sidebar-toggle" onClick={onToggleSidebar} title="Toggle file tree" type="button">
            {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button aria-expanded={!collapsed} className="collapse-toggle" onClick={() => setCollapsed((value) => !value)} type="button">
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
            {collapsed ? "Expand files" : "Collapse files"}
          </button>
        </div>
      </header>

      {document.files.length ? (
        <div className="call-diff-entry-list">
          {document.files.map((file) => (
            <article className="call-diff-entry" data-call-diff-file={file.path} key={file.path}>
              <header className="call-diff-file-header">
                <FileText size={14} />
                <code title={file.path}>{file.path}</code>
                <span>{(file.additions + file.deletions).toLocaleString()} LOC</span>
                <span className="additions">+{file.additions.toLocaleString()}</span>
                <span className="deletions">−{file.deletions.toLocaleString()}</span>
              </header>
              {!collapsed && <div className="call-diff-file-body">
                {file.entries.map((entry) => <ol className="call-diff-tree" key={entry.key}><CallDiffNodeRow fromRef={document.fromRef} node={entry.tree} onSelect={onSelect} source={source} toRef={document.toRef} /></ol>)}
              </div>}
            </article>
          ))}
        </div>
      ) : (
        <div className="call-diff-empty"><Network size={19} /><strong>{document.unparsedFiles ? "Call flow could not parse every changed source file" : "No changed call flow found"}</strong><span>{document.unparsedFiles ? `${document.unparsedFiles} source ${document.unparsedFiles === 1 ? "file was" : "files were"} unavailable to the parser.` : "The changed supported files do not add, remove, or rewire a parsed call."}</span></div>
      )}
    </section>
  );
}
