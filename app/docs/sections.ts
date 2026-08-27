/**
 * The document's outline, and the only place its structure is declared.
 *
 * Three things render from this: the contents poster, the sticky rail, and each
 * section's own head. They are three renderings of ONE array, so a section cannot
 * be listed under a number it does not print, and "§09" keeps meaning §09 as the
 * document grows. Insert a section in the middle and all three renumber together.
 * This is the construction components/LegalDoc.tsx uses for its clauses, and the
 * reason a reader can cite a number here at all.
 *
 * The nesting IS the data. LegalDoc has to GROUP its clauses, because `part` is
 * optional there and a run of clauses that share one becomes a group; here every
 * section belongs to a part, so declaring the parts as the outer array means there
 * is no grouping pass to get wrong. The ordinal is assigned by flatten order, so
 * it counts across the whole document rather than restarting per part — a reader
 * quoting "§13" should not have to say which part it was in.
 *
 * Ids are load-bearing and must not be edited to match a retitled section. They
 * are what /docs is linked to by from outside, what the page's own cross-links
 * point at, and what the search scrolls to. A section may be renamed, renumbered
 * and moved between parts without touching its id.
 */

export type DocSection = {
  /** Anchor id. Stable across edits. */
  id: string;
  title: string;
};

export type NumberedSection = DocSection & { part: string; n: string };

/** Document order. The ordinal is this array flattened, so order here is the only
 *  thing that decides it. */
const OUTLINE: { part: string; sections: DocSection[] }[] = [
  {
    part: "Using Splitsy",
    sections: [
      { id: "overview", title: "Overview" },
      { id: "using-splitsy", title: "Using Splitsy" },
      { id: "sign-in-and-wallets", title: "Sign-in and wallets" },
      { id: "bill-splits", title: "Bill splits" },
      // Beside bill-splits rather than seven sections downstream: a recurring tab
      // is the scheduled counterpart to a one-time bill, and a reader who has just
      // read how one works is the reader for the other.
      { id: "recurring-tabs", title: "Recurring tabs" },
    ],
  },
  {
    part: "What the chain guarantees",
    sections: [
      { id: "bill-verification", title: "Bill verification" },
      { id: "payment-reputation", title: "Payment reputation" },
      { id: "circle-and-arc", title: "Circle and Arc" },
    ],
  },
  {
    part: "The agent economy",
    sections: [
      { id: "autopay-agents", title: "Autopay agents" },
      { id: "scout-agent", title: "Scout agent" },
      { id: "net-settlement-treasury", title: "Net-settlement treasury" },
    ],
  },
  {
    part: "Under the hood",
    sections: [
      { id: "architecture", title: "Architecture" },
      { id: "contracts", title: "Contracts" },
      { id: "operations", title: "Operations" },
      { id: "security", title: "Security" },
      { id: "configuration", title: "Configuration" },
    ],
  },
];

let seq = 0;

/** The outline with ordinals, grouped as declared. What the contents poster and
 *  the rail iterate. */
export const PARTS = OUTLINE.map(({ part, sections }) => ({
  part,
  sections: sections.map((section) => ({
    ...section,
    part,
    n: String(++seq).padStart(2, "0"),
  })),
}));

/** The same objects, flat. What a section head looks itself up in. */
export const SECTIONS: NumberedSection[] = PARTS.flatMap((entry) => entry.sections);

const BY_ID = new Map(SECTIONS.map((section) => [section.id, section]));

/**
 * A section, by id. Throws rather than falling back, and that is the point: a
 * section rendered with an id the outline does not know would print no ordinal and
 * appear in neither the index nor the rail — a section nobody can navigate to,
 * shipped silently. Failing the build is the cheaper outcome.
 */
export function section(id: string): NumberedSection {
  const found = BY_ID.get(id);
  if (!found) {
    throw new Error(
      `Unknown /docs section id "${id}". Add it to OUTLINE in app/docs/sections.ts — ` +
        `the contents index, the rail and the section head all read from there.`,
    );
  }
  return found;
}
