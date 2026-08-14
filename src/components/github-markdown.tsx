import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode, MarkdownPre } from "@/components/highlighted-code";

type GitHubMarkdownProps = {
  children: string;
};

type MarkdownNode = {
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
  type?: string;
  value?: string;
};

const GITHUB_ALERT = /^\[!(CAUTION|IMPORTANT|NOTE|TIP|WARNING)\]\s*\n?/;

/** Adds alert classes to GitHub's blockquote markers before Markdown becomes HTML. */
function githubAlerts() {
  return (tree: unknown) => markGitHubAlerts(tree);
}

/** Walks Markdown nodes and replaces each GitHub alert marker with semantic styling data. */
function markGitHubAlerts(node: unknown): void {
  if (!node || typeof node !== "object") return;

  const markdownNode = node as MarkdownNode;
  const firstParagraph = markdownNode.type === "blockquote" ? markdownNode.children?.[0] : undefined;
  const marker = firstParagraph?.type === "paragraph" ? firstParagraph.children?.[0] : undefined;
  const markerValue = marker?.type === "text" && typeof marker.value === "string" ? marker.value : undefined;
  const alert = markerValue?.match(GITHUB_ALERT);

  if (alert && marker && markerValue) {
    marker.value = markerValue.slice(alert[0].length);
    const type = alert[1].toLowerCase();
    markdownNode.data = {
      ...markdownNode.data,
      hProperties: {
        ...markdownNode.data?.hProperties,
        className: ["github-alert", `github-alert-${type}`],
      },
    };
  }

  markdownNode.children?.forEach(markGitHubAlerts);
}

// Reuse Markdown configuration so memoized messages have stable rendering inputs.
const MARKDOWN_COMPONENTS = { code: HighlightedCode, pre: MarkdownPre };
const MARKDOWN_PLUGINS = [remarkGfm, githubAlerts];

/** Renders GitHub-flavored Markdown, including tables and native GitHub alert callouts. */
export const GitHubMarkdown = memo(function GitHubMarkdown({ children }: GitHubMarkdownProps) {
  return (
    <ReactMarkdown
      components={MARKDOWN_COMPONENTS}
      remarkPlugins={MARKDOWN_PLUGINS}
      skipHtml
    >
      {children}
    </ReactMarkdown>
  );
});
