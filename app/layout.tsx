import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CVI Atlas",
  description: "One search, one sourced path, one next step for a parent.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}