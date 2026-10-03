# How the atlas grades related diseases (engine 0.2.0)

This is the reference for the grading engine in `lib/grading/`. It explains how the atlas decides which diseases are related to the one a family searched for, how strongly, why, and where the numbers come from. It is written for the team, for the judges, and for a mentor who wants to check or correct a grade.

Four rules shape everything:

- **Three scores, never mixed.** *Biology* (same gene, same kind of variant, same molecular mechanism) answers "who shares our biology?" and is the only number that sets distance on the map. *Clinical resemblance* (symptoms, onset, inheritance) answers "who looks like us?" and is shown beside it. *Collaboration* (shared patient groups, papers, studies, grants, researchers, registries) answers "who already works alongside us?" and never moves a disease.
- **The engine computes, the AI reviews.** Every number, tier, cluster and coordinate comes from deterministic code. AI judgments can only lower a biology tier or add a caveat (section 11).
- **No number without a source.** Every shared item carries the ids of the edges that support it, and every edge carries a source, a URL, a date and a kind (observed, inferred or contradicted). The hand-curated facts carry a sentence quoted verbatim from their source.
- **A test holds the engine to an answer key.** `data/curated/answer_key.json` says which CLN pairs share the most biology according to the literature; `lib/grading/answer-key.test.ts` fails if the grades disagree (section 9).

The tunable constants quoted here live in `lib/grading/config.ts` and are copied into the `meta` block of each relevance file (or stated in `meta.notes`), so a grade can always be traced to the settings that produced it. A few fixed rules sit next to the code that applies them in `lib/grading/dimensions.ts`: the variant and onset status cutoffs, "mostly loss-of-function" (2 of 3), and the 0.9 symptom score above which the wording says "as much as two records of the same disease". The data contract is `lib/grading/types.ts`.

## 1. Inputs and outputs

| | File | Made by |
|---|---|---|
| Graph | `public/graph.json` (real graph) or `public/graph.sample.json` (5-disease CLN seed plus the curated facts) | Jaspaal's pipeline / `npm run data:sample` |
| Curated facts | `data/curated/ncl_facts.json`: what each seed gene's protein is and does, and each disease's onset and inheritance, with verbatim quotes | hand-curated (Vi) |
| Answer key | `data/curated/answer_key.json`: expected biology rating (high, medium, low) for the 10 CLN pairs | literature; a mentor may overwrite it |
| Symptom reference | `data/reference/hpo-reference.json`: HPO labels, information content, specificity, ancestors, the random-pair null model and the same-disease anchor | `npm run data:hpo` |
| AI judgments (optional) | `public/judgments.json` | the AI grading workflow (`docs/agents/grader-agent-prompt.md`) |
| **Relevance** | `public/relevance.json` or `public/relevance.sample.json` | `npm run grade` |
| **Bundles** | `data/grading/bundles.json` or `data/grading/bundles.sample.json`: one evidence packet per graded pair, for the AI workflow | `npm run grade` |

The relevance file holds, for every disease, its biology neighbors (at most `MAX_NEIGHBORS` = 10, the map), its clinical look-alikes (`clinical_neighbors`, at most 10), its cluster, centrality, bridge flag and 3D coordinates; for every pair in the output, the three scores, the biology tier and the clinical tier with a plain reason each, and all eleven dimension results; the clusters; the collaboration bridges; and `node_info`: for each symptom, its information content, specificity and HPO aspect, and for each mechanism, its weight in this atlas and how many diseases reach it.

The same inputs always give byte-identical outputs: keys and arrays are sorted, floats are rounded to `ROUND` = 4 decimals, and `generated_at` equals the graph's own `generated_at` instead of the clock. `npm run grade:check` recomputes everything and fails if a byte differs from the files on disk; CI runs it on every push, after `npm test`.

The engine is graph-agnostic. Dimensions are derived from node types and edge endpoints, never from relation names, so the same code grades the CLN seed and the real graph.

## 2. What v1 got wrong

Vi caught it: in engine 0.1.0 every CLN pair scored between 0.85 and 0.88 and nine of ten were "strong". That says "both are NCLs", which a family already knows, and nothing about which NCL is closer. Two causes:

1. **The only mechanism was the family's definition.** The seed's one mechanism node, `PW:NCL-LYSOSOME` "Lysosomal lipofuscin accumulation", is linked to all five diseases. v1 weighted it 1, so every pair got the mechanism's full contribution (0.60 under v1's cap).
2. **Symptoms were calibrated against random disease pairs only.** v1 scored 0 at the 90th and 1 at the 99.9th percentile of random pairs. Any two NCLs beat more than 99% of random pairs (every seed pair sits between the 99.1st and the 99.92nd percentile, see section 8), so the symptom score saturated near 1 for every pair, and 1 - 0.4 x (1 - 0.6 x 0.92) = 0.82 was a floor no pair could fall under.

v2 fixes both and keeps them apart:

- Mechanisms are weighted by how few diseases in the atlas share them, and a pair scores its **most specific** shared mechanism (section 4). The family-wide process now counts for little; the curated protein-level facts tell the subtypes apart.
- Symptoms are scaled between two empirical anchors from HPO, "unrelated" and "the same disease described twice" (section 5), and moved to their own score, clinical resemblance. The NCLs do look alike clinically, so that score is high for most pairs, and it is shown, not hidden; it just no longer decides who shares biology.

