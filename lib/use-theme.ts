"use client";

import { useCallback, useEffect, useState } from "react";

export type AppTheme = "light" | "dark";

const STORAGE_KEY = "splitsy-theme";

// One source of truth for theming across the landing page and the app.
// Resolution order: explicit user choice (sessionStorage, same key the app has
// always used) → light. A first visit is light whatever the OS prefers — the
// paper look is the design, not a fallback. The <html data-theme> attribute is
// the only switch the CSS reads; the inline script in app/layout.tsx sets it
// pre-paint (same rule, duplicated there) so neither surface flashes dark.
export function resolveInitialTheme(): AppTheme {
  if (typeof window === "undefined") return "light";
  return window.sessionStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<AppTheme>(resolveInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    sessionStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Explicit toggles get a brief cross-fade: .theme-fade forces color/background
  // transitions on everything for one beat, then unwinds so it can't tax
  // scrolling or animations afterwards.
  const setTheme = useCallback((next: AppTheme | ((current: AppTheme) => AppTheme)) => {
    const root = document.documentElement;
    root.classList.add("theme-fade");
    window.setTimeout(() => root.classList.remove("theme-fade"), 420);
    setThemeState(next);
  }, []);

  return { theme, setTheme } as const;
}
