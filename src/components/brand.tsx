import Link from "next/link";
import { Diff } from "lucide-react";

/** Renders the compact wordmark shared by the dashboard and diff viewer. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" href="/" aria-label="Diffs home">
      <span className="brand-mark"><Diff size={15} strokeWidth={2.4} /></span>
      {!compact && <span>Diffs</span>}
    </Link>
  );
}
