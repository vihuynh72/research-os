// How to read the map, in three rules: distance, line, color and icon. Compact in the map's
// bottom-left corner; written out with the kind names on the start screen's side panel.
import { MAP_KINDS } from "../kinds";
import KindIcon from "./KindIcon";

function DistanceGlyph() {
  return (
    <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true" className="shrink-0" fill="none">
      <circle cx="14" cy="10" r="8.5" stroke="var(--ink-3)" strokeOpacity="0.45" strokeWidth="1.1" />
      <circle cx="14" cy="10" r="4.8" stroke="var(--ink-3)" strokeOpacity="0.45" strokeWidth="1.1" />
      <circle cx="14" cy="10" r="2.6" fill="var(--surface)" stroke="var(--accent)" strokeWidth="1.6" />
      <circle cx="18.4" cy="7.6" r="1.9" fill="var(--series-1)" />
      <circle cx="6" cy="14.2" r="1.4" fill="var(--series-1)" opacity="0.55" />
    </svg>
  );
}

function LineGlyph() {
  return (
    <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true" className="shrink-0" fill="none">
      <line x1="2" y1="5" x2="26" y2="5" stroke="var(--accent)" strokeWidth="3.4" strokeLinecap="round" />
      <line x1="2" y1="11" x2="26" y2="11" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
      <line x1="2" y1="16.5" x2="26" y2="16.5" stroke="var(--ink-2)" strokeWidth="1.4" strokeDasharray="3.5 2.5" />
    </svg>
  );
}

function PaletteGlyph() {
  return (
    <svg viewBox="0 0 28 20" width="28" height="20" aria-hidden="true" className="shrink-0">
      <circle cx="9" cy="6" r="3.6" fill="var(--series-1)" />
      <circle cx="19" cy="6" r="3.6" fill="var(--kind-bio-fill)" stroke="var(--kind-bio-ink)" strokeWidth="1" />
      <circle cx="9" cy="14.5" r="3.6" fill="var(--kind-clin-fill)" stroke="var(--kind-clin-ink)" strokeWidth="1" />
      <circle cx="19" cy="14.5" r="3.6" fill="var(--kind-res-fill)" stroke="var(--kind-res-ink)" strokeWidth="1" />
    </svg>
  );
}

export default function MapLegend({ variant = "corner" }: { variant?: "corner" | "panel" }) {
  const corner = variant === "corner";
  return (
    <div
      role="group"
      aria-label="How to read the map"
      className={corner ? "rounded-xl border border-line bg-surface/90 px-3 py-2 text-[0.75rem] leading-snug text-ink-2 shadow-sm backdrop-blur" : "text-[0.8125rem] leading-snug text-ink-2"}
    >
      <ul role="list" className={corner ? "space-y-1.5" : "space-y-2.5"}>
        <li className="flex items-center gap-2">
          <DistanceGlyph />
          <span>
            <span className="text-ink">Closer to the center</span> = more related
          </span>
        </li>
        <li className="flex items-center gap-2">
          <LineGlyph />
          <span>
            <span className="text-ink">Thicker line</span> = stronger link · dashed = inferred
          </span>
        </li>
        <li className={`flex gap-2 ${corner ? "items-center" : "items-start"}`}>
          <PaletteGlyph />
          <span className="min-w-0">
            <span className="text-ink">Color and icon</span> = kind
            {corner ? (
              <span className="ml-1.5 inline-flex translate-y-[3px] gap-1">
                {MAP_KINDS.map((k) => (
                  <span key={k.id} title={k.label}>
                    <KindIcon kind={k} size={14} />
                    <span className="sr-only">{k.label}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5">
                {MAP_KINDS.map((k) => (
                  <span key={k.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    <KindIcon kind={k} size={15} />
                    {k.label}
                  </span>
                ))}
              </span>
            )}
          </span>
        </li>
      </ul>
    </div>
  );
}
