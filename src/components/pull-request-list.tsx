"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronUp, Search } from "lucide-react";
import { useState } from "react";
import type { PullRequestSummary } from "@/types/github";

const INITIAL_COUNT = 6;
const DATE_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

type PullRequestListProps = {
  pullRequests: PullRequestSummary[];
  variant?: "open" | "resolved";
};

/** Formats a GitHub timestamp into the compact date used on pull request cards. */
function relativeDate(value: string): string {
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);

  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return DATE_FORMAT.format(date);
}

/** Filters the signed-in user's pull requests and reveals more than the initial six on demand. */
export function PullRequestList({ pullRequests, variant = "open" }: PullRequestListProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  // Match the fields visible on each card so filtering stays predictable.
  const filteredPullRequests = normalizedQuery
    ? pullRequests.filter((pullRequest) => {
        const searchableText = `${pullRequest.repository} ${pullRequest.title} ${pullRequest.author} #${pullRequest.number}`;
        return searchableText.toLowerCase().includes(normalizedQuery);
      })
    : pullRequests;

  const visiblePullRequests = expanded
    ? filteredPullRequests
    : filteredPullRequests.slice(0, INITIAL_COUNT);
  const hiddenCount = filteredPullRequests.length - INITIAL_COUNT;

  /** Updates the filter and returns the list to its compact state. */
  function handleQueryChange(value: string): void {
    setQuery(value);
    setExpanded(false);
  }

  /** Toggles between the initial six results and the complete filtered list. */
  function toggleExpanded(): void {
    setExpanded((value) => !value);
  }

  return (
    <div className={`pull-list ${variant === "resolved" ? "resolved-list" : ""}`}>
      {variant === "open" && (
        <label className="pull-filter">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder="filter repos + titles..."
            aria-label="Filter open pull requests"
          />
          {query && <span>{filteredPullRequests.length}</span>}
        </label>
      )}

      {visiblePullRequests.length ? (
        <div className="pull-grid">
          {visiblePullRequests.map((pullRequest) => (
            <Link className={`pull-card ${pullRequest.status}`} href={pullRequest.viewerPath} key={`${pullRequest.repository}#${pullRequest.number}`}>
              <div className="pull-card-top">
                <span className="repo-name">{pullRequest.repository}</span>
                <span className="pull-number">#{pullRequest.number}</span>
                {variant === "resolved" && (
                  <span className={`pr-status ${pullRequest.status}`}>{pullRequest.status}</span>
                )}
              </div>
              <h3>{pullRequest.title}</h3>
              <div className="pull-card-meta">
                <Image className="avatar" src={pullRequest.avatarUrl} alt="" width={20} height={20} />
                <span>{pullRequest.author}</span>
                <span className="meta-dot">·</span>
                <span>{relativeDate(pullRequest.updatedAt)}</span>
                {pullRequest.draft && <span className="draft-pill">Draft</span>}
              </div>
              <ArrowRight className="card-arrow" size={16} />
            </Link>
          ))}
        </div>
      ) : (
        <div className="pull-filter-empty">No pull requests match “{query}”.</div>
      )}

      {filteredPullRequests.length > INITIAL_COUNT && (
        <button className="pull-more" type="button" onClick={toggleExpanded}>
          {expanded ? "show less" : `load next ${hiddenCount}`}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
    </div>
  );
}
