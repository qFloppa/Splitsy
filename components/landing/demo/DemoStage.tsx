"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Mail, WalletCards } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DiscordIcon, XIcon } from "../ProviderIcons";

gsap.registerPlugin(MotionPathPlugin, ScrollTrigger);

const FULL_ADDRESS = "0xEE42a492B183CdFf04439F2Cb6A9c49F857F70AC";
const SHORT_ADDRESS = "0xEE42…70AC";

type DemoItem = {
  name: string;
  price: string;
  typed: string;
  short?: string;
  mono?: boolean;
  kind: string;
  icon: ReactNode;
};

const ITEMS: DemoItem[] = [
  { name: "Pizza", price: "$18.00", typed: "@SplitsyApp", kind: "X handle", icon: <XIcon size={13} /> },
  { name: "Coffee", price: "$4.50", typed: "Splitsy", kind: "Discord username", icon: <DiscordIcon size={13} /> },
  { name: "Dessert", price: "$7.25", typed: "info@splitsy.xyz", kind: "Email address", icon: <Mail size={13} /> },
  {
    name: "Taxi",
    price: "$12.80",
    typed: FULL_ADDRESS,
    short: SHORT_ADDRESS,
    mono: true,
    kind: "Wallet address",
    icon: <WalletCards size={13} />,
  },
];

const STEPS = ["Upload", "Choose", "Type", "Assign", "Settle"] as const;
const STEP_LABELS = ["upload", "choose", "type", "assign", "settle"] as const;

/**
 * The landing demo: one paused master timeline drives every act.
 *
 * The DOM is authored in its FINAL state (receipt docked + stamped, rows
 * assigned, settled banner shown); transient props (menu, cursor, carets…)
 * carry opacity-0/invisible classes. buildTimeline() measures the resting
 * layout, gsap.set()s everything to its starting state, then plays the story
 * with .to() tweens only — so under prefers-reduced-motion we never build and
 * the static final frame is what renders. Scrubbing backwards works because
 * nothing depends on one-shot callbacks: typing is a tweened proxy object and
 * attribute flips use tl.set(), which reverts on reverse.
 *
 * Drive model: while the section is pinned and the user scrolled recently,
 * progress lerps toward the scroll-mapped target; otherwise the ticker
 * advances progress modulo 1 (idle autoplay loop). Mobile never pins.
 */
