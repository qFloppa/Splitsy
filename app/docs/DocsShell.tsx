"use client";

import { Moon, Sun } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";

type DocsTheme = "light" | "dark";

export default function DocsShell({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<DocsTheme>(() => {
    if (typeof window === "undefined") {
      return "light";
    }
    const storedTheme = window.sessionStorage.getItem("splitsy-docs-theme");
    return storedTheme === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.docsTheme = theme;
    // Also drive the global theme so the body background + HeroBackground blobs
    // (rendered behind the now-transparent docs shell) track the docs toggle.
    document.documentElement.dataset.theme = theme;
    sessionStorage.setItem("splitsy-docs-theme", theme);
  }, [theme]);

  return (
    <main className="docs-shell min-h-screen" data-docs-theme={theme}>
      {children}
      <button
        aria-label={`Switch docs to ${theme === "light" ? "dark" : "light"} mode`}
        className="docs-theme-toggle fixed bottom-5 right-5 z-40"
        onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
        type="button"
      >
        {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
    </main>
  );
}
