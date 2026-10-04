import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RareVerse",
  description:
    "RareVerse maps rare diseases by the biology they share and links each one to the patient groups, papers and grants already working on it. Every link shows its source.",
};

// The browser bar matches the header (--surface).
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#16171c" },
  ],
};

// Browser extensions (Grammarly, dark-mode helpers) write attributes onto <html> and <body>
// before React hydrates. suppressHydrationWarning covers only these two elements' own
// attributes, so real mismatches inside the app are still reported.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
