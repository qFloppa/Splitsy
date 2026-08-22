import type { ReactNode } from "react";

// The demo's frame. It used to be a rounded glass browser window: three traffic
// lights, a pill for the URL, a border, a shadow, a blur. Six pieces of chrome
// to say "this is a screenshot", on a page whose whole claim is that nothing
// draws a box — and by the end the frame was more designed than the product
// inside it.
//
// So it is a printed plate instead, the same one the bills tab puts a
// photographed receipt on: a rule, a caption rail in caps, the thing itself,
// registration arms marking where it ends. The URL survives because it is the
// only part of a browser frame that was ever information.
export function BrowserFrame({
  children,
  label = "splitsy.xyz",
  note,
}: {
  children: ReactNode;
  label?: string;
  note?: string;
}) {
  return (
    <div className="lp-plate">
      <div className="lp-plate-bar">
        <span aria-hidden className="settle-label app-network">
          {label}
        </span>
        {note ? (
          <span aria-hidden className="bill-poster-fact">
            {note}
          </span>
        ) : null}
      </div>
      <div className="lp-plate-screen">{children}</div>
    </div>
  );
}
