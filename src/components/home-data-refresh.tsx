"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** Refreshes GitHub-backed home data whenever navigation returns to the main page. */
export function HomeDataRefresh(): null {
  const pathname = usePathname();
  const router = useRouter();
  const previousPathname = useRef(pathname);

  useEffect(() => {
    const returnedToHome = pathname === "/" && previousPathname.current !== "/";
    previousPathname.current = pathname;
    if (returnedToHome) router.refresh();
  }, [pathname, router]);

  useEffect(() => {
    /** Refreshes a previously rendered dashboard after the browser restores it from history. */
    function refreshRestoredHome(event: PageTransitionEvent): void {
      if (event.persisted && pathname === "/") router.refresh();
    }

    window.addEventListener("pageshow", refreshRestoredHome);
    return () => window.removeEventListener("pageshow", refreshRestoredHome);
  }, [pathname, router]);

  return null;
}
