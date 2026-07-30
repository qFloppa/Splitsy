# Splitsy deck — how to build the submission link

For the **Programmable Money Hackathon** (DeFi + Agentic Economy tracks).
`splitsy-deck.md` is the source of truth. 21 slides.

## Always pass `--allow-local-files`

The deck embeds `public/splitsy.png` and `public/splitsy3.jpg`. Without that
flag Marp silently blocks them and you get a deck with **no logos**.

```bash
# PDF (upload to Drive, share the link)
npx @marp-team/marp-cli docs/deck/splitsy-deck.md --pdf --allow-local-files

# PowerPoint (import into Google Slides)
npx @marp-team/marp-cli docs/deck/splitsy-deck.md --pptx --allow-local-files

# Self-contained HTML (host on GitHub Pages, that URL is your link)
npx @marp-team/marp-cli docs/deck/splitsy-deck.md --html --allow-local-files

# Live preview while editing
npx @marp-team/marp-cli -p docs/deck/splitsy-deck.md --allow-local-files
```

**Note on `--pptx`:** Marp rasterises each slide to an image, so the PowerPoint
is not text-editable. Fine for presenting and for a Google Slides link, but edit
the Markdown, not the deck. Pass `--pptx --editable` if you need real text boxes
(requires LibreOffice installed).

To edit live in VS Code: install the "Marp for VS Code" extension, open the
`.md`, click the preview icon.

## Getting the link

- **Fastest:** upload `splitsy-deck.pdf` to Google Drive, set "anyone with the
  link can view", submit that URL.
- **Google Slides:** import `splitsy-deck.pptx`, then share.
- **GitHub Pages:** `--html`, commit under `/docs`, enable Pages.
- **Gamma / Canva:** paste `gamma-prompt.md` into gamma.app ("Create → Paste in
  text"). Auto-designed and prettier, less exact. Upload `splitsy.png` and
  `splitsy3.jpg` as brand assets when prompted.

## Accuracy

Every figure traces to code. If you change any of these, update the deck:

| Claim in deck | Source |
| --- | --- |
| `$0.005` / `$0.001` prices | `lib/x402/pricing.ts` |
| `0.80` confidence gate | `lib/scout/decide.ts` |
| `$0.05` daily cap, `$0.011` scan | `lib/scout/deps.ts`, `agent-script.ts` |
| `14 → 1` transactions | `buildTreasury`: `2*payLegCount + claimLegCount` |
| 100 / 100 / floor 50, 2-day grace, −5/day | `lib/reputation-score.ts` |
| 6 CCTP source chains | `lib/appkit-bridge.ts` `bridgeSourceChains` |
| Recurring allowance flow, hourly cron | `README.md` "Recurring Collection" |
| Chain IDs, contract addresses | `components/landing/SectionStack.tsx` |

Two deliberate honesty constraints, kept consistent with the product:

1. Batching removes **transactions, not USDC transfers**. The net figure is
   exposure. `lib/treasury.ts` and `DashboardPanel` say the same thing.
2. No em dashes in the deck copy.
