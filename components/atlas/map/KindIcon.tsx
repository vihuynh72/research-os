// One kind of thing as the map draws it: diseases a solid dot, everything else a pale disc with its
// icon. Shared by the kind chips and the legend, so a kind looks the same everywhere.
import { ICON_PATH } from "@/lib/viz/icons";
import { KIND_STYLE, type MapKindInfo } from "../kinds";

export default function KindIcon({ kind, size = 16, off = false }: { kind: MapKindInfo; size?: number; off?: boolean }) {
  const style = KIND_STYLE[kind.style];
  const disease = kind.style === "disease";
  const fill = off ? "transparent" : disease ? "var(--series-1)" : style.fill;
  const ink = off ? "var(--ink-3)" : disease ? "#fff" : style.ink;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="11" fill={fill} stroke={off ? "var(--line)" : disease ? "none" : style.ink} strokeOpacity={0.5} strokeWidth="1.2" />
      <g transform="translate(5.5 5.5) scale(0.54)">
        <path d={ICON_PATH[kind.icon]} fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
