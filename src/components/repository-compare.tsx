"use client";

import { GitCompareArrows } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ChangeEvent, FormEvent } from "react";
import { useState } from "react";

type RepositoryCompareProps = {
  currentRef: string;
  defaultBranch: string;
  repository: string;
};

/** Opens an editable GitHub comparison from the viewed revision. */
export function RepositoryCompare({ currentRef, defaultBranch, repository }: RepositoryCompareProps) {
  const router = useRouter();
  const [baseRef, setBaseRef] = useState(defaultBranch);
  const [headRef, setHeadRef] = useState(currentRef === defaultBranch ? "" : currentRef);

  /** Keeps the editable base revision synchronized with its input. */
  function changeBaseRef(event: ChangeEvent<HTMLInputElement>): void {
    setBaseRef(event.currentTarget.value);
  }

  /** Keeps the editable comparison revision synchronized with its input. */
  function changeHeadRef(event: ChangeEvent<HTMLInputElement>): void {
    setHeadRef(event.currentTarget.value);
  }

  /** Navigates to the existing comparison viewer after trimming both revisions. */
  function compareRevisions(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const base = baseRef.trim();
    const head = headRef.trim();
    if (!base || !head) return;

    const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
    const comparison = encodeURIComponent(`${base}...${head}`);
    router.push(`/${encodedRepository}/compare/${comparison}`);
  }

  return (
    <details className="repository-compare">
      <summary className="repository-tool-trigger"><GitCompareArrows size={14} /> Compare this branch</summary>
      <form className="repository-compare-panel" onSubmit={compareRevisions}>
        <label>
          <span>Base</span>
          <input required aria-label="Base revision" value={baseRef} onChange={changeBaseRef} />
        </label>
        <span className="repository-compare-dots">…</span>
        <label>
          <span>Compare</span>
          <input required aria-label="Compare revision" placeholder="branch or revision" value={headRef} onChange={changeHeadRef} />
        </label>
        <button type="submit">Compare</button>
      </form>
    </details>
  );
}
