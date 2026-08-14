"use client";

import { Search, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RepositoryFile } from "@/types/github";

type RepositorySearchMode = "files" | "regex" | "text";

type RepositorySearchResult = {
  lineNumber?: number;
  path: string;
  preview?: string;
};

type RepositorySearchProps = {
  files: RepositoryFile[];
  onOpenResult: (result: RepositorySearchResult) => void;
};

const RESULT_LIMIT = 80;

/** Scores ordered filename characters while rewarding compact and basename matches. */
function fuzzyFileScore(path: string, query: string): number | null {
  const candidate = path.toLowerCase();
  const needle = query.toLowerCase();
  const exactIndex = candidate.indexOf(needle);
  if (exactIndex >= 0) return exactIndex + (candidate.length - needle.length) / 100;

  let cursor = 0;
  let score = 0;

  for (const character of needle) {
    const index = candidate.indexOf(character, cursor);
    if (index < 0) return null;
    score += index - cursor;
    cursor = index + 1;
  }

  const basename = candidate.split("/").at(-1) ?? candidate;
  if (fuzzyFileScoreInName(basename, needle)) score -= 3;
  return score + (candidate.length - needle.length) / 100;
}

/** Checks a basename for the same ordered characters without recursively scoring it. */
function fuzzyFileScoreInName(name: string, query: string): boolean {
  let cursor = 0;

  for (const character of query) {
    const index = name.indexOf(character, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }

  return true;
}

/** Returns the best fuzzy filename results in stable score and path order. */
function searchFilenames(files: RepositoryFile[], query: string): RepositorySearchResult[] {
  const matches: Array<RepositorySearchResult & { score: number }> = [];

  for (const file of files) {
    const score = fuzzyFileScore(file.name, query);
    if (score !== null) matches.push({ path: file.name, score });
  }

  matches.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path));
  return matches.slice(0, RESULT_LIMIT);
}

/** Builds a short line preview around the content match instead of truncating it away. */
function matchPreview(line: string, column: number): string {
  const start = Math.max(0, column - 60);
  return line.slice(start, start + 180).trim();
}

/** Searches every text line with either a literal substring or one user regex. */
function searchContents(
  files: RepositoryFile[],
  query: string,
  mode: "regex" | "text",
): { error?: string; results: RepositorySearchResult[] } {
  let pattern: RegExp | undefined;

  if (mode === "regex") {
    try {
      pattern = new RegExp(query);
    } catch {
      return { error: "That regular expression is not valid.", results: [] };
    }
  }

  const results: RepositorySearchResult[] = [];
  const literal = query.toLowerCase();

  for (const file of files) {
    const lines = file.contents.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const column = pattern ? line.search(pattern) : line.toLowerCase().indexOf(literal);
      if (column < 0) continue;

      results.push({
        lineNumber: index + 1,
        path: file.name,
        preview: matchPreview(line, column),
      });
      if (results.length === RESULT_LIMIT) return { results };
    }
  }

  return { results };
}

/** Provides repository-wide filename, literal-text, and regex navigation. */
export function RepositorySearch({ files, onOpenResult }: RepositorySearchProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RepositorySearchMode>("files");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useMemo(() => {
    if (!query) return { results: [] };
    if (mode === "files") return { results: searchFilenames(files, query) };
    return searchContents(files, query, mode);
  }, [files, mode, query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /** Opens the palette without discarding the previous search. */
  function showSearch(): void {
    setOpen(true);
  }

  /** Closes the palette while preserving its query for quick return. */
  function hideSearch(): void {
    setOpen(false);
  }

  /** Changes the search interpretation from the clicked mode button. */
  function changeMode(event: MouseEvent<HTMLButtonElement>): void {
    setMode(event.currentTarget.value as RepositorySearchMode);
    setActiveIndex(0);
  }

  /** Updates the query and returns keyboard selection to the first match. */
  function changeQuery(event: ChangeEvent<HTMLInputElement>): void {
    setQuery(event.currentTarget.value);
    setActiveIndex(0);
  }

  /** Opens the clicked match at its file and optional line. */
  function openResult(event: MouseEvent<HTMLButtonElement>): void {
    const result = search.results[Number(event.currentTarget.value)];
    if (!result) return;
    onOpenResult(result);
    setOpen(false);
  }

  /** Supports Escape, arrows, and Enter without trapping normal text entry. */
  function navigateResults(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (!search.results.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(activeIndex + 1, search.results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpenResult(search.results[activeIndex]);
      setOpen(false);
    }
  }

  return (
    <div className="repository-search">
      <button
        className="repository-tool-trigger"
        type="button"
        aria-expanded={open}
        onClick={showSearch}
      >
        <Search size={14} /> Search repository
      </button>

      {open && (
        <div className="repository-search-panel" role="dialog" aria-label="Search repository" onKeyDown={navigateResults}>
          <div className="repository-search-input">
            <Search size={15} />
            <input
              ref={inputRef}
              aria-label="Search query"
              placeholder={mode === "files" ? "Fuzzy filename…" : mode === "text" ? "Exact text…" : "Regular expression…"}
              value={query}
              onChange={changeQuery}
            />
            <button type="button" aria-label="Close search" onClick={hideSearch}><X size={14} /></button>
          </div>
          <div className="repository-search-modes" role="tablist" aria-label="Search mode">
            <button className={mode === "files" ? "active" : ""} type="button" role="tab" aria-selected={mode === "files"} value="files" onClick={changeMode}>Files</button>
            <button className={mode === "text" ? "active" : ""} type="button" role="tab" aria-selected={mode === "text"} value="text" onClick={changeMode}>Text</button>
            <button className={mode === "regex" ? "active" : ""} type="button" role="tab" aria-selected={mode === "regex"} value="regex" onClick={changeMode}>Regex</button>
          </div>
          <div className="repository-search-results">
            {search.error ? (
              <p className="repository-search-message" role="alert">{search.error}</p>
            ) : !query ? (
              <p className="repository-search-message">Search all {files.length} loaded code files.</p>
            ) : !search.results.length ? (
              <p className="repository-search-message">No matches found.</p>
            ) : search.results.map((result, index) => (
              <button
                className={index === activeIndex ? "active" : ""}
                type="button"
                value={index}
                key={`${result.path}:${result.lineNumber ?? 0}`}
                onClick={openResult}
              >
                <span><strong>{result.path}</strong>{result.lineNumber && <small>:{result.lineNumber}</small>}</span>
                {result.preview && <code>{result.preview}</code>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