export function DemoStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const seekRef = useRef<(index: number) => void>(() => {});

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const stage = stageRef.current;
    if (!stage) return;

    let ctx: gsap.Context | undefined;
    let tickFn: (() => void) | undefined;
    let stepIndex = 0;

    const build = () => {
      if (tickFn) gsap.ticker.remove(tickFn);
      tickFn = undefined;
      ctx?.revert();

      ctx = gsap.context(() => {
        const q = gsap.utils.selector(stage);
        const el = (sel: string) => q(sel)[0];

        const receipt = el("[data-receipt]");
        const dropzone = el("[data-dropzone]");
        const dropHint = el("[data-drop-hint]");
        const stamp = el("[data-stamp]");
        const cursor = el("[data-cursor]");
        const rows = q("[data-item-row]");
        const splitBtns = q("[data-split-btn]");
        const chips = q("[data-assignee-chip]");
        const carets = q("[data-caret]");
        const typeTargets = q("[data-typed]");
        const menu = el("[data-menu]");
        const menuItems = q("[data-menu-item]");
        const recipients = q("[data-recipient]");
        const chipAmounts = q("[data-chip-amount]");
        const flys = q("[data-fly]");
        const flySources = q("[data-fly-source]");
        const writeBtn = el("[data-write]");
        const blocks = q("[data-block]");
        const success = el("[data-success]");
        const overlay = el("[data-overlay]");
        const rightEmpty = el("[data-right-empty]");

        // ---- measure the resting (final, untransformed) layout FIRST ----
        const stageRect = stage.getBoundingClientRect();
        const centerOf = (target: Element) => {
          const r = target.getBoundingClientRect();
          return { x: r.left - stageRect.left + r.width / 2, y: r.top - stageRect.top + r.height / 2 };
        };
        const btn0 = centerOf(splitBtns[0]);
        // The menu is placed by measurement, and the control it hangs off is now
        // at the START of a payer line rather than the end of a row — so the old
        // bare `x - 168` can land past the plate's left edge, where the screen's
        // clip would eat it. Clamped to the stage instead of trusting the layout.
        gsap.set(menu, { left: gsap.utils.clamp(12, stageRect.width - 220, btn0.x - 60), top: btn0.y + 18 });
        const M = {
          receipt: centerOf(receipt),
          btn0,
          menuCenters: menuItems.map(centerOf),
          flyFrom: flySources.map(centerOf),
          flyTo: recipients.map(centerOf),
          write: centerOf(writeBtn),
          writeWidth: writeBtn.getBoundingClientRect().width,
        };

        // ---- reset to the starting frame ----
        const RECEIPT_OFFSET = { x: -170, y: 150 };
        gsap.set(receipt, { ...RECEIPT_OFFSET, rotate: -9, scale: 0.94 });
        gsap.set(stamp, { autoAlpha: 0, scale: 2.4 });
        gsap.set(dropHint, { autoAlpha: 1 });
        gsap.set(rightEmpty, { autoAlpha: 1 });
        gsap.set([...rows, ...chips, ...recipients, ...chipAmounts, writeBtn, success], { autoAlpha: 0 });
        gsap.set(rows, { y: 14 });
        gsap.set(success, { y: 8 });
        gsap.set(chipAmounts, { scale: 0.4 });
        gsap.set(menu, { autoAlpha: 0, scale: 0.94, transformOrigin: "top left" });
        gsap.set(splitBtns, { autoAlpha: 1 });
        gsap.set([...carets, ...flys, ...blocks, overlay], { autoAlpha: 0 });
        gsap.set(cursor, { autoAlpha: 0, x: stageRect.width * 0.45, y: stageRect.height + 40 });
        typeTargets.forEach((t) => (t.textContent = ""));

        const tl = gsap.timeline({ paused: true });

        // ---------- Act 1 · Upload ----------
        tl.addLabel("upload")
          .to(cursor, { autoAlpha: 1, duration: 0.3 })
          .to(cursor, {
            x: M.receipt.x + RECEIPT_OFFSET.x,
            y: M.receipt.y + RECEIPT_OFFSET.y,
            duration: 0.8,
            ease: "power2.out",
          })
          .to(receipt, { scale: 0.9, duration: 0.16, ease: "power2.in" }) // grab press = anticipation
          .to(receipt, { x: 0, y: 0, rotate: 2, duration: 1.15, ease: "power2.inOut" })
          .to(cursor, { x: M.receipt.x, y: M.receipt.y, duration: 1.15, ease: "power2.inOut" }, "<")
          .to(receipt, { rotate: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)" }) // release, settle
          .to(dropHint, { autoAlpha: 0, duration: 0.3 }, "<")
          .set(dropzone, { attr: { "data-scanning": "true" } })
          .to({}, { duration: 1.6 }) // scan beam sweeps (CSS animation on [data-scanning="true"])
          .set(dropzone, { attr: { "data-scanning": "false" } })
          .to(rightEmpty, { autoAlpha: 0, duration: 0.25 }, "<")
          .to(rows, { autoAlpha: 1, y: 0, duration: 0.5, ease: "expo.out", stagger: 0.12 }, "<0.05");

        // ---------- Act 2 · Choose ----------
        tl.addLabel("choose")
          .to(cursor, { x: M.btn0.x, y: M.btn0.y, duration: 0.7, ease: "power2.inOut" })
          .to(splitBtns[0], { scale: 0.94, duration: 0.11, yoyo: true, repeat: 1 })
          .to(menu, { autoAlpha: 1, scale: 1, duration: 0.28, ease: "back.out(1.8)" });
        menuItems.forEach((item, i) => {
          const c = M.menuCenters[i];
          tl.to(cursor, { x: c.x - 30, y: c.y, duration: 0.3, ease: "power1.inOut" }, "+=0.08").set(item, {
            attr: { "data-on": "true" },
          });
          if (i > 0) tl.set(menuItems[i - 1], { attr: { "data-on": "false" } }, "<");
        });
        tl.to(cursor, { x: M.menuCenters[0].x - 30, y: M.menuCenters[0].y, duration: 0.45, ease: "power1.inOut" }, "+=0.15")
          .set(menuItems[menuItems.length - 1], { attr: { "data-on": "false" } })
          .set(menuItems[0], { attr: { "data-on": "true" } }, "<")
          .to(menuItems[0], { scale: 0.97, duration: 0.1, yoyo: true, repeat: 1 })
          .to(menu, { autoAlpha: 0, scale: 0.96, duration: 0.2, ease: "power2.in" })
          .set(menuItems[0], { attr: { "data-on": "false" } })
          .to(cursor, { autoAlpha: 0, x: "+=70", y: "-=40", duration: 0.45, ease: "power2.in" }, "+=0.1");

        // ---------- Act 3 · Type ----------
        tl.addLabel("type");
        ITEMS.forEach((item, i) => {
          const target = typeTargets[i];
          const proxy = { n: 0, collapsed: 0 };
          const render = () => {
            target.textContent =
              proxy.collapsed > 0.5 && item.short ? item.short : item.typed.slice(0, Math.round(proxy.n));
          };
          tl.to(splitBtns[i], { autoAlpha: 0, duration: 0.18 }, i === 0 ? "+=0.1" : "+=0.25")
            .to(chips[i], { autoAlpha: 1, duration: 0.22 }, "<0.06")
            .set(chips[i], { attr: { "data-focus": "true" } })
            .set(carets[i], { autoAlpha: 1 }, "<")
            .to(proxy, {
              n: item.typed.length,
              duration: item.mono ? 1.15 : Math.min(1.3, 0.07 * item.typed.length + 0.35),
              ease: "none",
              onUpdate: render,
            });
          if (item.short) {
            tl.to({}, { duration: 0.35 }).to(proxy, { collapsed: 1, duration: 0.01, onUpdate: render });
          }
          tl.set(carets[i], { autoAlpha: 0 }).set(chips[i], { attr: { "data-focus": "false" } });
        });

        // ---------- Act 4 · Assign ----------
        tl.addLabel("assign").to(
          recipients,
          { autoAlpha: 1, duration: 0.45, ease: "expo.out", stagger: 0.07 },
          "+=0.2",
        );
        ITEMS.forEach((_, i) => {
          const from = M.flyFrom[i];
          const to = M.flyTo[i];
          tl.set(
            flys[i],
            { x: from.x, y: from.y, xPercent: -50, yPercent: -50, autoAlpha: 1, scale: 1 },
            i === 0 ? "+=0.15" : "-=0.45",
          )
            .to(flys[i], {
              motionPath: {
                path: [
                  { x: from.x, y: from.y },
                  { x: (from.x + to.x) / 2 + 36, y: Math.min(from.y, to.y) - 46 },
                  { x: to.x, y: to.y },
                ],
                curviness: 1.3,
              },
              duration: 0.75,
              ease: "power2.inOut",
            })
            .to(flys[i], { autoAlpha: 0, scale: 0.5, duration: 0.16 })
            .to(chipAmounts[i], { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(2.4)" }, "<");
        });

        // ---------- Act 5 · Settle ----------
        tl.addLabel("settle")
          .to(writeBtn, { autoAlpha: 1, duration: 0.4, ease: "expo.out" }, "+=0.2")
          .to(cursor, { autoAlpha: 1, duration: 0.2 }, "<")
          .to(cursor, { x: M.write.x, y: M.write.y, duration: 0.7, ease: "power2.inOut" }, "<")
          .to(writeBtn, { scale: 0.94, duration: 0.12, ease: "power2.in" })
          .to(writeBtn, { scale: 1, duration: 0.5, ease: "elastic.out(1.1, 0.5)" })
          .to(cursor, { autoAlpha: 0, y: "+=60", duration: 0.4 }, "<0.2")
          .to(blocks, { autoAlpha: 1, duration: 0.15, stagger: 0.12 }, "<")
          .to(blocks, { x: M.writeWidth + 80, duration: 1.5, ease: "power1.inOut", stagger: 0.12 }, "<")
          .to(blocks, { autoAlpha: 0, duration: 0.2, stagger: 0.12 }, "-=0.7")
          .to(success, { autoAlpha: 1, y: 0, duration: 0.4, ease: "expo.out" }, "-=0.3")
          .to(stamp, { autoAlpha: 1, scale: 1, duration: 0.45, ease: "back.out(2.6)" }, "<0.1")
          .to({}, { duration: 1.4 }) // hold the settled frame
          .to(overlay, { autoAlpha: 1, duration: 0.55, ease: "power2.in" })
          .to(overlay, { autoAlpha: 0, duration: 0.01 }); // progress 1 ≈ progress 0 under the veil

        // step rail highlighting
        const labelTimes = STEP_LABELS.map((l) => tl.labels[l] / tl.duration());
        tl.eventCallback("onUpdate", () => {
          const p = tl.progress();
          let idx = 0;
          for (let i = 0; i < labelTimes.length; i++) if (p >= labelTimes[i]) idx = i;
          if (idx !== stepIndex) {
            stepIndex = idx;
            setActiveStep(idx);
          }
        });

        // ---- drive: pinned scrub <-> idle autoplay ----
        let scrollTarget = 0;
        let lastScrollAt = -1e9;
        let pinActive = false;
        let seeking = false;
        let inView = true;

        // ponytail: the pin target is found by closest() instead of threading a
        // ref through BrowserFrame — one line vs. a prop drill. It is the plate
        // wrapper rather than the whole section: the section now opens with a
        // step, a headline and a standfirst, and pinning those would spend half a
        // laptop viewport on copy the visitor has already read.
        const section = stage.closest("[data-demo-pin]") ?? stage.closest("section");
        const mm = gsap.matchMedia();
        mm.add("(min-width: 1024px)", () => {
          const st = ScrollTrigger.create({
            trigger: section,
            start: "top 6%",
            end: "+=220%",
            pin: true,
            anticipatePin: 1,
            onToggle: (self) => {
              pinActive = self.isActive;
            },
            onUpdate: (self) => {
              scrollTarget = self.progress;
              lastScrollAt = gsap.ticker.time;
            },
          });
          return () => st.kill();
        });

        const io = new IntersectionObserver(
          ([entry]) => {
            inView = entry.isIntersecting;
          },
          { threshold: 0.05 },
        );
        io.observe(stage);

        tickFn = () => {
          if (!inView || seeking) return;
          if (pinActive && gsap.ticker.time - lastScrollAt < 0.9) {
            tl.progress(gsap.utils.interpolate(tl.progress(), scrollTarget, 0.14));
          } else {
            tl.progress((tl.progress() + gsap.ticker.deltaRatio(60) / 60 / tl.duration()) % 1);
          }
        };
        gsap.ticker.add(tickFn);

        seekRef.current = (index: number) => {
          seeking = true;
          lastScrollAt = -1e9;
          gsap.to(tl, {
            progress: labelTimes[index] + 0.001,
            duration: 0.7,
            ease: "power2.inOut",
            onComplete: () => {
              seeking = false;
            },
          });
        };

        return () => {
          mm.revert();
          io.disconnect();
        };
      }, stage);
    };

    build();

    let resizeTimer: ReturnType<typeof setTimeout>;
    let lastWidth = stage.clientWidth;
    const ro = new ResizeObserver(() => {
      if (stage.clientWidth === lastWidth) return; // pinning toggles height; only width changes need a re-measure
      lastWidth = stage.clientWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(build, 250);
    });
    ro.observe(stage);

    return () => {
      ro.disconnect();
      clearTimeout(resizeTimer);
      if (tickFn) gsap.ticker.remove(tickFn);
      ctx?.revert();
    };
  }, []);

  return (
    <div className="relative grid gap-x-[clamp(1.5rem,1rem+2vw,3.5rem)] gap-y-8 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:p-8" ref={stageRef}>
      <p className="sr-only">
        Animated product demo: a receipt from Café Arc is dragged into the upload area and scanned. Four line items are
        detected: Pizza, Coffee, Dessert, and Taxi. Each item is assigned to a person by X handle, Discord username,
        email address, or wallet address, then the split is written to Arc and settled in USDC.
      </p>

      {/* LEFT · upload pane — the bills tab's capture plate, verbatim: a caps
          label, an area of the poster marked by registration arms, and a rule at
          its foot. Nothing dashed, nothing rounded. */}
      <div className="bill-capture">
        <span className="settle-label">01 · Upload</span>
        <div className="bill-plate mt-3" data-dropzone>
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center opacity-0"
            data-drop-hint
          >
            <span className="bill-plate-call">Drop the bill</span>
          </div>
          <div className="receipt-card w-56 p-4 will-change-transform" data-receipt>
            <p className="text-center text-sm font-extrabold tracking-wide text-[var(--receipt-text)]">CAFÉ ARC</p>
            <p className="mt-0.5 text-center text-[10px] text-[var(--receipt-muted)]">Table 7 · 4 guests</p>
            <div className="receipt-divider mt-3 pt-1">
              {ITEMS.map((item, i) => (
                <div
                  className="flex items-baseline justify-between py-1.5 text-xs text-[var(--receipt-text)]"
                  key={item.name}
                >
                  <span>
                    <span className="receipt-index mr-2">{String(i + 1).padStart(2, "0")}</span>
                    {item.name}
                  </span>
                  <span className="amount-text">{item.price}</span>
                </div>
              ))}
            </div>
            <div className="receipt-divider mt-2 flex items-baseline justify-between pt-2 text-xs font-bold text-[var(--receipt-text)]">
              <span>TOTAL</span>
              <span className="amount-text">$42.55</span>
            </div>
            <div className="settlement-stamp absolute top-9 right-2 text-[10px]" data-stamp>
              Settled on Arc
            </div>
          </div>
        </div>
        <div className="bill-cell-rule" />
        <div className="bill-plate-caption">
          <span className="bill-poster-fact">receipt.jpg · 1290 × 1720</span>
          <span className="bill-poster-fact">
            hashed into the bill · <b>keccak256</b>
          </span>
        </div>
      </div>

      {/* RIGHT · split pane */}
      <div className="relative flex min-w-0 flex-col">
        <span className="settle-label">02 · Split</span>

        <div className="relative mt-3">
          <p className="bill-poster-fact absolute inset-x-0 top-3 opacity-0" data-right-empty>
            Scan a receipt to start a split…
          </p>
          {/* Payer rows: the app's own. A name and an amount, both set in poster
              type, with everything that qualifies them on a caps rail beneath —
              which is where the "split with…" control and the typed handle live. */}
          <div>
            {ITEMS.map((item) => (
              <div className="bill-payer" data-item-row key={item.name}>
                <div className="bill-payer-line">
                  <span className="bill-payer-target flex min-w-0 items-baseline">
                    <span className="relative flex min-w-0 items-baseline">
                      <button
                        className="bill-payer-target absolute top-0 left-0 border-0 bg-transparent p-0 whitespace-nowrap text-[var(--pay-poster-dim)] opacity-0"
                        data-split-btn
                        tabIndex={-1}
                        type="button"
                      >
                        Split with…
                      </button>
                      {/* ponytail: focus ring is visual-only ([data-focus] styling) — calling
                          .focus() from the timeline would steal real page focus mid-scroll. */}
                      <span
                        className="relative flex min-w-0 items-baseline opacity-0 after:absolute after:inset-x-0 after:-bottom-1 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-[var(--dur-2)] data-[focus=true]:after:scale-x-100"
                        data-assignee-chip
                      >
                        <span className="bill-payer-mark shrink-0 self-center text-[var(--pay-poster-dim)]">
                          {item.icon}
                        </span>
                        {item.short ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="truncate" data-typed>
                                {item.short}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="mono">{FULL_ADDRESS}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="truncate" data-typed>
                            {item.typed}
                          </span>
                        )}
                        <span className="lp-caret ml-0.5 self-center opacity-0" data-caret />
                      </span>
                    </span>
                  </span>
                  <span className="bill-payer-share" data-fly-source>
                    <span className="bill-currency">$</span>
                    {item.price.replace("$", "")}
                  </span>
                </div>
                <div className="bill-payer-meta">
                  <span className="settle-label">{item.kind}</span>
                  <span className="bill-poster-fact">{item.name}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Who ends up owing what — the same ruled rows, one register smaller. */}
        <div className="lp-rows mt-7 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {ITEMS.map((item) => (
            <div className="lp-row grid-cols-[minmax(0,1fr)_auto] opacity-0" data-recipient key={item.kind}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 self-center text-[var(--pay-poster-dim)]">{item.icon}</span>
                <span className={`truncate text-[0.82rem] text-[var(--pay-poster-fg)] ${item.mono ? "mono" : ""}`}>
                  {item.short ?? item.typed}
                </span>
              </span>
              <span className="bill-figure-sm text-[var(--success)] opacity-0" data-chip-amount>
                <span className="bill-currency">$</span>
                {item.price.replace("$", "")}
              </span>
            </div>
          ))}
        </div>

        {/* The commit: .settle-action, the borderless display word the /pay
            poster uses to move money. The blocks stream out of it as it fires. */}
        <div className="bill-poster-foot relative">
          <div className="relative">
            <button className="settle-action opacity-0" data-write tabIndex={-1} type="button">
              Write on Arc
            </button>
            {[0, 1, 2].map((i) => (
              <span
                className="pointer-events-none absolute top-1/2 left-[-40px] size-2 -translate-y-1/2 bg-[var(--accent)] opacity-0"
                data-block
                key={i}
                style={{ marginLeft: i * -14 }}
              />
            ))}
          </div>
          <span className="settle-label opacity-0" data-success data-tone="ok">
            Settled on Arc · 4 shares
          </span>
        </div>
      </div>

      {/* dropdown — real list, real rows; ponytail: not Radix — its body portal
          fights the pinned/scrubbed stage, so the menu animates in place. The
          menu is the one thing here allowed a ground of its own: it floats over
          the rows it covers, and type over type is not readable. */}
      <div
        className="invisible absolute z-10 w-52 border-t border-[var(--pay-poster-rule)] bg-[var(--background)] p-1 opacity-0 shadow-[var(--shadow)]"
        data-menu
      >
        {ITEMS.map((item) => (
          <div
            className="flex items-center gap-2.5 px-2.5 py-2 text-[var(--pay-poster-dim)] data-[on=true]:text-[var(--pay-poster-fg)]"
            data-menu-item
            key={item.kind}
          >
            <span>{item.icon}</span>
            <span className="settle-label">{item.kind}</span>
          </div>
        ))}
      </div>

      {/* flying amounts. The one element on the page that gets a ground of its
          own, and it earns it: it flies across four rows of type on its way to a
          recipient, and a bare figure over other type is unreadable. So it takes
          the page's own background and nothing else — no border, no shadow, no
          pill; a figure travelling, not a badge. */}
      {ITEMS.map((item) => (
        <span
          className="bill-figure-sm invisible pointer-events-none absolute top-0 left-0 z-20 bg-[var(--background)] px-1.5 opacity-0"
          data-fly
          key={item.name}
        >
          <span className="bill-currency">$</span>
          {item.price.replace("$", "")}
        </span>
      ))}

      {/* fake cursor — makes the drag/click choreography legible */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 z-30 opacity-0 drop-shadow-[0_2px_6px_rgba(7,20,33,0.35)]"
        data-cursor
        fill="var(--text)"
        height="22"
        stroke="var(--bg)"
        strokeWidth="1.4"
        viewBox="0 0 24 24"
        width="22"
      >
        <path d="M5.5 3.2 19 12.6l-6.2 1.2-3.4 5.5z" />
      </svg>

      {/* loop-reset veil */}
      <div className="pointer-events-none absolute inset-0 z-40 bg-[var(--background)] opacity-0" data-overlay />

      {/* step rail — .bill-views, the app's own view pair: caps on a baseline,
          with a section rule under the one you are on. */}
      <nav aria-label="Demo steps" className="lp-plate-steps col-span-full mt-2">
        {STEPS.map((step, i) => (
          <button
            aria-current={i === activeStep ? "true" : undefined}
            className="iou-provider bill-toggle"
            key={step}
            onClick={() => seekRef.current(i)}
            type="button"
          >
            <span className="lp-step-num">{String(i + 1).padStart(2, "0")}</span> {step}
          </button>
        ))}
      </nav>
    </div>
  );
}
