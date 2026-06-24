"use client";

import { Moon, Sun } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";

export default function DocsShell({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    document.documentElement.dataset.docsTheme = theme;
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
