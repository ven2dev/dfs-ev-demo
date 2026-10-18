import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { AuthStatus } from "@/components/AuthStatus";
import { StoreBootstrap } from "@/store/StoreBootstrap";
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
  title: "EdgeTrace",
  description: "Independent NFL player-prop analysis.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <StoreBootstrap />
        <div className="min-h-screen bg-zinc-50 dark:bg-black">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-4 sm:gap-8 sm:p-8">
            {/* Shared across every page -- #22 is the first second page
                this app has, so this is the first real chrome that needs
                to be consistent across routes rather than living inside
                one page's own return. */}
            <div className="sticky top-2 z-10 self-end">
              <ConnectionIndicator />
            </div>
            <header className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-2xl font-semibold">EdgeTrace</h1>
              <AuthStatus />
            </header>
            <main className="flex min-w-0 flex-col gap-6 sm:gap-8">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
