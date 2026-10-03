// Variant effect read from HGVS-style names such as "NM_000310.4(PPT1):c.138C>A (p.Cys46Ter)".
// This parses the notation; it is not a curated consequence, so every grade that uses it carries
// the flag derived_from_variant_notation. A name we cannot read is "unknown", never a guess.

export type VariantEffect = "lof" | "missense" | "other" | "unknown";

export const VARIANT_EFFECT_LABEL: Record<VariantEffect, string> = {
  lof: "loss of function",
  missense: "missense",
  other: "other (in-frame or synonymous)",
  unknown: "unknown",
};

export interface VariantCounts {
  lof: number;
  missense: number;
  other: number;
  unknown: number;
}

export function classifyVariant(label: string): VariantEffect {
  const name = label.trim();

  // Copy-number calls, e.g. "GRCh38/hg38 11p15.4(chr11:4793595-7562692)x1": x0 or x1 loses a copy.
  const copies = /\)x(\d+)$/.exec(name);
  if (copies) return Number(copies[1]) <= 1 ? "lof" : "other";

  // The protein change is the most direct statement of the effect when the name gives one.
  const protein = /\bp\.\(?([^\s()]+)\)?/.exec(name);
  const fromProtein = protein ? proteinEffect(protein[1]) : null;
  if (fromProtein) return fromProtein;

  const cdna = /\bc\.(\S+)/.exec(name);
  return cdna ? cdnaEffect(cdna[1]) : "unknown";
}

export function countEffects(labels: Iterable<string>): VariantCounts {
  const counts: VariantCounts = { lof: 0, missense: 0, other: 0, unknown: 0 };
  for (const label of labels) counts[classifyVariant(label)] += 1;
  return counts;
}

function proteinEffect(change: string): VariantEffect | null {
  if (change === "?" || change === "") return null; // consequence not stated: read the cDNA instead
  if (/^0\??$/.test(change)) return "lof"; // no protein made
  if (change.includes("fs")) return "lof"; // frameshift
  if (/^(Met|M)1(?!\d)/.test(change)) return "lof"; // start codon lost
  if (/^(Ter|\*)\d/.test(change) || change.includes("ext")) return "other"; // stop lost: the protein runs on
  if (/(Ter|\*|X)$/.test(change)) return "lof"; // premature stop (nonsense)
  if (change.endsWith("=")) return "other"; // synonymous
  const three = /^([A-Z][a-z]{2})\d+([A-Z][a-z]{2})$/.exec(change);
  if (three) return three[1] === three[2] ? "other" : "missense";
  const one = /^([A-Z])\d+([A-Z])$/.exec(change);
  if (one) return one[1] === one[2] ? "other" : "missense";
  if (/del|dup|ins/.test(change)) return "other"; // in-frame deletion, duplication or insertion
  return null;
}

interface Position {
  region: "utr5" | "cds" | "utr3";
  base: number; // ordinal along the transcript; c.-1 sits right before c.1
  offset: number; // intronic offset: c.461-2 has base 461, offset -2
}

const UTR3_ORIGIN = 1e9; // c.*1 comes after every coding base

function parsePosition(text: string): Position | null {
  const m = /^([-*]?)(\d+)(?:([+-])(\d+))?$/.exec(text);
  if (!m) return null;
  const n = Number(m[2]);
  const region = m[1] === "-" ? "utr5" : m[1] === "*" ? "utr3" : "cds";
  const base = region === "utr5" ? 1 - n : region === "utr3" ? UTR3_ORIGIN + n : n;
  const offset = m[3] ? (m[3] === "+" ? 1 : -1) * Number(m[4]) : 0;
  return { region, base, offset };
}

const CANONICAL_SPLICE = new Set([-2, -1, 1, 2]);

// True when the change touches a canonical splice site (intron positions +1/+2 or -1/-2),
// including deletions that run across one, such as c.54_62+11del.
function touchesCanonicalSplice(start: Position, end: Position): boolean {
  if (CANONICAL_SPLICE.has(start.offset) || CANONICAL_SPLICE.has(end.offset)) return true;
  if (start.base === end.base) {
    return (start.offset <= -1 && end.offset >= -2) || (start.offset <= 2 && end.offset >= 1);
  }
  // Exonic coordinates are numbered continuously, so a purely exonic range crosses no intron.
  if (start.offset === 0 && end.offset === 0) return false;
  // Both ends deep inside the same intron.
  if (start.offset > 0 && end.offset < 0 && end.base === start.base + 1) return false;
  return true;
}

function insertedLength(text: string): number | null {
  if (/^[ACGTN]+$/.test(text)) return text.length;
  const counted = /^(?:\((\d+)\)|N\[(\d+)\])$/.exec(text);
  return counted ? Number(counted[1] ?? counted[2]) : null;
}

const SPOT = "\\([^)]*\\)|[-*]?\\d+(?:[+-]\\d+)?";
const CDNA = new RegExp(`^(${SPOT})(?:_(${SPOT}))?(.*)$`);

function cdnaEffect(text: string): VariantEffect {
  const m = CDNA.exec(text);
  if (!m) return "unknown";
  const [, startText, endText, change] = m;
  if (startText.startsWith("(") || endText?.startsWith("(")) {
    // Uncertain breakpoints, e.g. c.(?_-1)_(124+1_125-1)del, describe deletions of whole exons.
    return /^del(?!ins)/.test(change) ? "lof" : "unknown";
  }
  const start = parsePosition(startText);
  const end = endText ? parsePosition(endText) : start;
  if (!start || !end) return "unknown";
  if (touchesCanonicalSplice(start, end)) return "lof";
  if (start.offset !== 0 || end.offset !== 0) return "unknown"; // deeper in an intron: effect not readable

  const losesStartCodon =
    (start.region === "cds" && start.base <= 3) || (start.region === "utr5" && end.region !== "utr5");
  if (change.includes(">")) return start.region === "cds" && start.base <= 3 ? "lof" : "unknown";
  if (/^(del|dup)(?!ins)/.test(change)) {
    if (losesStartCodon) return "lof";
    if (start.region !== "cds" || end.region !== "cds") return "unknown";
    return (end.base - start.base + 1) % 3 === 0 ? "other" : "lof";
  }
  if (change.startsWith("delins")) {
    const inserted = insertedLength(change.slice("delins".length));
    if (inserted === null || start.region !== "cds" || end.region !== "cds") return "unknown";
    if (losesStartCodon) return "lof";
    return (end.base - start.base + 1 - inserted) % 3 === 0 ? "other" : "lof";
  }
  if (change.startsWith("ins")) {
    const inserted = insertedLength(change.slice("ins".length));
    if (inserted === null || start.region !== "cds") return "unknown";
    return inserted % 3 === 0 ? "other" : "lof";
  }
  return "unknown";
}
