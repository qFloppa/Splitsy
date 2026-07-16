"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/use-theme";

export function Nav() {
  const { theme, setTheme } = useTheme();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[color:var(--header-bg)] backdrop-blur-xl">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-[88rem] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8"
      >
        <Link aria-label="Splitsy home" className="brand-lockup" href="/">
          <span className="logo-crop logo-crop-docs">
            <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
          </span>
        </Link>

        <div className="flex items-center gap-1.5 sm:gap-2">
          <a
            className="hidden rounded-md px-3 py-2 text-sm font-semibold text-[var(--text-soft)] no-underline transition-colors duration-[var(--dur-1)] hover:text-[var(--text)] sm:block"
            href="#demo"
          >
            How it works
          </a>
          <Link
            className="rounded-md px-3 py-2 text-sm font-semibold text-[var(--text-soft)] no-underline transition-colors duration-[var(--dur-1)] hover:text-[var(--text)]"
            href="/docs"
          >
            Docs
          </Link>
          <button
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            className="icon-button shrink-0"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
            type="button"
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <Button asChild className="group">
            <Link href="/app">
              Launch app
              <ArrowRight className="transition-transform duration-[var(--dur-2)] group-hover:translate-x-0.5" size={16} />
            </Link>
          </Button>
        </div>
      </nav>
    </header>
  );
}
