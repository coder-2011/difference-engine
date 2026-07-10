"use server";

import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { viewerPathFromUrl } from "@/lib/github";

/** Starts GitHub OAuth and returns the user to their pull-request dashboard. */
export async function login(): Promise<void> {
  await signIn("github", { redirectTo: "/" });
}

/** Ends the current session without leaving the dashboard. */
export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/" });
}

/** Opens a supported GitHub pull request, comparison, or commit URL. */
export async function openSource(formData: FormData): Promise<void> {
  const value = String(formData.get("url") ?? "");
  const viewerPath = viewerPathFromUrl(value);
  const error = encodeURIComponent("Enter a GitHub pull request, comparison, or commit URL");
  redirect(viewerPath ?? `/?error=${error}`);
}
