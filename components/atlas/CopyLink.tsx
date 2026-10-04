"use client";

// Copies the address of what is on screen (the URL holds the whole view, see urlState.ts) and says
// so for about two seconds, to sighted and screen-reader users alike.
import { useEffect, useRef, useState } from "react";

// The Clipboard API needs a secure context and permission; where it is missing or refused, a
// selected textarea and execCommand("copy") still work in every browser.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: fall through to the textarea.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.opacity = "0";
  const focused = document.activeElement as HTMLElement | null;
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  focused?.focus({ preventScroll: true });
  return copied;
}

export default function CopyLink() {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(window.location.href);
    setMessage(ok ? "Link copied" : "Couldn’t copy. Copy the address bar instead.");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), ok ? 2000 : 4000);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={copy}
        aria-label="Copy link to this view"
        title="Copy link to this view"
        className="grid size-9 place-items-center rounded-full text-ink-2 ring-1 ring-line transition-colors ring-inset hover:bg-surface-2 hover:text-ink"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </button>
      {/* Always in the page, so screen readers hear each new message. */}
      <div role="status" aria-live="polite" className="pointer-events-none absolute top-full right-0 z-40 mt-2">
        {message && (
          <p className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[0.8125rem] font-medium whitespace-nowrap text-surface shadow-[0_8px_24px_rgb(0_0_0/0.18)]">
            {message === "Link copied" && (
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            )}
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
