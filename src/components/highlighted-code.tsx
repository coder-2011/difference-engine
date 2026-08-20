"use client";

import { getFiletypeFromFileName, getSharedHighlighter, preloadHighlighter } from "@pierre/diffs";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Children, cloneElement, Fragment, isValidElement, useEffect, useState } from "react";
import { configureDiffHighlighting, highlighterLanguage } from "@/lib/diff-highlighting";

configureDiffHighlighting();

void preloadHighlighter({
  langs: ["bash", "c", "cpp", "diff", "go", "javascript", "json", "python", "rust", "tsx", "typescript"],
  preferredHighlighter: "shiki-js",
  themes: ["pierre-dark"],
}).catch(() => {
  // Individual blocks still load a grammar on demand if this preload is skipped.
});

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  c: "c",
  "c++": "cpp",
  cc: "cpp",
  console: "bash",
  cpp: "cpp",
  cxx: "cpp",
  css: "css",
  cu: "cpp",
  cuh: "cpp",
  cuda: "cpp",
  "cuda-c++": "cpp",
  "cuda-cpp": "cpp",
  diff: "diff",
  go: "go",
  html: "html",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  output: "text",
  patch: "diff",
  plaintext: "text",
  python: "python",
  py: "python",
  rs: "rust",
  rust: "rust",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  suggestion: "diff",
  text: "text",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const MAX_HIGHLIGHT_LENGTH = 20_000;
const HIGHLIGHT_CACHE = new Map<string, TokenLine[]>();
const MAX_CACHE_ENTRIES = 500;

type TokenLine = Array<{ color?: string; content: string }>;
type CodeProps = ComponentPropsWithoutRef<"code"> & {
  block?: boolean;
  node?: { properties?: { className?: string | string[] } };
};
type HighlightedResult = {
  language: string;
  source: string;
  tokens: TokenLine[];
};
type MarkdownCodeBlockProps = {
  children: React.ReactNode;
  className?: string;
  source: string;
};

/** Tokenizes one block through the same Pierre highlighter as annotation snippets. */
async function highlightTokens(source: string, language: string): Promise<TokenLine[]> {
  const cacheKey = `${language}\0${source}`;
  const cached = HIGHLIGHT_CACHE.get(cacheKey);
  if (cached) return cached;

  const lang = highlighterLanguage(language);
  const highlighter = await getSharedHighlighter({
    langs: [lang],
    preferredHighlighter: "shiki-js",
    themes: ["pierre-dark"],
  });
  const tokens = (await highlighter.codeToTokens(source, { lang, theme: "pierre-dark" })).tokens;
  if (HIGHLIGHT_CACHE.size >= MAX_CACHE_ENTRIES) {
    const firstKey = HIGHLIGHT_CACHE.keys().next().value;
    if (firstKey) HIGHLIGHT_CACHE.delete(firstKey);
  }
  HIGHLIGHT_CACHE.set(cacheKey, tokens);
  return tokens;
}

/** Joins React, HAST, or string class names before matching a fence language. */
function classNameText(className: unknown): string {
  if (typeof className === "string") return className;
  if (Array.isArray(className)) return className.filter((part) => typeof part === "string").join(" ");
  return "";
}

/** Maps a fenced-Markdown class name to a Pierre grammar, including path and citation fences. */
function supportedLanguage(className: unknown): string | null {
  const token = classNameText(className).match(/language-([^\s]+)/)?.[1]
    ?? classNameText(className).match(/highlight-source-([^\s]+)/)?.[1];
  if (!token) return null;

  const name = token.toLowerCase();
  const aliased = LANGUAGE_ALIASES[name];
  if (aliased && aliased !== "text") return highlighterLanguage(aliased);

  const fromPath = highlighterLanguage(getFiletypeFromFileName(token));
  if (fromPath !== "text") return fromPath;
  const fromExtension = highlighterLanguage(getFiletypeFromFileName(`file.${name}`));
  return fromExtension === "text" ? null : fromExtension;
}

