"use client";
import { Search } from "lucide-react";

export default function DocsSearchInput() {
  function handleSearch(q: string) {
    const query = q.toLowerCase().trim();
    document.querySelectorAll<HTMLElement>(".docs-section").forEach((section) => {
      const match = !query || (section.textContent?.toLowerCase() ?? "").includes(query);
      section.style.display = match ? "" : "none";
      if (section.id) {
        const link = document.querySelector<HTMLElement>(
          `.docs-sidebar a[href="#${section.id}"]`
        );
        if (link) link.style.display = match ? "" : "none";
      }
    });
  }

  return (
    <div className="docs-search">
      <Search size={15} />
      <input
        type="search"
        placeholder="Search docs…"
        onChange={(e) => handleSearch(e.target.value)}
      />
    </div>
  );
}
