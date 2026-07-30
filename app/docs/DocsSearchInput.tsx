"use client";

import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchAll } from "./search-score";

type Scored = {
  id: string;
  title: string;
  score: number;
  /** First matching paragraph element id, if any, for deep-scroll. */
  anchor: string | null;
};

const HIGHLIGHT_CAP = 60; // ponytail: cap marks per section so a huge match set doesn't thrash the DOM

export default function DocsSearchInput() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const words = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  );

  // Score every section on each query change.
  const results = useMemo<Scored[]>(() => {
    // The page is force-dynamic (SSR); useMemo runs during render, so bail
    // out on the server where `document` is undefined. Render output is
    // identical both sides when the query is empty (all result blocks are
    // gated by words.length > 0), so there is no hydration mismatch.
    if (typeof document === "undefined") return [];
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>(".docs-section")
    );
    if (words.length === 0) {
      return sections.map((s) => ({
        id: s.id,
        title: headingText(s),
        score: 0,
        anchor: null,
      }));
    }
    const scored: Scored[] = [];
    for (const section of sections) {
      const title = headingText(section);
      const subheads = Array.from(section.querySelectorAll("h3, .docs-callout strong, .docs-card h3"))
        .map((el) => el.textContent ?? "")
        .join(" ");
      const body = section.textContent ?? "";

      const titleHit = matchAll(title, words);
      const subHit = matchAll(subheads, words);
      const bodyHit = matchAll(body, words);

      if (!titleHit && !subHit && !bodyHit) continue;

      const score =
        (titleHit ? titleHit.score * 3 : 0) +
        (subHit ? subHit.score * 2 : 0) +
        (bodyHit ? bodyHit.score : 0);

      scored.push({
        id: section.id,
        title,
        score,
        anchor: firstMatchingParaId(section, words),
      });
    }
    return scored.sort((a, b) => b.score - a.score);
  }, [words]);

  // Apply visibility + reordering + highlighting as a single DOM pass.
  const apply = useCallback(() => {
    const visibleIds = new Set(results.map((r) => r.id));
    const sections = document.querySelectorAll<HTMLElement>(".docs-section");

    sections.forEach((section) => {
      const show = words.length === 0 || visibleIds.has(section.id);
      section.style.display = show ? "" : "none";
      if (show) highlightTerms(section, words);
    });

    // Reorder + filter sidebar links to match ranking.
    const sidebar = document.querySelector<HTMLElement>(".docs-sidebar");
    if (sidebar) reorderSidebar(sidebar, results, words.length === 0);
  }, [results, words]);

  useEffect(() => { apply(); }, [apply]);

  // Clamp during render rather than in an effect: a shrinking result set can't
  // leave `active` pointing past the end even for one frame.
  const activeIndex =
    words.length === 0 ? 0 : Math.min(active, Math.max(results.length - 1, 0));

  // The sidebar links themselves are the result list (filtered + re-ranked
  // by apply); mark the keyboard-active one.
  useEffect(() => {
    const links = document.querySelectorAll<HTMLAnchorElement>(".docs-sidebar a[href^='#']");
    const activeId = words.length > 0 ? results[activeIndex]?.id : undefined;
    links.forEach((l) => {
      l.classList.toggle("docs-search-active", l.getAttribute("href") === `#${activeId}`);
    });
  }, [activeIndex, results, words]);

  // Global focus shortcuts: "/" and Ctrl/Cmd+K.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") {
        const target = e.target as HTMLElement;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") {
          if (e.key === "/") return;
        }
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleNav(direction: 1 | -1) {
    const max = results.length - 1;
    setActive(max < 0 ? 0 : Math.max(0, Math.min(max, activeIndex + direction)));
  }

  function openResult(index: number) {
    const r = results[index];
    if (!r) return;
    const target = r.anchor
      ? (document.getElementById(r.anchor) as HTMLElement | null)
      : (document.getElementById(r.id) as HTMLElement | null);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Brief focus ring so the user sees where they landed.
    target?.classList.add("docs-search-hit");
    window.setTimeout(() => target?.classList.remove("docs-search-hit"), 1200);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); handleNav(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); handleNav(-1); }
    else if (e.key === "Enter") { e.preventDefault(); openResult(activeIndex); }
    else if (e.key === "Escape") { setQuery(""); inputRef.current?.blur(); }
  }

  const isEmpty = words.length > 0 && results.length === 0;

  return (
    <div className="docs-search-wrap">
      <div className="docs-search">
        <Search size={15} />
        <input
          ref={inputRef}
          type="search"
          placeholder="Search docs…   ( / or ⌘K )"
          aria-label="Search documentation"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            className="docs-search-clear"
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {words.length > 0 && (
        <div className="docs-search-meta" role="status" aria-live="polite">
          {isEmpty ? (
            <span>No matches for &ldquo;{query}&rdquo;</span>
          ) : (
            <span>
              {results.length} {results.length === 1 ? "match" : "matches"}
              <span className="docs-search-hint"> · ↵ jump</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- DOM helpers ---------- */

function headingText(section: HTMLElement): string {
  const h2 = section.querySelector("h2");
  return (h2?.textContent ?? section.id).trim();
}

/** Find the id of the first paragraph/heading that matches all words, for deep scroll. */
function firstMatchingParaId(section: HTMLElement, words: string[]): string | null {
  if (words.length === 0) return null;
  const blocks = section.querySelectorAll<HTMLElement>("p, h3, li, .docs-callout strong");
  for (const block of blocks) {
    if (block.id && matchAll(block.textContent ?? "", words)) return block.id;
  }
  // Fall back to the first matching block; stamp it with a throwaway id we can scroll to.
  for (const block of blocks) {
    if (matchAll(block.textContent ?? "", words)) {
      if (!block.id) block.id = `${section.id}-hit`;
      return block.id;
    }
  }
  return null;
}

/** Wrap matched terms in <mark>, reversibly. Skips <code>, <pre>, <mark> themselves. */
function highlightTerms(section: HTMLElement, words: string[]) {
  if (words.length === 0) { clearHighlights(section); return; }
  clearHighlights(section);

  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "MARK" || tag === "CODE" || tag === "PRE") {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && node.nodeValue.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: { node: Text; value: string }[] = [];
  let cur = walker.nextNode() as Text | null;
  while (cur) {
    targets.push({ node: cur, value: cur.nodeValue ?? "" });
    cur = walker.nextNode() as Text | null;
  }

  let marked = 0;
  // Search for whole-word, case-insensitive matches of each query term.
  const pattern = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(${pattern})`, "gi");

  for (const { node, value } of targets) {
    if (marked >= HIGHLIGHT_CAP) break;
    if (!re.test(value)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) && marked < HIGHLIGHT_CAP) {
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = "docs-mark";
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      marked++;
    }
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }
}

function clearHighlights(section: HTMLElement) {
  const marks = section.querySelectorAll<HTMLElement>("mark.docs-mark");
  for (const mark of marks) {
    const text = document.createTextNode(mark.textContent ?? "");
    mark.replaceWith(text);
  }
  // Merge adjacent text nodes so re-highlighting doesn't fragment.
  section.normalize();
}

function reorderSidebar(
  sidebar: HTMLElement,
  results: Scored[],
  empty: boolean
) {
  // Rank via CSS `order` on the sidebar grid — never move React-owned DOM nodes.
  const links = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
  const rank = empty ? null : new Map(results.map((r, i) => [r.id, i]));
  links.forEach((l) => {
    const id = l.getAttribute("href")?.slice(1) ?? "";
    if (!rank) {
      l.style.display = "";
      l.style.order = "";
      return;
    }
    const r = rank.get(id);
    l.style.display = r === undefined ? "none" : "";
    // Higher-ranked results get a lower order; non-matches are hidden anyway.
    l.style.order = r === undefined ? "" : String(r);
  });
}
