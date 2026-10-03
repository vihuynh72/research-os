// SimGIC (Pesquita et al. 2008): information-content-weighted Jaccard over ancestor-closed
// term sets. Shared rare symptoms count far more than shared common ones, and a specific term
// gives partial credit to its broader ancestors ("focal seizure" also shares "seizure").
// Used by the engine (lib/grading) and by scripts/build-hpo-reference.ts for the null model,
// so a disease pair and a random pair are always scored the same way.

// The ontology root and "Phenotypic abnormality" carry no information and are left out.
export const UNINFORMATIVE_TERMS: ReadonlySet<string> = new Set(["HP:0000001", "HP:0000118"]);

export function closeTerms(
  terms: Iterable<string>,
  ancestorsOf: (id: string) => readonly string[] | undefined,
): Set<string> {
  const closed = new Set<string>();
  for (const term of terms) {
    if (!UNINFORMATIVE_TERMS.has(term)) closed.add(term);
    for (const ancestor of ancestorsOf(term) ?? []) {
      if (!UNINFORMATIVE_TERMS.has(ancestor)) closed.add(ancestor);
    }
  }
  return closed;
}

export function simgic(x: ReadonlySet<string>, y: ReadonlySet<string>, ic: (id: string) => number): number {
  let shared = 0;
  let union = 0;
  for (const term of x) {
    const weight = ic(term);
    union += weight;
    if (y.has(term)) shared += weight;
  }
  for (const term of y) {
    if (!x.has(term)) union += ic(term);
  }
  return union > 0 ? shared / union : 0;
}