## 3. Eleven dimensions in three families

| Family | Dimension | UI label | What is compared | Cap |
|---|---|---|---|---|
| biology | `gene` | Same gene | Gene nodes linked to each disease | 0.7 |
| biology | `variant` | Variant type | Share of loss-of-function variants, read from HGVS notation (a modifier) | 0.25 |
| biology | `mechanism` | Same mechanism | Mechanism nodes linked to the disease or to its genes; the most specific shared one | 0.8 |
| clinical | `phenotype` | Shared symptoms | HPO symptom profiles, information-weighted (SimGIC) and scaled between two anchors | 0.75 |
| clinical | `disease` | Onset and inheritance | HPO onset step and mode of inheritance (a modifier) | 0.4 |
| collaboration | `patient_org` | Patient groups | Groups linked to the disease, or to its mechanism or gene | 0.5 |
| collaboration | `paper` | Papers | Papers linked to the disease | 0.3 |
| collaboration | `trial` | Clinical studies | Studies linked to the disease | 0.4 |
| collaboration | `grant` | Research grants | Grants linked to the disease | 0.3 |
| collaboration | `investigator` | Researchers | Researchers linked to the disease, or to its grants, papers or studies | 0.4 |
| collaboration | `asset` | Registries and assets | Registries and other assets linked to the disease, or to its mechanism or gene | 0.5 |

Why biology and clinical resemblance are separate: two diseases can look alike and be broken in different ways. The NCLs are the textbook case: CLN1 and CLN3 share 13 symptoms, 5 of them rare, yet CLN1 is a missing soluble enzyme and CLN3 a missing membrane protein, so an enzyme replacement that helps one cannot help the other. A family looking for shared research or therapies needs the biology answer; a family comparing what their child goes through needs the clinical one. The product shows both (Vi's decision).

"Linked" means any edge in either direction whose kind is not `contradicted`. Contradicted edges never add to a score; when one touches the items of a pair, the pair gets the flag `contradicted_evidence`, and on a biology dimension its tier is capped (section 7).

Each dimension returns a `DimensionResult`:

- `score` from 0 to 1, the only input to synthesis;
- `status`: `match`, `partial`, `none` (both sides have data, nothing in common), or `unknown` (a side has no data, so nothing can be said);
- `coverage`: how many items each disease has in this dimension;
- `shared`: the shared items, each with the ids of every edge that ties both diseases to it;
- `support`: `observed` if some shared item rests only on observed edges on both sides, `inferred` if items are shared but none that way, `null` if nothing is shared;
- `summary`: one deterministic plain-language sentence or two;
- `flags`: coded caveats from `FLAGS` in `types.ts`;
- `details`: the numbers behind the score (for example `most_specific`, `n` and `N` for a mechanism, `raw` for symptoms, the onset steps compared).

## 4. Biology

**Gene.** Score 1 if the diseases share a gene, else 0. Status `unknown` when a side has no gene. A shared gene always gets the flag `same_gene_allelic`: the same gene can act through different mechanisms (loss of function in one disease, a toxic gain of function in another).

**Mechanism: specificity within the atlas.** A mechanism shared by every disease in the atlas cannot tell any two of them apart. For a mechanism reached by `n` of the atlas's `N` diseases (directly or through a gene):

```
specificity = clamp((1 - ln n / ln N) / (1 - ln 2 / ln N), 0, 1)     (1 when N < MIN_ATLAS_FOR_SPECIFICITY = 3)
weight      = max(MECHANISM_FLOOR, specificity) x size weight         MECHANISM_FLOOR = 0.15
```

This is information content (Resnik) normalized so that a mechanism shared by exactly two diseases weighs 1 and one shared by all weighs 0, floored at 0.15 so the family's defining process still counts a little. The size weight is 1 unless the node records how many genes it spans (`attributes.gene_count`): then `clamp(1 - ln(gene_count) / ln(20000), 0.1, 1)`, about 0.70 for a 20-gene pathway and 0.23 for 2,000 genes.

**Mechanism: the most specific shared one (MICA).** The pair's score is the weight of the most specific mechanism both diseases reach (Resnik's "most informative common ancestor"), not an overlap ratio: two enzymes with different substrates still share "soluble lysosomal enzyme", and that, not their substrates, decides whether a therapy can transfer. Status `match` at `MECHANISM_STATUS.match` = 0.6 or more, `partial` when anything is shared, `none` when both have mechanisms but share none, `unknown` when a side has none. The flag `family_level_only` marks pairs whose only shared mechanisms sit at the floor. The dimension's support follows the mechanism that carries the score.

The NCL example. The seed has `N` = 5 diseases. The curated facts (`data/curated/ncl_facts.json`, from Zhang et al. 2025 and Nelvagal et al. 2022) add seven mechanism nodes, linked from the five genes:

