import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CVI Atlas",
  description: "Find the rare diseases that share your biology, what work already exists, and who to work with next. Every link is sourced.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
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
