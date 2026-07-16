"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Camera, Check, Mail, ReceiptText, WalletCards } from "lucide-react";

import { Button } from "@/components/ui/button";
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
  { name: "Pizza", price: "$18.00", typed: "@splitsy_xyz", kind: "X handle", icon: <XIcon size={13} /> },
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
        gsap.set(menu, { left: btn0.x - 168, top: btn0.y + 16 });
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

        // ponytail: pin the parent section via closest() instead of threading a
        // ref through BrowserFrame — one line vs. a prop drill.
        const section = stage.closest("section");
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
    <div className="relative grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:p-7" ref={stageRef}>
      <p className="sr-only">
        Animated product demo: a receipt from Café Arc is dragged into the upload area and scanned. Four line items are
        detected: Pizza, Coffee, Dessert, and Taxi. Each item is assigned to a person by X handle, Discord username,
        email address, or wallet address, then the split is written to Arc and settled in USDC.
      </p>

      {/* LEFT · upload pane */}
      <div>
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <Camera className="text-[var(--accent)]" size={16} /> Upload bill
        </p>
        <div
          className="scan-surface upload-focus relative mt-3 flex min-h-[22rem] items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-[var(--receipt)] p-5"
          data-dropzone
        >
          <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center opacity-0"
            data-drop-hint
          >
            <Camera className="text-[var(--accent)]" size={34} />
            <p className="mt-3 text-base font-semibold text-[var(--receipt-text)]">Upload the bill</p>
            <p className="mt-1 text-xs text-[var(--receipt-muted)]">Click to browse or drag &amp; drop an image</p>
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
            <div className="settlement-stamp absolute right-2 top-9 text-[10px]" data-stamp>
              Settled on Arc
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT · split pane */}
      <div className="relative flex flex-col">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <ReceiptText className="text-[var(--accent)]" size={16} /> Split the bill
        </p>

        <div className="relative mt-3">
          <p className="absolute inset-x-0 top-3 text-sm text-[var(--text-muted)] opacity-0" data-right-empty>
            Scan a receipt to start a split…
          </p>
          <div className="space-y-1.5">
            {ITEMS.map((item, i) => (
              <div
                className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5"
                data-item-row
                key={item.name}
              >
                <span className="receipt-index">{String(i + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{item.name}</span>
                <span className="amount-text text-sm font-semibold text-[var(--text)]" data-fly-source>
                  {item.price}
                </span>
                <span className="relative flex w-[46%] min-w-0 items-center justify-end sm:w-[42%]">
                  <button
                    className="absolute right-0 rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-xs font-bold text-[var(--text-soft)] opacity-0"
                    data-split-btn
                    tabIndex={-1}
                    type="button"
                  >
                    Split with…
                  </button>
                  {/* ponytail: focus ring is visual-only ([data-focus] styling) — calling
                      .focus() from the timeline would steal real page focus mid-scroll. */}
                  <span
                    className="flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-semibold text-[var(--text)] transition-shadow duration-[var(--dur-1)] data-[focus=true]:border-[var(--accent)] data-[focus=true]:shadow-[0_0_0_3px_var(--accent-soft)]"
                    data-assignee-chip
                  >
                    <span className="shrink-0 text-[var(--text-soft)]">{item.icon}</span>
                    {item.short ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="mono truncate" data-typed>
                            {item.short}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="mono">{FULL_ADDRESS}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className={`truncate ${item.mono ? "mono" : ""}`} data-typed>
                        {item.typed}
                      </span>
                    )}
                    <span className="lp-caret opacity-0" data-caret />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* recipients */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          {ITEMS.map((item) => (
            <div
              className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2"
              data-recipient
              key={item.kind}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-strong)] text-[var(--text-soft)]">
                {item.icon}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[11px] font-bold text-[var(--text)] ${item.mono ? "mono" : ""}`}>
                {item.short ?? item.typed}
              </span>
              <span className="amount-text shrink-0 text-[11px] font-bold text-[var(--success)]" data-chip-amount>
                {item.price}
              </span>
            </div>
          ))}
        </div>

        {/* write on arc */}
        <div className="relative mt-4 overflow-hidden rounded-[var(--radius)]">
          <Button className="w-full will-change-transform" data-write size="lg" tabIndex={-1}>
            Write on Arc
          </Button>
          {[0, 1, 2].map((i) => (
            <span
              className="pointer-events-none absolute top-1/2 left-[-40px] size-2 -translate-y-1/2 rounded-[3px] bg-[var(--arc-cyan)] opacity-0"
              data-block
              key={i}
              style={{ marginLeft: i * -14 }}
            />
          ))}
        </div>
        <p className="status-dot status-ok mt-3 gap-1.5" data-success>
          <Check size={13} /> Successfully settled on Arc
        </p>
      </div>

      {/* dropdown — real list, real rows; ponytail: not Radix — its body portal
          fights the pinned/scrubbed stage, so the menu animates in place. */}
      <div
        className="invisible absolute z-10 w-52 rounded-lg border border-[var(--border)] bg-[var(--surface-strong)] p-1 opacity-0 shadow-[var(--shadow)]"
        data-menu
      >
        {ITEMS.map((item) => (
          <div
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-semibold text-[var(--text)] data-[on=true]:bg-[var(--accent-soft)]"
            data-menu-item
            key={item.kind}
          >
            <span className="text-[var(--text-soft)]">{item.icon}</span>
            {item.kind}
          </div>
        ))}
      </div>

      {/* flying amounts */}
      {ITEMS.map((item) => (
        <span
          className="amount-text invisible pointer-events-none absolute top-0 left-0 z-20 rounded-full border border-[var(--border)] bg-[var(--surface-strong)] px-2 py-0.5 text-xs font-bold text-[var(--text)] opacity-0 shadow-[var(--shadow-soft)]"
          data-fly
          key={item.name}
        >
          {item.price}
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
      <div className="pointer-events-none absolute inset-0 z-40 bg-[var(--surface)] opacity-0" data-overlay />

      {/* step rail */}
      <nav aria-label="Demo steps" className="col-span-full mt-1 flex flex-wrap items-center justify-center gap-1.5">
        {STEPS.map((step, i) => (
          <button
            className={`rounded-full px-3 py-1 text-xs font-bold transition-colors duration-[var(--dur-1)] ${
              i === activeStep
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
            key={step}
            onClick={() => seekRef.current(i)}
            type="button"
          >
            {step}
          </button>
        ))}
      </nav>
    </div>
  );
}
