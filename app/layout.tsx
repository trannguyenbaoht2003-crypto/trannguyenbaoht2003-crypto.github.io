import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lõi.Meta — Hướng dẫn ARAM: Mayhem tiếng Việt",
  description: "Build trang bị, lõi ưu tiên, tương tác đặc biệt và bẫy cần tránh cho ARAM: Mayhem.",
  applicationName: "Lõi.Meta",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#071018",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}
