import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  description: "A fast, focused way to read GitHub pull requests and diffs.",
  title: { default: "Diffs", template: "%s · Diffs" },
};

/** Supplies global fonts, metadata, and the dark application canvas. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