| Mechanism | Diseases reaching it | n | Weight |
|---|---|---|---|
| Soluble lysosomal enzyme missing | CLN1 (PPT1), CLN2 (TPP1) | 2 | 1 |
| Lysosomal membrane protein | CLN3, CLN7 (MFSD8) | 2 | 1 |
| Transport across the lysosomal membrane | CLN3, CLN7 | 2 | 1 |
| Membrane protein missing | CLN3, CLN6, CLN7 | 3 | 0.5575 |
| Lysosomal lipofuscin accumulation (the seed's family mechanism) | all five | 5 | 0.15 (floor) |
| Removing palmitate from proteins / Trimming small peptides / Sending new lysosomal enzymes out of the ER | one each | 1 | 1 (never shared) |

So CLN1-CLN2 score 1 ("Both are missing a soluble lysosomal enzyme (2 of 5 diseases here)."), CLN3-CLN6 score 0.5575 ("Both are missing a membrane protein (3 of 5 diseases here)."), and CLN1-CLN3 score 0.15 with `family_level_only` ("They share only the family-wide process Lysosomal lipofuscin accumulation (all 5 diseases here), which does not tell them apart."). The seed's family mechanism and its edges are kept unchanged.

**Variant type (a modifier).** Variants linked to the disease or to its genes. Each label is classified from its HGVS notation (`lib/grading/variants.ts`); the protein change is read first when the name states one, then the cDNA change:

| Class | Notation it reads |
|---|---|
| loss of function | nonsense (`p.Cys46Ter`), frameshift (`fs`, or a cDNA deletion, duplication or insertion whose length is not a multiple of 3), start loss (`p.Met1...`, or a change in `c.1` to `c.3`), canonical splice site (`+1`, `+2`, `-1`, `-2`, including deletions that run across one, such as `c.54_62+11del`), whole-exon deletions, copy-number loss (`x1`, `x0`) |
| missense | one amino acid replaced by another (`p.Thr75Asn`) |
| other | synonymous, in-frame deletion, duplication or insertion, stop lost |
| unknown | anything it cannot read, such as "Single allele" or a change deeper in an intron |

For each disease, `f` = loss-of-function variants / classified variants. With at least 2 classified variants on each side, `score = 1 - |fA - fB|`; `match` at 0.75 or more, `partial` at 0.4 or more, else `none`. With fewer, the status is `unknown` with the flag `variant_effect_unknown`. A side is "mostly loss-of-function" at `f` >= 2/3 and "mostly missense or in-frame" at `f` <= 0.2 (compared on exact fractions, so 2 of 3 counts); one side of each kind sets `variant_type_conflict`. The flag `derived_from_variant_notation` is set whenever a type was read, and the support is `inferred` whenever the score is above 0: notation suggests an effect, it does not prove one.

**The biology modifier rule.** Variant type counts toward biology only when the pair shares a gene or a mechanism (status `match` or `partial`). Otherwise every two diseases with mostly loss-of-function variants would look related.

## 5. Clinical resemblance

### Symptoms: information content and SimGIC

Two diseases that both cause seizures have something in common, but so do hundreds of unrelated diseases. Two diseases that both show "increased neuronal autofluorescent lipopigment" share something rare and telling. Each symptom is weighted by how informative it is.

**Information content.** For an HPO term `t`, with `N` diseases in HPO's annotation file (`phenotype.hpoa`) and `n_t` of them annotated with `t` or one of its descendants: `ic(t) = -ln(n_t / N) / ln(N)`, from 0 (every disease) to 1 (a single disease). A symptom counts as **rare** at `ic >= SPECIFIC_IC` = 0.5 and as **generic** below `GENERIC_IC` = 0.3.

**Specificity** is the same rarity as a share, for display: the mid-rank percentile of the term's `ic` among all 267,580 recorded disease-symptom annotations (distinct disease-term pairs whose term is a phenotypic abnormality; `NOT` rows skipped): (annotations with a lower `ic` + half of those with the same `ic`) / all. "More specific than 92.5% of recorded symptoms" reads better than "ic 0.7567". It sizes symptoms on the map; grading uses `ic`.

The current reference (HPO release 2026-09-01, annotations of 2026-09-02) has N = 12,880 diseases. Some symptoms from the seed:

| HPO term | ic | specificity | reads as |
|---|---|---|---|
| Intellectual disability (HP:0001249) | 0.1412 | 0.0096 | generic |
| Seizure (HP:0001250) | 0.1495 | 0.0233 | generic |
| Cerebral atrophy (HP:0002059) | 0.2963 | 0.1866 | generic |
| Progressive visual loss (HP:0000529) | 0.5134 | 0.6545 | rare |
| Vacuolated lymphocytes (HP:0001922) | 0.7211 | 0.9012 | rare |
| Increased neuronal autofluorescent lipopigment (HP:0002074) | 0.7567 | 0.9251 | rare |
| Reduced tissue tripeptidyl peptidase 1 activity (HP:6000571) | 1 | 0.9955 | rare |

**SimGIC** (Pesquita et al. 2008, `lib/grading/simgic.ts`). Each disease's symptom set is closed upward: every annotated term brings all its ancestors, so "focal seizure" also counts as "seizure". The ontology root (`HP:0000001`) and "Phenotypic abnormality" (`HP:0000118`) are left out. Then `SimGIC(A, B)` = sum of ic over terms in both closures / sum of ic over terms in either closure.

A tiny worked example (a toy ontology with made-up information content, to show the arithmetic):

| Term | Parent | ic |
|---|---|---|
| Abnormality of the nervous system | root | 0.05 |
| Seizure | nervous system | 0.25 |
| Focal seizure | Seizure | 0.45 |
| Lipopigment storage | nervous system | 0.90 |
| Abnormality of the eye | root | 0.08 |
| Retinal degeneration | eye | 0.55 |

Disease A has Focal seizure, Retinal degeneration and Lipopigment storage; its closure is {Focal seizure, Seizure, nervous system, Retinal degeneration, eye, Lipopigment storage}. Disease B has Seizure and Lipopigment storage; its closure is {Seizure, nervous system, Lipopigment storage}. Shared: 0.25 + 0.05 + 0.90 = 1.20. Union: 0.45 + 0.25 + 0.05 + 0.55 + 0.08 + 0.90 = 2.28. SimGIC = 0.53. Without the one rare shared term the pair scores 0.30 / 1.38 = 0.22: one rare symptom in common counts for more than several common ones.

Only terms of HPO aspect `P` (phenotypic abnormality) count as symptoms; inheritance (`I`) and onset or course (`C`) terms go to the onset and inheritance dimension. Obsolete ids map to their replacement when HPO names one, and are dropped otherwise.

### Two anchors: unrelated, and the same disease described twice

A raw SimGIC means nothing on its own. The scale is set by two measurements on HPO's own corpus, stored in the reference and recomputed by `npm run data:hpo`:

- **Random pairs (unrelated).** SimGIC, computed exactly as for a real pair, of 20,000 random pairs of distinct diseases (12,867 diseases with symptom annotations; seeded generator mulberry32, seed 20261003):

  | Quantile of random pairs | 50% | 75% | 90% | 95% | 99% | 99.9% | max |
  |---|---|---|---|---|---|---|---|
  | SimGIC | 0.0157 | 0.0405 | 0.0765 | 0.1036 | 0.1636 | 0.2777 | 0.8197 |

- **Same disease, two records.** HPO annotates many diseases twice, once from an OMIM record and once from an Orphanet record, by different curators. For every disease name (lower-cased, punctuation collapsed) with both records, each with at least 5 symptoms, the first OMIM and the first Orphanet id form a pair: 497 pairs.

  | Quantile of same-disease pairs | min | 25% | median | 75% | max |
  |---|---|---|---|---|---|
  | SimGIC | 0.0560 | 0.2446 | 0.3173 | 0.3932 | 0.8401 |

The symptom score places a pair between the two:

```
percentile = position of raw SimGIC among the random pairs (linear between stored quantiles)
score      = 0                                         if percentile < SYMPTOM_GATE_PERCENTILE (0.95)
           = clamp((raw - 0.1636) / (0.3173 - 0.1636), 0, 1) otherwise
```

0.1636 is the 99th percentile of random pairs (`SYMPTOM_FLOOR_PERCENTILE`), 0.3173 the median of the same-disease pairs (`SYMPTOM_TOP_FALLBACK` = 0.32 is used only if a reference lacks the anchor). Both numbers are copied into `meta.symptom_scale`. Status: `match` at a score of 0.6 or more, `partial` at 0.25 or more (`PHENOTYPE_STATUS`). The plain words follow the anchors: at 0.9 or more "They overlap about as much as two records of the same disease."; above 0 "They overlap more than unrelated diseases, less than two records of one disease."; below that "a little more than most unrelated diseases, not enough to count" or "no more than many unrelated diseases do". The raw SimGIC and the percentile stay in the result for researchers.

Why not a fixed "70% match": three in four pairs of records of the very same disease stay under 0.3932, so a fixed 70% bar would call almost nothing similar, not even one disease described twice. Curators record different features, and SimGIC divides by the union. The anchors answer the questions that matter: is this more overlap than chance, and how close is it to the same disease?

Several NCL pairs score above the same-disease median: clinically, the NCLs look as alike as one disease described twice (CLN2-CLN6 0.4091, CLN2-CLN3 0.3811, CLN1-CLN3 0.3640). That is the measurement behind "show both scores".

Flags: `generic_symptoms_only` (something is shared, but every shared term has ic below 0.3), `few_annotations` (a disease has fewer than `MIN_ANNOTATIONS` = 10 symptoms; the summary names it). Without a reference file the engine falls back to a plain Jaccard overlap of the annotated ids (`PHENOTYPE_STATUS_UNCALIBRATED`: match >= 0.3, partial >= 0.15) with the flag `uncalibrated`.

### Onset and inheritance (dimension `disease`)

Two facets from HPO terms linked to the disease:

- **Onset**: the step on the onset ladder `ONSET_LADDER` (congenital, neonatal, infantile, childhood, juvenile, adult; a finer term such as "Late onset" counts as its step). Same step 1, neighbouring steps 0.5, further apart 0; the closest pair of steps across the two diseases counts.
- **Inheritance**: 1 if the diseases share a mode of inheritance (an identical aspect-`I` term), 0 if both have one and none is shared.

`score` = `DISEASE_FACET_WEIGHTS` (onset 0.8, inheritance 0.2) over the facets on record for both, renormalized; `unknown` when neither facet is on record for both. Status `match` at 0.75 or more, `partial` at 0.5 or more. Example summary: "Onset: juvenile vs childhood (neighbouring). Both autosomal recessive." When an onset edge's evidence says "Sources disagree:", the pair gets the flag `sources_disagree` and the summary adds "Sources disagree on the onset of CLN2; a clinician should confirm." The edges of both onsets compared are listed in `details.onset_edges`, so a reviewer can read both claims even when the steps differ. A disease's name or category is never used.

For the seed, onset and inheritance come from `ncl_facts.json`: onset from Zhang et al. 2025 (Table 1 or text, with the quoted age range on the edge), inheritance from HPO's annotation of each disease's OMIM record (all five autosomal recessive).

**The clinical modifier rule.** Onset and inheritance count toward clinical resemblance only once the symptoms score above 0, that is, overlap more than 99% of random pairs. Being autosomal recessive with infantile onset is common, and on its own does not make two diseases look alike. The clinical reason says so when it applies: "Onset and inheritance only count once the symptoms overlap."

## 6. Collaboration

For patient groups, papers, studies, grants, researchers and assets, `n` = number of shared items and `score = 1 - 0.5^n` (`COLLAB_BASE` = 0.5): one shared item gives 0.5, two give 0.75, three 0.875. Patient groups and assets also count when they are linked to the disease's mechanism or gene (flag `via_mechanism`; the item records the node it passes through in `via`). Researchers also count through the disease's grants, papers or studies. Status `match` with at least one shared item, `none` when both sides have items but share none, `unknown` with the flag `no_data` when a side has none.

A shared item linked to at least `UMBRELLA_SHARE` = 80% of the graph's diseases (once the graph has `UMBRELLA_MIN` = 4 diseases) gets the flag `umbrella_resource`: a federation or registry for a whole disease family says little about any one pair, so it is never drawn as a bridge. A shared study whose status is withdrawn, terminated or unknown gets `inactive_or_withdrawn`.

**Provenance of a shared item.** Its `edges` are every edge on the paths that tie both diseases to it; its `kind` is `observed` or `inferred` when all those edges agree, else `mixed`. Overlap that comes only from related (ancestor) symptom terms, or from neighbouring onset steps, is computed by the engine, not stated by a source, so it counts as `inferred`.

## 7. Putting it together

**Noisy-OR with caps, per family.**

```
biology       = 1 - (1 - 0.7 x gene)(1 - 0.8 x mechanism)(1 - 0.25 x variant*)     relevance = biology
clinical      = 1 - (1 - 0.75 x symptoms)(1 - 0.4 x onset and inheritance*)
collaboration = 1 - product over the six collaboration dimensions of (1 - cap x score)
```

`*` modifier: counts only under the modifier rules above. The cap is how far one line of evidence can move a pair on its own; agreement is what makes a link strong, and no combination reaches 1, because two different diseases are never the same disease.

| Evidence | biology |
|---|---|
| Most specific shared mechanism weighs 1, variant types agree (score 1) | 1 - 0.2 x 0.75 = 0.85 |
| Mechanism 1, variant types partly agree (0.6667) | 1 - 0.2 x 0.8333 = 0.8333 |
| Mechanism 0.5575 (3 of 5 diseases), variant 0.6667 | 1 - 0.554 x 0.8333 = 0.5383 |
| Family-wide mechanism only (0.15), variant types agree | 1 - 0.88 x 0.75 = 0.34 |
| Family-wide mechanism only, variant 0.6667 | 1 - 0.88 x 0.8333 = 0.2667 |
| Shared gene only | 0.70 |

**Biology tiers.** `TIER_THRESHOLDS`: strong >= 0.75, moderate >= 0.45, exploratory >= 0.2, else none (not shown). Caps only ever lower a tier:

1. Strong needs at least two **lines of evidence** (biology dimensions, counted after the modifier rule, with status `match`) and at least one of them observed. Otherwise moderate: one full match is a lead, not a strong link.
2. A `variant_type_conflict`: at most moderate.
3. A `contradicted_evidence` flag on a biology dimension: at most exploratory. A disputed symptom, grant or paper link says nothing about shared molecular biology, so it never caps the biology tier.
4. AI judgments: section 11.

**Clinical tiers.** `CLINICAL_THRESHOLDS` on the clinical score: "Looks very similar" >= 0.65, "Looks similar" >= 0.4, "Looks somewhat similar" >= 0.2, else "Looks different". No caps apply; the clinical reason carries the caveats.

**Reasons.** `tier_reason` names the biology lines in plain words, for example "Strong: both involve a lysosomal membrane protein, and both carry mostly loss-of-function variants." or "Capped at moderate: only one line of evidence is a full match. Both are missing a soluble lysosomal enzyme, and their variant types partly agree." `clinical_reason` names the clinical evidence, for example "Looks very similar: 6 shared symptoms (3 rare), about as much overlap as two records of the same disease. Few symptoms are on record for CLN6 (8), so this comparison is uncertain. Onset: both childhood. Both autosomal recessive. Sources disagree on the onset of CLN2; a clinician should confirm."

**Pair support** (solid or dashed line on the map): `observed` when some agreeing biology line (a full or partial match) rests on observed edges on both sides, else `inferred` when biology is above 0. The strong rule above looks only at full-match lines.

The pair's flags are the union of its dimension flags and any judgment caveats, in `FLAGS` order.

## 8. The seed today

Five CLN diseases with different genes (PPT1, TPP1, CLN3, CLN6, MFSD8), the seed's family mechanism, and the curated facts. Baseline (`npm run grade`, no AI judgments), from `public/relevance.sample.json`:

| Pair | Biology | Tier | Most specific shared mechanism | Variant (lof share) | Symptoms: SimGIC, percentile, score | Onset, inheritance | Clinical | Looks |
|---|---|---|---|---|---|---|---|---|
| CLN3-CLN7 | 0.8500 | strong | Lysosomal membrane protein (1) | 1 (2/3, 2/3) | 0.2148, 99.61%, 0.3331 | juvenile = juvenile, AR | 0.5499 | similar |
| CLN1-CLN2 | 0.8333 | moderate (capped) | Soluble lysosomal enzyme missing (1) | 0.6667 (2/3, 3/3) | 0.3090, 99.91%, 0.9460 | infantile / childhood, AR | 0.7792 | very similar |
| CLN3-CLN6 | 0.5383 | moderate | Membrane protein missing (0.5575) | 0.6667 (2/3, 2/2) | 0.2772, 99.90%, 0.7391 | juvenile / childhood, AR | 0.6613 | very similar |
| CLN6-CLN7 | 0.5383 | moderate | Membrane protein missing (0.5575) | 0.6667 (2/2, 2/3) | 0.1688, 99.10%, 0.0338 | childhood / juvenile, AR | 0.2593 | somewhat |
| CLN1-CLN3 | 0.3400 | exploratory | family-wide only (0.15) | 1 (2/3, 2/3) | 0.3640, 99.92%, 1 | infantile / juvenile, AR | 0.7700 | very similar |
| CLN1-CLN7 | 0.3400 | exploratory | family-wide only (0.15) | 1 (2/3, 2/3) | 0.2434, 99.74%, 0.5192 | infantile / juvenile, AR | 0.4382 | similar |
| CLN2-CLN6 | 0.3400 | exploratory | family-wide only (0.15) | 1 (3/3, 2/2) | 0.4091, 99.92%, 1 | childhood = childhood, AR | 0.8500 | very similar |
| CLN1-CLN6 | 0.2667 | exploratory | family-wide only (0.15) | 0.6667 (2/3, 2/2) | 0.1690, 99.10%, 0.0351 | infantile / childhood, AR | 0.2600 | somewhat |
| CLN2-CLN3 | 0.2667 | exploratory | family-wide only (0.15) | 0.6667 (3/3, 2/3) | 0.3811, 99.92%, 1 | childhood / juvenile, AR | 0.8100 | very similar |
| CLN2-CLN7 | 0.2667 | exploratory | family-wide only (0.15) | 0.6667 (3/3, 2/3) | 0.2563, 99.80%, 0.6031 | childhood / juvenile, AR | 0.5838 | similar |

- Biology separates what the literature separates: the two pairs of the same protein kind on top, the membrane proteins in different places (CLN6 in the ER) in the middle, and every enzyme-membrane pair at the bottom with `family_level_only`. Clinical resemblance tells a different story, as it should: the pair that looks most alike (CLN2-CLN6, 0.85) is biologically distant.
- **CLN1-CLN2 is moderate, not strong.** Their mechanism is a full match, but PPT1's three seed variants include one missense change (c.224C>A, p.Thr75Asn) while TPP1's three are all loss-of-function (the 11p15.4 copy-number loss belongs to TPP1's locus), so the variant line is partial (0.6667) and only one line is a full match. Strong needs two. The answer key allows moderate for a high pair.
- **Clusters**: "Membrane protein missing" {CLN3, CLN6, CLN7} (color slot 1) and "Soluble lysosomal enzyme missing" {CLN1, CLN2} (slot 2), from the strong and moderate links. Inside the membrane cluster every pair shares both "Membrane protein missing" and the family process; the more specific one names the cluster.
- **Bridges**: the NIH grant U54HD122210 (Batten Disease Clinical Research Consortium, PI Erika Augustine) links CLN2, CLN3 and CLN6, so CLN2-CLN3 and CLN2-CLN6 are cross-cluster collaboration bridges and CLN3-CLN6 a bridge inside the membrane cluster.
- The 10 patient groups and the registry from the Orphanet directory hang off the family mechanism, reach all five diseases, and are umbrella resources: shown and flagged, never a bridge.
- Centrality: CLN3 and CLN7 1, CLN6 0.7755, CLN1 and CLN2 0.6002.

## 9. The answer key, and how a mentor updates it

`data/curated/answer_key.json` rates each of the 10 CLN pairs `high` ("Same kind of broken protein in the same place; a therapy or study design could plausibly transfer."), `medium` ("Same broad kind of protein but a different place or job; some shared research questions.") or `low` ("Same disease family only (lipofuscin storage), different kind of protein; therapies do not transfer directly."), with the reason and the source. Today it is rated from the literature (Zhang et al. 2025; Nelvagal et al. 2022): CLN1-CLN2 and CLN3-CLN7 high, CLN3-CLN6 and CLN6-CLN7 medium, the six enzyme-membrane pairs low.

`lib/grading/answer-key.test.ts` (part of `npm test`, so part of CI) grades `public/graph.sample.json` with the reference and checks:

- every high pair's biology is above every medium pair's, which is above every low pair's;
- a high pair is strong or moderate, a medium pair moderate, a low pair exploratory or none.

It prints the pair table and Kendall's tau-b between the rating and the biology score. Today every one of the 28 comparisons between pairs with different ratings is in the right order and none is reversed; tau-b = 0.8584 over the 10 pairs, below 1 only because pairs with the same rating but different scores (the low pairs at 0.34 and 0.2667, the high pairs at 0.85 and 0.8333) count in its denominator.

To update it, a mentor or clinician edits `expected` for any pair (and `why`, `source`), sets `rated_by` to their name and `rated_on` to the date, and runs `npm test`. If the engine disagrees, the test fails with the pair, its rating, its tier and its reason. Then either the engine is wrong (constants live in `config.ts`; change them in one place, run `npm run grade`, commit the regenerated files) or the disagreement is explained in the key's `why`. The test is never edited to pass.

## 10. Neighbors, look-alikes, clusters, centrality, bridges, 3D

**Neighbors (the map).** For each disease, every other disease with a biology tier other than `none`, sorted by tier, then biology, then collaboration, then id. The first `MAX_NEIGHBORS` = 10 are shown; the rest are counted in `hidden` ("+N weaker links").

**Look-alikes.** `clinical_neighbors`: the 10 diseases with the highest clinical score whose clinical tier is not "Looks different", ties broken by biology, then collaboration, then id. A pair in either list, or in a bridge, is in `pairs`.

**Clusters** (`lib/grading/analytics.ts`). A disease graph of strong and moderate pairs, weighted by biology. Communities come from a deterministic Louvain (Blondel et al. 2008: resolution 1, nodes visited in sorted id order, a node moves only for a strictly better community, ties to the smaller community id, gains below 1e-12 ignored, then aggregation and repeat). Diseases with no strong or moderate link have no cluster. Larger clusters are named first and no two share a name: a cluster is named after the mechanism shared by the most pairs inside it, ties going to the more specific mechanism (higher weight), then to the id; failing that, after its rarest shared symptom ("Shared symptoms: ..."); failing that, "Group n". The eight largest clusters get color slots 1 to 8; the rest are gray as "Other".

**Centrality.** Weighted degree over strong and moderate links, divided by the largest weighted degree (0 for an isolated disease). It drives dot size.

**Two kinds of bridge.** A disease is a *bridge* when it has a strong or moderate biology link into a different cluster. A *collaboration bridge* is a pair that shares at least one collaboration item that is not an umbrella resource; it is `cross_cluster` when the two diseases sit in different clusters. Its reason names at most two kinds of shared work, in the order grant, researcher, study, paper, patient group, asset.

**3D layout.** Classical multidimensional scaling of the distance `1 - biology` over all diseases (power iteration with deflation from a seeded start vector, shifted by a Gershgorin bound; coordinates scaled so the farthest disease sits on the unit sphere; each axis flipped so the first disease with a non-zero value on it is positive). Pairs that were never graded count as biology 0, distance 1. The radial map and the 3D view both follow from the biology score; nothing places a disease by hand.

## 11. Bundles and AI judgments

For every pair in the output, `npm run grade` writes a `PairBundle` (`buildBundles` in `lib/grading/grade.ts`): both labels, the eleven `DimensionResult`s, every edge behind a shared item plus the edges a dimension lists in its details (contradicted edges, and the two onset claims compared), and every node they refer to. The bundles are always built from the judgment-free baseline, and the file carries `meta.bundles_hash` (sha256 of the canonical JSON of the bundles array), so a judgments file is tied to exactly the evidence it judged.

The AI workflow (`docs/agents/grader-agent-prompt.md`) returns judgments: a verdict (`supports`, `weakens`, `contradicts`, `insufficient`), a confidence, an optional `cap_tier`, coded caveats from `FLAGS`, a rationale and the edge ids it relies on. They are validated against `lib/grading/judgments.schema.json` and applied after the engine's own caps:

| Judgment | On a biology dimension, or `overall` | On a clinical or collaboration dimension |
|---|---|---|
| `supports`, `insufficient` | no change | no change |
| `weakens` | biology tier down one, once per pair | no tier change |
| `contradicts` | at most exploratory | no tier change |
| `cap_tier` | at most that tier | ignored |
| caveats | added to the pair's flags | added to the pair's flags |

A judgment about a pair the engine did not grade, or citing any edge outside the pair's evidence, is ignored and counted in a warning and in `meta.notes`. Judgments never change a number, so the map distances and the 3D layout never move because a model said so; a pair can only move outward or drop off.

## 12. Scaling past the seed

Comparing every disease with every other is quadratic. `candidatePairs` (`lib/grading/dimensions.ts`) builds an inverted index from genes, identical variants, mechanisms, the rarest-first prefix of each disease's symptom closure, and collaboration items that are not umbrella resources. Only pairs that share an entry are graded. The prefix filter (a standard set-similarity join) keeps, for each disease, the terms whose removal would leave at most `floor` of its information mass, where `floor` is the SimGIC at or below which the symptom score is 0 (the 99th percentile of random pairs); any two diseases with a higher SimGIC share a prefix term. Because variant type only counts beside a gene or mechanism, and onset and inheritance only beside scoring symptoms, a pair left out has biology 0, clinical 0 and no bridge, and a randomized test checks exactly that. For the seed every pair is a candidate.

Still quadratic at thousands of diseases: a very common index entry (a pathway shared by most diseases) generates most pairs by itself, and the 3D layout needs the full distance matrix (landmark MDS would replace it).

## 13. Limitations

- **Five hand-curated genes.** Mechanisms and gene-mechanism links (7 mechanisms, 12 links) and the onset and inheritance of the five diseases are hand-curated in `data/curated/ncl_facts.json` (checked 2026-10-03), each with a verbatim quote, and the quotes match the cited articles. They should be replaced by UniProt and Gene Ontology data when the pipeline covers more genes. Mechanism specificity is relative to the atlas: "Membrane protein missing" weighs 0.5575 because it reaches 3 of 5 diseases here, and would weigh differently in a larger atlas.
- **Onset sources disagree for CLN2 and CLN7.** For CLN2 the review's text says late-infantile, onset 2 to 4 years, while its table lists 4 to 8 years; for CLN7 many clinical sources describe classic disease as variant late-infantile, while the review and HPO's annotation of OMIM:610951 say juvenile. Both edges carry the disagreement, and every pair involving CLN2 or CLN7 is flagged `sources_disagree`. A third disagreement is not yet marked: HPO's own annotation of OMIM:256730 lists juvenile onset (HP:0003621) for CLN1, a record that covers CLN1's variable-onset forms, while the facts file uses the review's infantile onset (6 to 24 months).
- **CLN6 has only 8 symptoms on record**, under `MIN_ANNOTATIONS` = 10. Its symptom comparisons are flagged `few_annotations` and named in the summaries; CLN6-CLN7 share no identical symptom and score just above the floor (0.0338), although both are often described clinically as variant late-infantile NCL.
- **Variant samples are tiny.** Three ClinVar variants per gene in the seed, so one variant moves the loss-of-function share by a third. This is why CLN1-CLN2 is capped at moderate.
- **The constants are priors.** Caps, thresholds and the mechanism floor encode the team's judgment; the answer key is the only calibration of the biology score today, and it covers 10 pairs of one family. Symptom anchors are measured on all of HPO, not on the slice.
- **No "unknown" clinical tier.** When a disease has no symptoms on record, its clinical tier is "Looks different" and the clinical reason says the symptoms are missing.
- **Inheritance alone can fill the onset and inheritance facet.** When only inheritance is on record for both diseases the facet is renormalized to it; this counts only beside scoring symptoms.
- **Search hits.** In the seed, studies, papers and grants are attached by title or keyword search, and patient groups by a directory listing; they are marked inferred, and their notes say so.
- **Seed symptom labels were wrong.** The seed pairs HPO ids with the wrong names (for example HP:0001250 is labeled "Loss of speech"; in HPO it is Seizure); the adapter takes every label from the HPO reference. Ids, never names, are used for scoring.

When the real graph (`public/graph.json`) lands: rebuild the reference (`npm run data:hpo`) so every term is covered; check the symptom scale against the slice (every disease in a CVI slice shares HP:0100704 by construction, which raises every SimGIC); check that pairs inside known groups rank above pairs across groups; look at tier and cluster sizes; extend the answer key with mentor-rated pairs from the new graph; and run Paul's evidence QA on the edges behind the top pairs.

## 14. How to run it

```bash
npm run data:hpo     # HPO files -> data/raw/hpo/ (first run only); writes data/reference/hpo-reference.json
npm run data:sample  # seed + curated facts -> public/graph.sample.json (labels from the HPO reference)
npm run grade        # -> public/relevance.sample.json and data/grading/bundles.sample.json, and a report
npm test             # node:test suites under lib/, including the answer key
npm run check:schema # graph files against schema.json
npm run grade:check  # recompute and compare byte for byte; exit 1 on any difference
```

`npm run grade` picks `public/graph.json` when it exists, else the sample. Other flags: `--graph`, `--reference <file|none>`, `--judgments <file|none>`, `--out`, `--bundles`, `--check`; `node scripts/grade.ts --help` lists them. `npm run data:sample` takes `--facts <file>` or `--no-facts`, and stops with a list of problems if the curated facts name a gene, disease, mechanism or source that does not resolve. After changing any input, run `npm run grade`, read the report, run `npm test` and `npm run grade:check`, and commit the regenerated files with the change.
