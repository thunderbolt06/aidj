import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { BackNav } from "@/components/BackNav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Everplay",
  description: "Tell it a vibe. It plays only the famous parts, transitions like a DJ, and never stops.",
  openGraph: {
    title: "Everplay",
    description: "Tell it a vibe. It plays only the famous parts, transitions like a DJ, and never stops.",
    siteName: "Everplay",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Everplay",
    description: "Tell it a vibe. It plays only the famous parts, transitions like a DJ, and never stops.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <BackNav />
        {children}
      </body>
    </html>
  );
}
