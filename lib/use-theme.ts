"use client";

import { useCallback, useEffect, useState } from "react";

export type AppTheme = "light" | "dark";

const STORAGE_KEY = "splitsy-theme";

// One source of truth for theming across the landing page and the app.
// Resolution order: explicit user choice (sessionStorage, same key the app has
// always used) → OS preference → light. The <html data-theme> attribute is the
// only switch the CSS reads; app/theme-script.ts sets it pre-paint so neither
// surface flashes the wrong theme on load.
export function resolveInitialTheme(): AppTheme {
  if (typeof window === "undefined") return "light";
  const stored = window.sessionStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<AppTheme>(resolveInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    sessionStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Follow live OS changes only while the user hasn't made an explicit choice.
  useEffect(() => {
    if (sessionStorage.getItem(STORAGE_KEY)) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setThemeState(event.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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
