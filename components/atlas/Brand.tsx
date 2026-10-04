"use client";

// The RareVerse mark: a ringed planet with one small moon, in the accent and one series color.
// app/icon.svg is the same drawing. The front of the ring cuts the planet with a mask, so the mark
// reads on any background.
import { useId } from "react";

// The ring, tilted: its back half runs behind the planet, its front half across it.
const RING_BACK = "M1.6 12A10.4 3 0 0 1 22.4 12";
const RING_FRONT = "M1.6 12A10.4 3 0 0 0 22.4 12";
const TILT = "rotate(-18 12 12)";

export function BrandMark({ size = 24 }: { size?: number }) {
  const cut = `rv-cut-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <defs>
        <mask id={cut}>
          <rect width="24" height="24" fill="#fff" />
          <path d={RING_FRONT} transform={TILT} fill="none" stroke="#000" strokeWidth="3.2" />
        </mask>
      </defs>
      <path d={RING_BACK} transform={TILT} fill="none" stroke="var(--accent)" strokeWidth="1.9" strokeLinecap="round" opacity="0.65" />
      <circle cx="12" cy="12" r="5.4" fill="var(--accent)" mask={`url(#${cut})`} />
      <path d={RING_FRONT} transform={TILT} fill="none" stroke="var(--accent)" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="20" cy="4.4" r="2.2" fill="var(--series-2)" />
    </svg>
  );
}

// Mark and wordmark, with the one-line tagline where there is room. Narrow phones get a smaller
// wordmark, and the narrowest keep the mark alone; the name stays for screen readers.
export function Wordmark({ tagline = false }: { tagline?: boolean }) {
  return (
    <span className="flex items-center gap-2.5 max-[370px]:gap-2">
      <BrandMark />
      <span className="text-[1.0625rem] leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-ink max-[370px]:text-[0.9375rem] max-[350px]:sr-only">
        RareVerse
      </span>
      {tagline && (
        <span className="hidden items-center gap-2.5 xl:flex">
          <span aria-hidden="true" className="h-4 w-px bg-line" />
          <span className="text-[0.8125rem] whitespace-nowrap text-ink-2">Rare diseases that share biology</span>
        </span>
      )}
    </span>
  );
}
