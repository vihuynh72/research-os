// Which of the relevance bar's tick labels to print. Labels closer than TICK_GAP_PX along a
// vertical bar (or wider than the room between ticks under a horizontal one) would print over each
// other: one is left out, its tick mark stays. The grade file's tier cutoffs keep their labels
// before "Direct 100". Pure, so it can be tested without a browser.
export const TICK_GAP_PX = 14;

export interface Tick {
  v: number; // 0..1
  label: string;
}

export function labelledTicks(ticks: readonly Tick[], length: number, vertical: boolean): Set<string> {
  const labelled = new Set<string>();
  if (!length) {
    for (const t of ticks) labelled.add(t.label);
    return labelled;
  }
  const direct = ticks.filter((t) => t.v >= 1);
  const tiers = ticks.filter((t) => t.v < 1);
  const kept: { at: number; half: number }[] = [];
  for (const t of [...tiers, ...direct]) {
    const at = (1 - t.v) * length;
    const half = vertical ? TICK_GAP_PX / 2 : (`${t.label} ${Math.round(t.v * 100)}`.length * 5.6 + 6) / 2;
    if (kept.every((k) => Math.abs(at - k.at) >= half + k.half)) {
      labelled.add(t.label);
      kept.push({ at, half });
    }
  }
  return labelled;
}
