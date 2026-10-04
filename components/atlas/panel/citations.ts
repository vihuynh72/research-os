// Numbered sources for the panel. Each view is built as a document before anything renders: its
// claims cite records through this registry, which numbers them in order of first use and keeps one
// entry per source + url + claim, so the chips and the Sources list always agree and a re-render
// never renumbers anything. Pure; browser and Node.
import type { Badge } from "../evidence.ts";

export interface CitationInput {
  source: string; // who states it: "Monarch", "Reactome", "Orphanet directory"
  url: string; // the record that shows it
  claim: string; // what the record shows, as one sentence
  badge: Badge;
  date?: string | null;
  note?: string | null; // how the link was found, when that matters (a search or a name match)
}

export interface SourceRecord extends CitationInput {
  n: number;
  date: string | null;
  note: string | null;
}

export interface CitationRegistry {
  // The numbers for these records, ascending; a record seen before keeps its number.
  cite(inputs: readonly CitationInput[]): number[];
  records(): SourceRecord[];
}

export function citationKey(input: Pick<CitationInput, "source" | "url" | "claim">): string {
  return [input.source, input.url, input.claim].join("␟");
}

export function citationRegistry(): CitationRegistry {
  const list: SourceRecord[] = [];
  const byKey = new Map<string, number>();
  return {
    cite(inputs) {
      const out = new Set<number>();
      for (const input of inputs) {
        const key = citationKey(input);
        let n = byKey.get(key);
        if (n === undefined) {
          n = list.length + 1;
          byKey.set(key, n);
          list.push({ ...input, n, date: input.date ?? null, note: input.note ?? null });
        }
        out.add(n);
      }
      return [...out].sort((a, b) => a - b);
    },
    records: () => list.map((r) => ({ ...r })),
  };
}
