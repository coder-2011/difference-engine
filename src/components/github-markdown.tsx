import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { ComponentPropsWithoutRef } from "react";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { HighlightedCode, MarkdownPre } from "@/components/highlighted-code";
import { isString } from "@/lib/json";

type GitHubMarkdownProps = {
  children: string;
  codeReferencePaths?: readonly string[];
  onCodeReference?: (reference: CodeReference) => void;
};

type MarkdownNode = {
  children?: MarkdownNode[];
  data?: { hProperties?: { className?: string[] } };
  type?: string;
  url?: string;
  value?: string;
};

export type CodeReference = {
  endLineNumber?: number;
  lineNumber: number;
  path: string;
};

const GITHUB_ALERT = /^\[!(CAUTION|IMPORTANT|NOTE|TIP|WARNING)\]\s*\n?/;
const CODE_REFERENCE = /^([\w./-]+):([1-9]\d*)(?:-([1-9]\d*))?$/;
const CODE_REFERENCE_TEXT = /(?:^|[^\w./-])([\w./-]+):([1-9]\d*)(?:-([1-9]\d*))?/g;
const CODE_REFERENCE_PREFIX = "#diffs-code-location=";

/** Adds alert classes to GitHub's blockquote markers before Markdown becomes HTML. */
function githubAlerts() {
  return markGitHubAlerts;
}

/** Walks Markdown nodes and replaces each GitHub alert marker with semantic styling data. */
function markGitHubAlerts(node: MarkdownNode): void {
  const firstParagraph = node.type === "blockquote" ? node.children?.[0] : undefined;
  const marker = firstParagraph?.type === "paragraph" ? firstParagraph.children?.[0] : undefined;
  const markerValue = marker?.type === "text" && isString(marker.value) ? marker.value : undefined;
  const alert = markerValue?.match(GITHUB_ALERT);

  if (alert && marker && markerValue) {
    marker.value = markerValue.slice(alert[0].length);
    const type = alert[1].toLowerCase();
    node.data = {
      ...node.data,
      hProperties: {
        ...node.data?.hProperties,
        className: ["github-alert", `github-alert-${type}`],
      },
    };
  }

  node.children?.forEach(markGitHubAlerts);
}

/** Parses one repository-relative location only when the viewer can reveal its file. */
export function parseCodeReference(value: string, paths: ReadonlySet<string>): CodeReference | undefined {
  const match = value.match(CODE_REFERENCE);
  if (!match || !paths.has(match[1])) return undefined;

  const lineNumber = Number(match[2]);
  const endLineNumber = match[3] ? Number(match[3]) : undefined;
  if (endLineNumber && endLineNumber < lineNumber) return undefined;
  return { endLineNumber, lineNumber, path: match[1] };
}

/** Encodes one recognized location in a private fragment that the chat link handler consumes. */
function codeReferenceUrl(reference: CodeReference): string {
  const end = reference.endLineNumber ? `-${reference.endLineNumber}` : "";
  return `${CODE_REFERENCE_PREFIX}${encodeURIComponent(`${reference.path}:${reference.lineNumber}${end}`)}`;
}

/** Splits ordinary Markdown text into unchanged text and clickable source-location links. */
function linkCodeReferenceText(value: string, paths: ReadonlySet<string>): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const matcher = new RegExp(CODE_REFERENCE_TEXT.source, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(value))) {
    const reference = parseCodeReference(`${match[1]}:${match[2]}${match[3] ? `-${match[3]}` : ""}`, paths);
    if (!reference) continue;

    const start = match.index + match[0].indexOf(match[1]);
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    const label = match[0].slice(start - match.index);
    nodes.push({ children: [{ type: "text", value: label }], type: "link", url: codeReferenceUrl(reference) });
    cursor = start + label.length;
  }

  if (!nodes.length) return [{ type: "text", value }];
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

/** Turns visible `path:line` references into links without touching code blocks or existing links. */
function githubCodeReferences(paths: readonly string[]) {
  /** Installs the immutable visible-path set before Unified begins walking one Markdown tree. */
  return function installCodeReferences() {
    const visiblePaths = new Set(paths);

    /** Replaces visible source references with links without touching code blocks or existing links. */
    return function markCodeReferences(node: MarkdownNode): void {
      if (!node.children || node.type === "code" || node.type === "link") return;

      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && isString(child.value)) return linkCodeReferenceText(child.value, visiblePaths);
        if (child.type === "inlineCode" && isString(child.value)) {
          const reference = parseCodeReference(child.value, visiblePaths);
          return reference ? [{ children: [child], type: "link", url: codeReferenceUrl(reference) }] : [child];
        }
        markCodeReferences(child);
        return [child];
      });
    };
  };
}

/** Handles private source-location links without changing normal Markdown links. */
function CodeReferenceLink({ codeReferencePaths, href, onCodeReference, ...props }: ComponentPropsWithoutRef<"a"> & Pick<GitHubMarkdownProps, "codeReferencePaths" | "onCodeReference">) {
  let reference: CodeReference | undefined;
  if (href?.startsWith(CODE_REFERENCE_PREFIX)) {
    try {
      reference = parseCodeReference(decodeURIComponent(href.slice(CODE_REFERENCE_PREFIX.length)), new Set(codeReferencePaths));
    } catch {
      // A malformed fragment remains a normal inert link.
    }
  }

  if (!reference || !onCodeReference) return <a href={href} {...props} />;
  return <a href={href} onClick={(event) => { event.preventDefault(); onCodeReference(reference); }} title={`Show ${reference.path}:${reference.lineNumber} in the diff`} {...props} />;
}

/** Preserves table layout while giving wide Markdown tables a contained horizontal viewport. */
function MarkdownTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
  return <div className="markdown-table"><table {...props}>{children}</table></div>;
}

const MARKDOWN_COMPONENTS = { code: HighlightedCode, pre: MarkdownPre, table: MarkdownTable };
const MARKDOWN_PLUGINS = [remarkGfm, githubAlerts];
const REHYPE_PLUGINS = [rehypeRaw];

/** Renders GitHub-flavored Markdown, including tables and native GitHub alert callouts. */
export const GitHubMarkdown = memo(function GitHubMarkdown({ children, codeReferencePaths, onCodeReference }: GitHubMarkdownProps) {
  const markdownComponents = useMemo(() => {
    if (!onCodeReference) return MARKDOWN_COMPONENTS;
    return {
      ...MARKDOWN_COMPONENTS,
      a: (props: ComponentPropsWithoutRef<"a">) => <CodeReferenceLink {...props} codeReferencePaths={codeReferencePaths} onCodeReference={onCodeReference} />,
    };
  }, [codeReferencePaths, onCodeReference]);
  const markdownPlugins = useMemo(
    () => onCodeReference ? [...MARKDOWN_PLUGINS, githubCodeReferences(codeReferencePaths ?? [])] : MARKDOWN_PLUGINS,
    [codeReferencePaths, onCodeReference],
  );

  return (
    <ReactMarkdown
      components={markdownComponents}
      rehypePlugins={REHYPE_PLUGINS}
      remarkPlugins={markdownPlugins}
    >
      {children}
    </ReactMarkdown>
  );
});
