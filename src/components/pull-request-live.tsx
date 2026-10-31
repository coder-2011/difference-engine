"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PullRequestWorkspace } from "@/types/github";

type LivePullRequest = {
  publish: (workspace: PullRequestWorkspace) => void;
  workspace?: PullRequestWorkspace;
};

const PullRequestLiveContext = createContext<LivePullRequest | undefined>(undefined);

/** Shares refreshed GitHub state across the PR header, conversation, and diff. */
export function PullRequestLiveProvider({ children, initialWorkspace }: { children: ReactNode; initialWorkspace?: PullRequestWorkspace }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const publish = useCallback((next: PullRequestWorkspace) => {
    setWorkspace((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, []);
  useEffect(() => {
    if (initialWorkspace) publish(initialWorkspace);
  }, [initialWorkspace, publish]);
  useEffect(() => {
    if (workspace?.details?.title) document.title = `${workspace.details.title} · Diffs`;
  }, [workspace?.details?.title]);
  const value = useMemo(() => ({ publish, workspace }), [publish, workspace]);
  return <PullRequestLiveContext.Provider value={value}>{children}</PullRequestLiveContext.Provider>;
}

export function usePullRequestLive(): LivePullRequest | undefined {
  return useContext(PullRequestLiveContext);
}

/** Keeps the base branch label current without remounting the editable head branch. */
export function PullRequestBaseLabel({ initialLabel }: { initialLabel: string }) {
  const live = usePullRequestLive();
  return <>{live?.workspace?.details?.baseLabel ?? initialLabel}</>;
}

export function PullRequestHeadLabel({ initialLabel }: { initialLabel: string }) {
  const live = usePullRequestLive();
  return <>{live?.workspace?.details?.headLabel ?? initialLabel}</>;
}
