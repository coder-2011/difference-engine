import type { Metadata } from "next";
import { HomeDataRefresh } from "@/components/home-data-refresh";
import "./globals.css";

export const metadata: Metadata = {
  description: "A fast, focused way to read GitHub pull requests and diffs.",
  title: { default: "Diffs", template: "%s · Diffs" },
};

/** Supplies global fonts, metadata, and the dark application canvas. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><HomeDataRefresh />{children}</body>
    </html>
  );
}