/** Picks a grammar for unlabeled review fences from distinctive source tokens. */
function inferredLanguage(source: string): string | null {
  if (!source.trim()) return null;
  if (/^diff --git |\n@@ [+-]\d/m.test(source) || /^\s*[+-]{3} [ab]\//m.test(source)) return "diff";
  if (/\bstd::|\bnamespace\s+\w+|^\s*#\s*include\b|\bcuda[A-Z_]\w*|__global__|__device__|__host__|<<<|\btemplate\s*</m.test(source)) return "cpp";
  if (/\bfn\s+\w+|\blet\s+mut\b|\bimpl\s+\w+|\bpub(?:lic)?\s+(?:struct|enum|fn)\b/.test(source)) return "rust";
  if (/\bdef\s+\w+|^\s*from\s+\w+\s+import\b/m.test(source)) return "python";
  if (/\bexport\s+|:\s*(?:string|number|boolean)\b|\binterface\s+\w+/.test(source)) return /<\/|\/>/.test(source) ? "tsx" : "typescript";
  if (/\bfunc\s+\w+\(|^\s*package\s+\w+/m.test(source)) return "go";
  return "cpp";
}

/** Converts React's Markdown children into the exact source sent to the highlighter. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function codeText(children: CodeProps["children"]): string {
  return nodeText(children).replace(/\n$/, "");
}

/** Wraps code in a fence longer than any backtick run already inside it. */
function fencedMarkdown(source: string, className?: string): string {
  const language = classNameText(className).match(/language-([^\s]+)/)?.[1] ?? "";
  let fenceLength = 3;

  for (const match of source.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }

  const fence = "`".repeat(fenceLength);
  return `${fence}${language}\n${source}\n${fence}`;
}

/** Renders one fenced block with a control that copies valid Markdown source. */
function MarkdownCodeBlock({ children, className, source }: MarkdownCodeBlockProps) {
  /** Writes the original code and language fence instead of rendered DOM text. */
  async function copyMarkdown(): Promise<void> {
    if (!navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(fencedMarkdown(source, className));
    } catch {
      // Clipboard permission can be denied without affecting the rendered code.
    }
  }

  return (
    <div className="markdown-code-block">
      <button
        aria-label="Copy code as Markdown"
        className="markdown-code-copy"
        onClick={() => void copyMarkdown()}
        type="button"
      >
        Copy
      </button>
      {children}
    </div>
  );
}

/** Renders colored token spans for one highlighted fence. */
function HighlightedSource({ tokens }: { tokens: TokenLine[] }) {
  return (
    <pre className="highlighted-code">
      <code>
        {tokens.map((line, lineIndex) => (
          <Fragment key={lineIndex}>
            {line.map((token, tokenIndex) => (
              <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
            ))}
            {lineIndex < tokens.length - 1 ? "\n" : null}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}

/** Renders inline code normally and fenced code with Pierre syntax tokens. */
export function HighlightedCode({ block = false, children, className, node, ...props }: CodeProps) {
  const source = codeText(children);
  const fenceClass = className ?? node?.properties?.className;
  const isFence = block || Boolean(supportedLanguage(fenceClass)) || source.includes("\n");
  const language = supportedLanguage(fenceClass) ?? (isFence ? inferredLanguage(source) : null);
  const cachedTokens = language && source.length <= MAX_HIGHLIGHT_LENGTH
    ? HIGHLIGHT_CACHE.get(`${language}\0${source}`)
    : undefined;
  const [highlighted, setHighlighted] = useState<HighlightedResult | null>(null);

  useEffect(() => {
    const highlightedLanguage = language;
    if (!highlightedLanguage || source.length > MAX_HIGHLIGHT_LENGTH) return;

    let cancelled = false;

    void highlightTokens(source, highlightedLanguage)
      .then((tokens) => {
        if (!cancelled) setHighlighted({ language: highlightedLanguage, source, tokens });
      })
      .catch(() => {
        if (highlightedLanguage === "cpp" || cancelled) return;
        return highlightTokens(source, "cpp").then((tokens) => {
          if (!cancelled) setHighlighted({ language: "cpp", source, tokens });
        });
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });

    return () => {
      cancelled = true;
    };
  }, [language, source]);

  const tokens = cachedTokens
    ?? (highlighted && highlighted.source === source && (highlighted.language === language || highlighted.language === "cpp") ? highlighted.tokens : undefined);

  if (!isFence) return <code className={className} {...props}>{children}</code>;

  return (
    <MarkdownCodeBlock className={classNameText(fenceClass)} source={source}>
      {tokens ? <HighlightedSource tokens={tokens} /> : <pre><code className={className} {...props}>{children}</code></pre>}
    </MarkdownCodeBlock>
  );
}

/** Passes block context and any `pre` language class through to the code renderer. */
export function MarkdownPre({ children, className, lang }: ComponentPropsWithoutRef<"pre">) {
  const code = Children.toArray(children)[0];
  if (isValidElement<CodeProps>(code)) {
    const languageClass = classNameText(code.props.className) || classNameText(className) || (lang ? `language-${lang}` : "");
    return cloneElement(code, { block: true, className: languageClass || code.props.className });
  }

  return <pre className={className} lang={lang}>{children}</pre>;
}
