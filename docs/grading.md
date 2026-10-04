# How the atlas grades related diseases (engine 0.2.0)

This is the reference for the grading engine in `lib/grading/`. It explains how the atlas decides which diseases are related to the one a family searched for, how strongly, why, and where the numbers come from. It is written for contributors, for reviewers, and for clinicians who want to check or correct a grade.

Four rules shape everything:

- **Three scores, never mixed.** *Biology* (same gene, same kind of variant, same molecular pathway) answers "who shares our biology?" and is the only number that sets distance on the map. *Clinical resemblance* (symptoms, onset, inheritance) answers "who looks like us?" and is shown beside it. *Collaboration* (shared patient groups, papers, studies, grants, researchers, registries) answers "who already works alongside us?" and never moves a disease.
- **The engine computes, the AI reviews.** Every number, tier, cluster and coordinate comes from deterministic code. AI judgments can only lower a biology tier or add a caveat (section 13).
- **No number without a source.** Every shared item carries the ids of the edges that support it, and every edge carries a source, a URL, a date and a kind (observed, inferred or contradicted).
- **A test holds the engine to an answer key.** `data/curated/answer_key.json` rates 14 pairs of the atlas from the literature; `lib/grading/answer-key.test.ts` fails if the grades disagree in a way nobody has explained (section 11).

The tunable constants quoted here live in `lib/grading/config.ts`. The caps, the tier and clinical thresholds, the symptom scale and `MAX_NEIGHBORS` have their own fields in the `meta` block of the relevance file; every other constant is listed in the "Settings" sentence of `meta.notes`, so a grade can always be traced to the settings that produced it. A few fixed rules sit next to the code that applies them in `lib/grading/dimensions.ts` and `lib/grading/synthesize.ts` (variants compared only when they can stand for the disease, variant status 0.75 / 0.4 or the same kind on both sides, at least 2 classified variants a side, "mostly loss-of-function" from 2 of 3, onset and inheritance status 0.75 / 0.5, neighbouring onset 0.5, the 0.9 symptom score above which the wording says "as much as two records of the same disease", the thin-record cap on the clinical tier, the 20,000-gene pathway scale); the same note lists them too. The data contract is `lib/grading/types.ts`.

## 1. Inputs and outputs

| | File | Made by |
|---|---|---|
| Team graph | `data/seed/rare_graph.json` (team format): 93 diseases with their genes, ClinVar variants, symptoms, papers, NIH projects and patient groups | the Python pipeline (`pipeline/build_graph.py`) |
| Reactome pathways | `data/reference/reactome-pathways.json`: the Reactome pathways each gene of the graph is in, with their sizes | `npm run data:reactome` (responses cached in `data/raw/reactome/`, gitignored) |
| Symptom reference | `data/reference/hpo-reference.json`: HPO labels, information content, specificity, ancestors, the random-pair null model and the same-disease anchor | `npm run data:hpo` (HPO files cached in `data/raw/hpo/`) |
| **Graph** | `public/graph.json` (schema format): the atlas the app shows and the engine grades | `npm run data:graph` |
| Answer key | `data/curated/answer_key.json`: expected biology rating (high, medium, low) of 14 pairs, each with a reason and a source | literature; a clinician may overwrite it |
| AI judgments (optional) | `public/judgments.json` | an AI review workflow (any model), validated against `lib/grading/judgments.schema.json` |
| **Relevance** | `public/relevance.json` | `npm run grade` |
| **Bundles** | `data/grading/bundles.json`: one evidence packet per pair in the relevance file, for the AI workflow | `npm run grade` |

The relevance file holds, for every disease, its biology neighbors (at most `MAX_NEIGHBORS` = 10, the map), its clinical look-alikes (`clinical_neighbors`, at most 10), its cluster, centrality, bridge flag and 3D coordinates; for every pair in a neighbor or look-alike list, the three scores, the biology tier and the clinical tier with a plain reason each, and all eleven dimension results; the clusters; the collaboration bridges (each with its reason and edges); and `node_info`: for each symptom, its information content, specificity and HPO aspect, and for each mechanism, its weight in this atlas and how many diseases reach it.

The same inputs always give byte-identical outputs: keys and arrays are sorted, floats are rounded to `ROUND` = 4 decimals, and `generated_at` equals the graph's own `generated_at` instead of the clock. CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests: `npm run check:schema` (schema.json and `public/graph.json`), `npm run data:graph -- --check` (rebuilds the graph from its committed inputs and fails if a byte differs or an input is missing), `npm test` (which includes the answer key), `npm run grade:check` (recomputes the grades and fails if a byte differs from the committed files), then the Next.js build and the typecheck.

The engine is graph-agnostic. Dimensions are derived from node types and edge endpoints, never from relation names.

## 2. The atlas: 93 diseases

`scripts/seed-to-graph.ts` maps the team graph to `public/graph.json` with fixed rules and counts everything it leaves out in `meta.notes`.

| Seed | Graph | Kind | Confidence | Source | Evidence |
|---|---|---|---|---|---|
| `causes` (gene to disease) | `causes` | observed | 1 | Monarch | |
| `has_phenotype` | `has_phenotype` | observed | 1 | HPO (via Monarch) | the pipeline's note |
| `variant_of` (variant to gene) | `variant_of` | observed | 1 | ClinVar | |
| `about` (paper to disease) | `about` | inferred | 0.6 | PubMed | "PubMed search hit: one of the first 3 results for the gene symbol and the disease name ..." |
| `funds` (NIH project to disease) | `funds` | inferred | 0.6 | NIH RePORTER | "NIH RePORTER search hit: one of the first 3 projects whose title or terms match ..." |
| `works_on` (group to disease) | `works_on` | inferred | 0.5 | Orphanet | "Orphanet patient-organisation directory result for this disease, kept by pipeline/build_graph.py because the group's name contains "Gaucher" from the disease name; a name match, not a curated link." |
| Reactome membership (gene to pathway) | `in_pathway` | observed | 1 | Reactome | "Reactome lists TYR in Melanin biosynthesis." |
| `works_on` whose name match rests only on a generic word | left out | | | | |
| `same_gene`, `subclass_of`, `disease_group` | skipped | | | | |

`same_gene` edges are skipped because two diseases that share a Gene node already say it (55 edges, 4 of them pointing at diseases missing from the seed). `subclass_of` edges and the one `disease_group` node (MONDO:0019290) are a MONDO category, and the atlas finds groups from shared biology, not from categories (20 edges). Phenotype labels come from the HPO reference by id. The seed's own edge weights (information content on symptom edges, gene specificity on `same_gene`) and its `weights.pairs` block are not used: the engine computes information content and symptom similarity from the HPO reference itself, and an edge's confidence stays the certainty of the claim, not the rarity of the symptom. Edge dates are the pipeline's retrieval date (2026-10-03); Reactome edges carry the Reactome release date. Edge ids are built from the relation and both ends (`e-causes-HGNC_7105-MONDO_0007077`), so they stay stable across rebuilds.

**Patient groups attached by a generic word are left out.** The pipeline keeps an Orphanet directory result only when the group's name contains the gene symbol or a word of the disease name longer than 3 letters, as a case-insensitive substring. A word that names no disease passes that test for any general support group: "disease" attached "RaDiOrg - Rare Diseases Belgium" and "Rare Disease Foundation" to the 9 diseases that have the word in their name, "syndrome" attached "SWAN - Syndromes Without a Name" to 23 diseases, "with" matched "Without", and "form" matched six scraped links titled "More information" (all for "autosomal dominant optic atrophy, classic form"). The adapter re-runs the pipeline's test on the names it stored and leaves out a result when every word that matched is generic (`GENERIC_NAME_WORDS` in `scripts/seed-to-graph.ts`: kinds of disorder such as disease, syndrome, deficiency, disability; qualifiers of type, form, severity, onset and inheritance; connecting words; and a place name used as a qualifier, "Finnish"). Words that name a disease or a family of diseases stay: an albinism association serves every albinism, a skeletal dysplasia association every skeletal dysplasia. 94 of the 189 results were left out ("disease" 38, "syndrome" 32, "with" 14, "form" 6, "disability" 2, "finnish" 1, "hereditary" 1), and 27 groups left with no disease are not in the graph; `meta.notes` says so. Each kept link's evidence names the word that matched. This belongs in the pipeline (the same rule in `groups()` of `pipeline/build_graph.py`); the adapter applies it until then.

The result: 1,122 nodes (93 Disease, 52 Gene, 152 Variant, 221 Mechanism, 303 Phenotype, 47 PatientOrg, 227 Paper, 27 Grant; no Trial, Investigator or Asset) and 1,891 edges (1,514 observed: 93 `causes`, 996 `has_phenotype`, 156 `variant_of`, 269 `in_pathway`; 377 inferred: 249 `about`, 33 `funds`, 95 `works_on`).

What the data can and cannot say, measured on this graph:

- **Every disease has one gene**; 18 genes have several diseases (COL2A1 12, TGFBI 6, GBA1 5, GLB1 4; BEST1, ITPR1, PAX6, TWIST2 3 each; 10 genes 2 each).
- **Variants are recorded per gene, not per disease**: the first 3 pathogenic ClinVar records of each gene, whatever condition they were reported for. Read from their notation, 30 of the 52 genes are mostly loss-of-function, 13 mixed, 7 mostly missense or in-frame, and 2 have too few readable variants. 34 of the 52 genes have only one disease here; only their records can stand for a disease (section 4).
- **Symptoms are partial.** The pipeline keeps a disease's Monarch phenotypes only where they are shared inside a Monarch cluster (the same gene, or a shared parent): 990 of the 996 symptom links are shared that way. 31 of the 93 diseases have no symptom on record (Tay-Sachs and Sandhoff disease among them), 7 pairs of diseases list identical symptoms, and no onset or inheritance term survives the filter. Clinical resemblance is therefore overstated inside a cluster and understated everywhere else (section 15).
- **Papers, grants and patient groups are search hits.** Each comes from the first few results of a search on the gene symbol and the disease name; patient groups are Orphanet directory results kept by a name match. Matches on a generic word are left out (above), so the groups that remain are named for the disease, its gene or its family of diseases; 33 of the 93 diseases have one.

## 3. Eleven dimensions in three families

| Family | Dimension | UI label | What is compared | Cap |
|---|---|---|---|---|
| biology | `gene` | Same gene | Gene nodes linked to each disease | 0.7 |
| biology | `variant` | Variant type | Share of loss-of-function variants, read from HGVS notation (a modifier) | 0.25 |
| biology | `mechanism` | Same mechanism | Mechanism nodes (Reactome pathways) linked to the disease or to its genes; the most specific shared one | 0.8 |
| clinical | `phenotype` | Shared symptoms | HPO symptom profiles, information-weighted (SimGIC) and scaled between two anchors | 0.75 |
| clinical | `disease` | Onset and inheritance | HPO onset step and mode of inheritance (a modifier) | 0.4 |
| collaboration | `patient_org` | Patient groups | Groups linked to the disease, or to its mechanism or gene | 0.5 |
| collaboration | `paper` | Papers | Papers linked to the disease | 0.3 |
| collaboration | `trial` | Clinical studies | Studies linked to the disease | 0.4 |
| collaboration | `grant` | Research grants | Grants linked to the disease | 0.3 |
| collaboration | `investigator` | Researchers | Researchers linked to the disease, or to its grants, papers or studies | 0.4 |
| collaboration | `asset` | Registries and assets | Registries and other assets linked to the disease, or to its mechanism or gene | 0.5 |

Why biology and clinical resemblance are separate: two diseases can look alike and be broken in different ways, and two diseases of one gene can be broken in opposite ways. Hajdu-Cheney syndrome and Alagille syndrome 2 both come from NOTCH2, one from variants that increase its signalling and one from variants that decrease it. A family looking for shared research or therapies needs the biology answer; a family comparing what their child goes through needs the clinical one. The product shows both.

"Linked" means any edge in either direction whose kind is not `contradicted`. Contradicted edges never add to a score; when one touches the items of a pair, the pair gets the flag `contradicted_evidence`, and on a biology dimension its tier is capped (section 8).

Each dimension returns a `DimensionResult`: `score` from 0 to 1, the only input to synthesis; `status` (`match`, `partial`, `none` when both sides have data and nothing is shared, `unknown` when a side has no data or the data cannot tell, as for variants and mechanisms that only come with a shared gene); `coverage` (items each disease has); `shared` items, each with the ids of every edge that ties both diseases to it; `support` (`observed` if some shared item rests only on observed edges on both sides, `inferred` if items are shared but none that way, `null` if nothing is shared); a deterministic plain-language `summary`; coded `flags` from `FLAGS` in `types.ts`; and `details`, the numbers behind the score (for example `most_specific`, `n`, `N` and `atlas` for a mechanism, `via_genes` when both diseases reach it through their genes, `through_shared_gene` when every shared mechanism only comes with a shared gene, `independent_mechanisms` when only some do, `gene_level_variants` for the variants set aside, `raw` for symptoms, `umbrella_items` for collaboration).

## 4. Biology

**Gene.** Score 1 if the diseases share a gene, else 0. Status `unknown` when a side has no gene. A shared gene always gets the flag `same_gene_allelic`: the same gene can act through different mechanisms, which is why a shared gene alone is moderate, never strong.

**One shared gene is one line of evidence.** Variants hang off the gene and so do its pathways, so two diseases of one gene see one variant list and one set of mechanisms. Counted as such, one fact would pass for three agreeing lines, and every allelic pair would be strong. So:

- **Variants stand for a disease only when they are tied to it.** A disease's variants are those linked to the disease itself, and those of a gene that has no other disease here. A gene with several diseases here (the pair's shared gene, or the gene of a family such as COL2A1 with 12) records its variants for the gene: they cannot say which of its diseases they come from, and comparing them would compare the gene, not the disease. Such variants are set aside and counted in `details.gene_level_variants`; with too few left the line is `unknown` with `variant_effect_unknown` ("The variants on record are listed for the shared gene MITF, not for either disease, so variant type cannot tell the two apart."; between different genes: "Variant type cannot be compared: the variants on record for Stickler syndrome type 1 are listed for its gene COL2A1, which has 12 diseases here, not for the disease itself."). 34 of the 52 genes have one disease here.
- **A mechanism that comes only with the shared gene is not a line of its own.** When every mechanism a pair shares is reached only through a gene they share, the mechanism line is `unknown` and scores 0 (`details.through_shared_gene`); the mechanisms stay listed: "The 10 mechanisms they share (...) come with their shared gene MITF, so they say nothing the gene does not; whether both diseases disrupt them the same way is unknown." The UI shows it under "What we don't know". When the pair shares other mechanisms too, the score comes from those.

In this atlas every allelic pair rests on the gene line alone: all 118 allelic pairs in the relevance file are moderate at 0.70, with the variant and mechanism lines unknown, and the reason says what the gene cannot tell: "Moderate: both are caused by the same gene (MITF); the variants on record belong to the gene, not to either disease, so whether both break it the same way is unknown." That is the honest answer for the "same gene, different mechanisms" case: Tietz syndrome and COMMAD (MITF) and Hajdu-Cheney syndrome and Alagille syndrome 2 (NOTCH2) are moderate on the gene line, flagged `same_gene_allelic` and `variant_effect_unknown`, with their clinical resemblance beside them. Telling the same mechanism from a different one needs variants tied to each disease (ClinVar records each variant's conditions), which the pipeline does not fetch yet.

**Mechanism: specificity within the atlas.** A pathway shared by every disease cannot tell any two apart. For a mechanism reached by `n` of the `N` diseases that have any mechanism on record (directly or through a gene):

```
specificity = clamp((1 - ln n / ln N) / (1 - ln 2 / ln N), 0, 1)     (1 when N < MIN_ATLAS_FOR_SPECIFICITY = 3)
weight      = max(MECHANISM_FLOOR, specificity) x size weight         MECHANISM_FLOOR = 0.15
size weight = clamp(1 - ln(gene_count) / ln(20000), 0.1, 1)          (1 when the node records no gene_count)
```

This is information content (Resnik) normalized so that a mechanism shared by exactly two diseases weighs 1 and one shared by all weighs 0, floored at 0.15. `N` counts only diseases with a mechanism on record, as HPO's information content counts only annotated diseases: a disease whose gene Reactome does not list says nothing about how common a pathway is. Here `N` = 81 of the 93 diseases. The size weight discounts big pathways: about 0.84 for 5 proteins, 0.63 for 41 (the median here), 0.44 for 246 (the largest kept).

| Reactome pathway | Proteins | Diseases reaching it (n of 81) | Weight |
|---|---|---|---|
| Galactose catabolism | 6 | 3 | 0.7294 |
| Hyaluronan degradation | 16 | 2 | 0.7200 |
| Insulin processing | 25 | 2 | 0.6750 |
| Melanin biosynthesis | 5 | 5 | 0.6302 |
| Antigen activates B Cell Receptor (BCR) leading to generation of second messengers | 95 | 5 | 0.4064 |
| Regulation of MITF-M-dependent genes involved in pigmentation | 42 | 8 | 0.3894 |
| Glycosphingolipid catabolism | 39 | 12 | 0.3251 |
| Developmental Lineage of Pancreatic Ductal Cells | 48 | 13 | 0.3011 |

**Mechanism: the most specific shared one (MICA).** The pair's score is the weight of the most specific mechanism both diseases reach (Resnik's "most informative common ancestor"), not an overlap ratio: a gene in many pathways would otherwise dilute the one it shares with a neighbour. Status `match` at `MECHANISM_STATUS.match` = 0.6 or more, `partial` when anything is shared, `none` when both have mechanisms but share none, `unknown` when a side has none or when every shared mechanism only comes with a shared gene. `family_level_only` marks pairs whose only shared mechanisms sit at the floor. The dimension's support follows the mechanism that carries the score.

The most specific shared pathway is not necessarily the diseases' mechanism (Tay-Sachs and Sandhoff disease share five; the most specific here is Hyaluronan degradation, while the one the literature names is Glycosphingolipid catabolism, the most widely shared of the five). So the words say what the data says: a pathway their genes are in, and which of them is the most specific here. "Their genes share 5 mechanisms, of which the most specific here is hyaluronan degradation (2 of the 81 diseases with a mechanism on record). Also shared: Hyaluronan metabolism, Keratan sulfate degradation, CS/DS degradation and Glycosphingolipid catabolism." With one: "Their genes share one mechanism, galactose catabolism (3 of the 81 diseases with a mechanism on record)." A mechanism linked to the diseases themselves, or a label that states what the gene product is ("Membrane protein missing"), reads as their own ("Both are missing a membrane protein (3 of 5 diseases here)"). The reach says "(2 of the 81 diseases with a mechanism on record)" when some diseases have none, "(2 of 5 diseases here)" when all do.

**Variant type (a modifier).** The variants that can stand for the disease: those linked to it, and those of its genes that have no other disease here (above). Each label is classified from its HGVS notation (`lib/grading/variants.ts`); the protein change is read first when the name states one, then the cDNA change:

| Class | Notation it reads |
|---|---|
| loss of function | nonsense (`p.Gln393Ter`), frameshift (`fs`, or a cDNA deletion, duplication or insertion whose length is not a multiple of 3), start loss (`p.Met1...`, or a change in `c.1` to `c.3`), canonical splice site (`+1`, `+2`, `-1`, `-2`, including deletions that run across one), whole-exon deletions, copy-number loss (`x1`, `x0`) |
| missense | one amino acid replaced by another (`p.Arg217Thr`) |
| other | synonymous, in-frame deletion, duplication or insertion, stop lost |
| unknown | anything it cannot read, such as a change deeper in an intron |

For each disease, over the variants that can stand for it (above), `f` = loss-of-function variants / classified variants. A side is "mostly loss-of-function" at `f` >= 2/3 and "mostly missense or in-frame" at `f` <= 0.2 (compared on exact fractions, so 2 of 3 counts), else "mixed". With at least 2 classified variants on each side, `score = 1 - |fA - fB|`; `match` at 0.75 or more or when both sides are of the same kind, `partial` at 0.4 or more, else `none`. With fewer, the status is `unknown` with `variant_effect_unknown`. One side of each kind sets `variant_type_conflict`. `derived_from_variant_notation` is set whenever a type was read, and the support is `inferred` whenever the score is above 0: notation suggests an effect, it does not prove one. The summary says whose records were compared: "Both mostly loss-of-function (ClinVar records: HEXB 3 of 3 loss-of-function, DCN 3 of 3)." names the genes, because the records belong to the genes; each of those genes has only this disease here.

**The biology modifier rule.** Variant type counts toward biology only when the pair shares a gene or a mechanism (status `match` or `partial`), and only when the variant line itself is `match` or `partial`. Otherwise every two diseases with mostly loss-of-function variants would look related, and variants that disagree (status `none`) would still add to the score. A disagreement never strengthens a link; a `variant_type_conflict` caps it instead (section 8).

## 5. The Reactome layer

The map's biology needs mechanisms, and the team graph has none. `scripts/fetch-reactome.ts` asks the Reactome Analysis Service once, with the 52 gene symbols of the team graph (one per line):

```
POST https://reactome.org/AnalysisService/identifiers/?interactors=false&species=9606&pageSize=1000&page=1
     &sortBy=ENTITIES_PVALUE&order=ASC&resource=TOTAL&pValue=1&includeDisease=false
```

The `species=9606` filter is documented by the service; without it the result lists the pathways of every species with an orthologous gene (11 species for this list). On the analysis token it then reads the pathway sizes in proteins (`GET /token/{token}?resource=UNIPROT`, same filters) and, for the kept pathways, which of our symbols Reactome found in each (`POST /token/{token}/found/all?resource=TOTAL`, the batch form of `GET /token/{token}/found/entities/{pathway}`; the analysis runs without interactors, so it returns curated entities only, which the script checks; on 13 sampled pathways the two endpoints returned the same symbols). It keeps lowest-level pathways (`llp`) of Homo sapiens, not disease pathways, with at most 300 entities, and writes `data/reference/reactome-pathways.json`: `meta` (release, release date, fetch date, the query), `pathways` (`stId`, name, size in proteins, entities) and `genes` (each symbol's pathways, an empty list when it has none). The responses are cached, so a rebuild is offline and byte-identical; `--refresh` asks again.

Release 97 (released 2026-06-30, as reactome.org states), fetched 2026-10-03: 332 human pathways hit, 227 lowest-level, 221 kept. 43 of the 52 genes are in at least one kept pathway (269 gene-pathway links; 35 pathways link two or more of our genes). Reactome does not list AP3D1, FREM2, LMX1B, LYST, OPA3, SIX6, SLC38A8, SLC4A11 or TACSTD2, so their 12 diseases have no mechanism on record. The size is the number of proteins (UniProt entries, isoforms counted apart): 3 to 246, median 41. The entity count includes small molecules ("Phase I - Functionalization of compounds" has 300 entities and 105 proteins), so it is kept beside the size but not used as `gene_count`.

`scripts/seed-to-graph.ts` adds one Mechanism node per kept pathway (`REACT:` + stId, the Reactome name, source "Reactome", the pathway page as URL, `attributes { gene_count, reactome_release }`) and one `in_pathway` edge per membership, and stops if a gene of the graph is missing from the pathway file (run `npm run data:reactome` again).

**What a shared pathway is worth here.** Pathways that name a specific process carry many of the links the literature expects: Galactose catabolism joins galactokinase deficiency and the two galactosemias, Melanin biosynthesis the oculocutaneous albinisms, Golgi Associated Vesicle Biogenesis Hermansky-Pudlak syndromes 2 and 7, Glycosphingolipid catabolism the lysosomal sphingolipid diseases (39 exploratory pairs among the Gaucher, GM1, GM2 and Krabbe diseases), and Amyloid fiber formation gelsolin amyloidosis (whose first sign is a lattice corneal dystrophy) and the TGFBI corneal dystrophies. But pathway membership is not a shared mechanism, in four ways a reader should know:

- **The most specific shared pathway can be a side one.** Griscelli syndromes 1 and 2 (MYO5A, RAB27A) are moderate (0.655) through Insulin processing, where Reactome lists both proteins in moving insulin granules to the plasma membrane; the literature places their link in melanosome transport (Ménasché 2003, the key's source). Tay-Sachs and Sandhoff disease are moderate through Hyaluronan degradation. The reasons therefore name the pathway as the most specific one the genes share here, never as the disease mechanism (section 4).
- **Broad pathways join unrelated diseases, at the exploratory tier.** 47 pairs between different genes are carried by a broad pathway, at biology 0.22 to 0.39: Developmental Lineage of Pancreatic Ductal Cells (10 pairs: carbonic anhydrase II osteopetrosis and the COL2A1 dysplasias), Collagen chain trimerization (9: COL2A1 and COL17A1), Signaling by PDGF (8: COL2A1 and PIK3R1), Antigen activates B Cell Receptor (6: ITPR1 and PIK3R1), Stimuli-sensing channels (6: BEST1 and MCOLN1), ECM proteoglycans (3: COL2A1 and DCN), PI Metabolism (2: PIKFYVE and PIK3R1), Interleukin-4 and Interleukin-13 signaling (2: PIK3R1 and SOX2) and Degradation of the extracellular matrix (1: COL17A1 and DCN). Their reasons name the pathway and how many diseases reach it, so a reader can judge it. None is moderate: the variant line no longer counts for genes with several diseases here (COL2A1, PIK3R1, ITPR1, BEST1), which had lifted some of them to 0.44.
- **A pathway does not tell an enzyme from its substrate.** CS/DS degradation lists decorin as a substrate proteoglycan beside the HEXA, HEXB and GLB1 enzymes, so congenital stromal corneal dystrophy (DCN) is 0.5268 (moderate) beside Sandhoff disease, 0.448 (exploratory) beside Tay-Sachs disease, and in their cluster. Both pairs are rated low in the answer key; the first is a listed disagreement.
- **A pathway does not tell a regulator from its target.** Reactome lists SOX2 among the genes MITF-M binds in melanoma cells (Regulation of MITF-M-dependent genes involved in extracellular matrix, focal adhesion and epithelial-to-mesenchymal transition, 12 proteins), so Tietz syndrome and COMMAD (MITF) are moderate (0.5336) beside the SOX2 anophthalmia-esophageal-genital syndrome. That link joins them to the PAX6 and SOX2 eye malformations in one cluster, named for the PAX6-SOX2 pathway Formation of the anterior neural plate. Tietz - AEG syndrome is rated low in the key and is a listed disagreement.

## 6. Clinical resemblance

### Symptoms: information content and SimGIC

Two diseases that both cause seizures have something in common, but so do hundreds of unrelated diseases. Two diseases that both show "large clumps of pigment irregularly distributed along hair shaft" share something rare and telling. Each symptom is weighted by how informative it is.

**Information content.** For an HPO term `t`, with `N` diseases in HPO's annotation file (`phenotype.hpoa`) and `n_t` of them annotated with `t` or one of its descendants: `ic(t) = -ln(n_t / N) / ln(N)`, from 0 (every disease) to 1 (a single disease). A symptom counts as **rare** at `ic >= SPECIFIC_IC` = 0.5 and as **generic** below `GENERIC_IC` = 0.3.

**Specificity** is the same rarity as a share, for display: the mid-rank percentile of the term's `ic` among all 267,580 recorded disease-symptom annotations (distinct disease-term pairs whose term is a phenotypic abnormality; `NOT` rows skipped). It sizes symptoms on the map; grading uses `ic`.

The current reference (HPO release 2026-09-01, annotations of 2026-09-02) has N = 12,880 diseases. Some symptoms of the atlas:

| HPO term | ic | specificity | reads as |
|---|---|---|---|
| Intellectual disability (HP:0001249) | 0.1412 | 0.0096 | generic |
| Seizure (HP:0001250) | 0.1495 | 0.0233 | generic |
| Lattice corneal dystrophy (HP:0001149) | 0.8107 | 0.9524 | rare |
| Large clumps of pigment irregularly distributed along hair shaft (HP:0004527) | 0.8839 | 0.9772 | rare |
| Granular corneal dystrophy (HP:0007802) | 0.9268 | 0.9863 | rare |

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

0.1636 is the 99th percentile of random pairs (`SYMPTOM_FLOOR_PERCENTILE`), 0.3173 the median of the same-disease pairs (`SYMPTOM_TOP_FALLBACK` = 0.32 is used only if a reference lacks the anchor). Both are copied into `meta.symptom_scale`. Status: `match` at a score of 0.6 or more, `partial` at 0.25 or more (`PHENOTYPE_STATUS`). The plain words follow the anchors: at 0.9 or more "They overlap about as much as two records of the same disease."; above 0 "They overlap more than unrelated diseases, less than two records of one disease."; below that "a little more than most unrelated diseases, not enough to count" or "no more than many unrelated diseases do". The raw SimGIC and the percentile stay in the result for researchers.

Why not a fixed "70% match": three in four pairs of records of the very same disease stay under 0.3932, so a fixed 70% bar would call almost nothing similar, not even one disease described twice. Curators record different features, and SimGIC divides by the union.

Flags: `generic_symptoms_only` (something is shared, but every shared term has ic below 0.3), `few_annotations` (a disease has fewer than `MIN_ANNOTATIONS` = 10 symptoms; the summary names it, and a thin record can cap the clinical tier, section 8). Without a reference file the engine falls back to a plain Jaccard overlap of the annotated ids (`PHENOTYPE_STATUS_UNCALIBRATED`: match >= 0.3, partial >= 0.15) with the flag `uncalibrated`.

### Onset and inheritance (dimension `disease`)

Two facets from HPO terms linked to the disease. **Onset**: the step on the onset ladder `ONSET_LADDER` (congenital, neonatal, infantile, childhood, juvenile, adult; a finer term such as "Late onset" counts as its step); same step 1, neighbouring steps 0.5, further apart 0; the closest pair of steps across the two diseases counts. **Inheritance**: 1 if the diseases share a mode of inheritance (an identical aspect-`I` term), 0 if both have one and none is shared. `score` = `DISEASE_FACET_WEIGHTS` (onset 0.8, inheritance 0.2) over the facets on record for both, renormalized; `unknown` when neither facet is on record for both. Status `match` at 0.75 or more, `partial` at 0.5 or more. When an onset edge's evidence says "Sources disagree:", the pair gets `sources_disagree`.

**The clinical modifier rule.** Onset and inheritance count toward clinical resemblance only once the symptoms score above 0, that is, overlap more than 99% of random pairs. Being autosomal recessive with infantile onset is common, and on its own does not make two diseases look alike.

In this atlas the dimension is `unknown` for every pair: no onset or inheritance term survives the pipeline's filter (it also drops "Autosomal recessive inheritance" on purpose).

## 7. Collaboration

For patient groups, papers, studies, grants, researchers and assets, each shared item counts by how specific it is, as for mechanisms: `w` = `specificity(n, N)` with `n` the diseases linked to the item and `N` the diseases with any item of that kind on record (33 for patient groups, 87 for papers, 13 for grants here). A group listed for two diseases weighs 1; one listed for every disease that has a group weighs 0.

```
score = 1 - product over shared items of (1 - COLLAB_BASE x w)        COLLAB_BASE = 0.5
```

With every `w` = 1 this is `1 - 0.5^n`. Shared items are listed most specific first. Patient groups and assets also count when they are linked to the disease's mechanism or gene (flag `via_mechanism`; the item records the node it passes through in `via`). Researchers also count through the disease's grants, papers or studies. Status `match` when at least one shared item is not an umbrella resource, `partial` when every shared item is one, `none` when both sides have items but share none, `unknown` with `no_data` when a side has none.

**Umbrella resources.** A shared item linked to more than `max(UMBRELLA_MIN, UMBRELLA_SHARE x N)` of the atlas's `N` diseases (`UMBRELLA_MIN` = 4, `UMBRELLA_SHARE` = 0.1: 9.3 here) gets the flag `umbrella_resource` and is never drawn as a bridge. The summary says so: "It is listed for 23 of the 93 diseases here, so it says little about this pair." Until this release the cutoff was 80% of the diseases; on the 93 diseases that let one support group, "SWAN - Syndromes Without a Name" (listed for 23 diseases through the word "syndrome"), draw hundreds of "Same patient group" bridges. The cutoff only measures breadth inside the atlas, though, and a name match hides a general group's real breadth: RaDiOrg - Rare Diseases Belgium, a national alliance for all rare diseases, was listed for only the 9 diseases whose name contains "disease", below the cutoff. Leaving out the generic-word matches (section 2) removes those groups at the source; no item in the current atlas is an umbrella (the most widely listed group covers 5 diseases, weight 0.67). A shared study whose status is withdrawn, terminated or unknown gets `inactive_or_withdrawn`.

**Provenance of a shared item.** Its `edges` are every edge on the paths that tie both diseases to it; its `kind` is `observed` or `inferred` when all those edges agree, else `mixed`. Overlap that comes only from related (ancestor) symptom terms, or from neighbouring onset steps, is computed by the engine, not stated by a source, so it counts as `inferred`.

## 8. Putting it together

**Noisy-OR with caps, per family.**

```
biology       = 1 - (1 - 0.7 x gene)(1 - 0.8 x mechanism)(1 - 0.25 x variant*)     relevance = biology
clinical      = 1 - (1 - 0.75 x symptoms)(1 - 0.4 x onset and inheritance*)
collaboration = 1 - product over the six collaboration dimensions of (1 - cap x score)
```

`*` modifier: counts only under the modifier rules above. The cap is how far one line of evidence can move a pair on its own; agreement is what makes a link strong, and no combination reaches 1, because two different diseases are never the same disease.

| Evidence (pairs of this atlas) | biology |
|---|---|
| Shared gene only; its variants and pathways set aside (every allelic pair) | 0.70 |
| Insulin processing (0.675), both genes' records mostly loss-of-function (Griscelli 1 and 2) | 1 - 0.46 x 0.75 = 0.655 |
| Hyaluronan degradation (0.72), variant types partly agree, 0.5 (Tay-Sachs and Sandhoff) | 1 - 0.424 x 0.875 = 0.629 |
| Melanin biosynthesis (0.6302), variant types partly agree, 0.6667 (OCA3 and OCA4) | 1 - 0.4958 x 0.8333 = 0.5868 |
| Galactose catabolism (0.7294); GALT's records set aside, GALT has 2 diseases here (galactokinase deficiency and classic galactosemia) | 0.8 x 0.7294 = 0.5835 |
| CS/DS degradation (0.4614), both genes' records mostly loss-of-function (Sandhoff disease and congenital stromal corneal dystrophy) | 1 - 0.6309 x 0.75 = 0.5268 |
| Developmental Lineage of Pancreatic Ductal Cells (0.3011); COL2A1's records set aside, COL2A1 has 12 diseases here (Stickler 1 and osteopetrosis 3) | 0.8 x 0.3011 = 0.2409 |

**Biology tiers.** `TIER_THRESHOLDS`: strong >= 0.75, moderate >= 0.45, exploratory >= 0.2, else none (not shown). Caps only ever lower a tier:

1. Strong needs at least two **lines of evidence** (biology dimensions, counted after the modifier rule, with status `match`) and at least one of them observed. Otherwise moderate. A mechanism that only comes with a shared gene is not counted, so one shared gene is never two lines.
2. A `variant_type_conflict`: at most moderate.
3. A `contradicted_evidence` flag on a biology dimension: at most exploratory. A disputed symptom, grant or paper link says nothing about shared molecular biology, so it never caps the biology tier.
4. AI judgments: section 13.

No pair of this atlas is strong. Allelic pairs stop at 0.70 by design. Between two genes a strong link needs a shared pathway weighing at least 0.833 together with matching variant types, and the size weight keeps every Reactome pathway of more than 5 proteins below that.

**Clinical tiers.** `CLINICAL_THRESHOLDS` on the clinical score: "Looks very similar" >= 0.65, "Looks similar" >= 0.4, "Looks somewhat similar" >= 0.2, else "Looks different". One cap applies, and like the biology caps it lowers the tier and leaves the score: when a disease has fewer than `MIN_ANNOTATIONS` = 10 symptoms on record and the two share at most one identical symptom, or no rare one (ic >= 0.5), the tier is at most "Looks somewhat similar". Two records of one or two symptoms that share one can otherwise score as much overlap as one disease described twice: vitelliform macular dystrophy 2 and autosomal recessive bestrophinopathy share "Reduced visual acuity" (2 and 1 symptoms on record), Hajdu-Cheney syndrome and Alagille syndrome 2 share "Renal cyst" (one symptom each). The reason says so first: "Capped at looks somewhat similar: few symptoms are on record for vitelliform macular dystrophy 2 (2) and autosomal recessive bestrophinopathy (1), and they share only one identical symptom. 1 shared symptom, about as much overlap as two records of the same disease." 25 pairs are capped, 16 from "very similar" and 9 from "similar". Records of 10 or more symptoms on both sides are never capped, however common the shared symptoms: Kniest dysplasia and spondyloperipheral dysplasia share 12 symptoms, none of them rare, from 40 and 32 on record, and look similar.

**Reasons.** `tier_reason` names the biology lines in plain words: "Moderate: both are caused by the same gene (MITF); the variants on record belong to the gene, not to either disease, so whether both break it the same way is unknown.", "Moderate: their genes share one mechanism, galactose catabolism (3 of the 81 diseases with a mechanism on record).", "Exploratory: their genes share one mechanism, Developmental Lineage of Pancreatic Ductal Cells (13 of the 81 diseases with a mechanism on record)." It names the mechanism that carries the score (`details.most_specific`) as the most specific of those the genes share here, never as the diseases' own mechanism; pathway names in title case are kept as Reactome writes them. `clinical_reason` names the clinical evidence: "Looks very similar: 10 shared symptoms (6 rare), about as much overlap as two records of the same disease." or "Looks different: no symptoms on record for either disease."

**Pair support** (solid or dashed line on the map): `observed` when some agreeing biology line (a full or partial match) rests on observed edges on both sides, else `inferred` when biology is above 0.

The pair's flags are the union of its dimension flags and any judgment caveats, in `FLAGS` order.

## 9. The atlas today

Baseline (`npm run grade`, no AI judgments), from `public/relevance.json`. 1,040 of the 4,278 disease pairs share something gradable; the rest share no gene, variant or mechanism, too little symptom overlap to score, and no research item beyond umbrella resources. 332 pairs are in the file (every pair in a neighbor or look-alike list): 140 moderate, 128 exploratory and 64 with no biology tier (clinical look-alikes only); 118 of the moderate pairs are allelic. Clinically, 69 look very similar, 22 similar, 64 somewhat similar and 177 different; 25 of the somewhat similar are capped for a thin record (section 8).

78 diseases have at least one biology neighbor, 62 at least one clinical look-alike, 60 both and 13 neither. The 15 without a biology neighbor are diseases whose gene Reactome does not list or whose pathways no other disease here reaches (for example Chediak-Higashi syndrome, LYST; Schnyder corneal dystrophy, UBIAD1; Sorsby fundus dystrophy, TIMP3).

| Pair | Biology | Tier | Biology reason | Clinical | Looks |
|---|---|---|---|---|---|
| Tietz syndrome - COMMAD (MITF) | 0.70 | moderate | same gene; whether both break MITF the same way is unknown; its 10 pathways come with it and are not counted | 0.75 | very similar: 2 shared symptoms, both rare, from 9 and 5 on record (few) |
| Hajdu-Cheney syndrome - Alagille syndrome 2 (NOTCH2) | 0.70 | moderate | same gene; gain versus loss of function is not visible to the engine | 0.75 | capped at somewhat similar: 1 shared symptom, one on record for each |
| Griscelli syndrome 1 - 2 (MYO5A, RAB27A) | 0.655 | moderate | 2 shared pathways, the most specific here Insulin processing (2 of 81); both genes' records mostly loss-of-function | 0.75 | very similar: 10 shared symptoms, 6 rare |
| Tay-Sachs - Sandhoff (HEXA, HEXB) | 0.629 | moderate | 5 shared pathways, the most specific here Hyaluronan degradation (2 of 81); variant types partly agree | 0 | different: no symptoms on record for either |
| Galactokinase deficiency - classic galactosemia (GALK1, GALT) | 0.5835 | moderate | Galactose catabolism (3 of 81); GALT's records set aside, GALT has 2 diseases here | 0 | different: no symptoms on record for either |
| Tietz syndrome - AEG syndrome (MITF, SOX2) | 0.5336 | moderate | 2 shared pathways, the most specific here the MITF-M targets in matrix and EMT (3 of 81), which list SOX2 as a target | 0 | different: no symptoms on record for AEG syndrome |
| Stickler syndrome 1 - osteopetrosis 3 (COL2A1, CA2) | 0.2409 | exploratory | Developmental Lineage of Pancreatic Ductal Cells (13 of 81); COL2A1's records set aside, COL2A1 has 12 diseases here | 0 | different |

**Clusters** (20, from strong and moderate links): "Same gene: COL2A1" (12), "Same gene: TGFBI" (6), "Formation of the anterior neural plate" (6: the three PAX6 eye malformations and the SOX2 AEG syndrome, joined by Tietz syndrome and COMMAD through the SOX2-MITF target link), "Same gene: GBA1" (5), "Melanin biosynthesis" (5: the oculocutaneous albinisms), "Same gene: GLB1" (4: the GM1 gangliosidoses and MPS IVB), "Same gene: BEST1", "Same gene: TWIST2", "Same gene: ITPR1" (3 each), "CS/DS degradation" (3: Tay-Sachs, Sandhoff and congenital stromal corneal dystrophy), "Galactose catabolism" (3), "Regulation of MITF-M-dependent genes involved in pigmentation" (the three Griscelli syndromes), seven "Same gene" pairs (MCOLN1, SLC4A11, LMX1B, NOTCH2, OPA1, OPA3, PIK3R1) and "Golgi Associated Vesicle Biogenesis" (Hermansky-Pudlak 2 and 7). 21 diseases have no cluster. A cluster is named by the biology most of its pairs share, so a merged community can carry a name that fits only part of it: Tietz syndrome and COMMAD sit under "Formation of the anterior neural plate", a PAX6-SOX2 pathway.

**Bridges**: 45 pairs share a research item that is not an umbrella resource (27 a patient group, 11 a paper, 5 both, 2 a grant and a paper). None crosses clusters, and 1 joins diseases that list each other nowhere else (epithelial recurrent erosion dystrophy and Lisch epithelial corneal dystrophy, through the IC3D classification of corneal dystrophies). They join diseases the biology already joins: albinism associations across the albinisms, Gaucher associations across the Gaucher types, ataxia associations between the ITPR1 ataxias, a skeletal dysplasia association across the COL2A1 dysplasias, a Tay-Sachs and Sandhoff family group, galactosemia associations and grants, and papers about one gene. Before the generic-word filter (section 2) there were 94, 26 of them across clusters, most of them through a general support group attached by a word such as "disease"; in this data no shared research item links diseases of different biology.

## 10. Where the engine and the literature disagree

Measured on the answer key (section 11) and on the pairs above:

- **Allelic pairs all score 0.70.** The engine cannot tell one protein broken the same way (Gaucher 1 and 2; OCA1A and OCA1B) from one broken in opposite ways (Hajdu-Cheney and Alagille 2) or by dose (Tietz and COMMAD), because variants hang off the gene. Cause: the data.
- **One shared gene outranks a specific shared pathway.** Tay-Sachs and Sandhoff disease lose the two subunits of one enzyme, yet score 0.629 against 0.70 for any allelic pair: the gene line's cap is 0.7, and a pathway of 16 proteins weighs 0.72 before the 0.8 cap. Cause: the engine's priors (caps and the size weight).
- **Reactome does not always hold the complex.** MLPH (Griscelli 3) is only in the MITF-M pigmentation targets pathway, reached by 8 diseases, so Griscelli 1 and 3, parts of one melanosome transport complex, score 0.4836, and only because both genes' records read as loss-of-function (0.3115 without). Cause: the data.
- **The variant line is thin evidence.** It reads three ClinVar records a gene, chosen by a search, and 30 of 52 genes look mostly loss-of-function. It now counts only where the gene has no other disease here (34 of 52 genes) and the types agree at least partly: it counts for 11 of the 150 tiered pairs between different genes and decides the tier of 4 (Griscelli 1 and 3 and Griscelli 2 and 3, Sandhoff disease and congenital stromal corneal dystrophy moderate only with it; epithelial recurrent erosion dystrophy and the same dystrophy exploratory only with it). Before that rule it decided 17, and lifted pairs such as Tietz syndrome and OCA1A (now 0.3115, exploratory) on the records of genes with several diseases. Cause: the data.
- **Pathway membership is not a shared mechanism.** A pathway does not tell an enzyme from its substrate (decorin beside HEXB: Sandhoff disease and congenital stromal corneal dystrophy, 0.5268 moderate), a regulator from its target (SOX2 among the MITF-M targets: Tietz syndrome and AEG syndrome, 0.5336 moderate), or the disease process from a side one (Insulin processing for Griscelli 1 and 2); broad signalling and developmental pathways join unrelated diseases at the exploratory tier (section 5). Cause: the data, read by an engine that only sees membership.

## 11. The answer key, and how a clinician updates it

`data/curated/answer_key.json` (rated by "literature, needs mentor review", 2026-10-03) rates 14 pairs of the atlas `high` ("The same molecular machinery is broken: one protein through the same mechanism, or the parts of one enzyme or one complex."), `medium` ("Related but different biology: one protein broken in a different way, or different steps of one specific pathway.") or `low` ("No shared molecular machinery beyond broad processes."), each with the reason and a PubMed or Reactome source:

| Pair | Rating | Why (short) | Biology | Tier | Test |
|---|---|---|---|---|---|
| Gaucher 1 - Gaucher 2 | high | one enzyme deficiency (GBA1), a continuum | 0.70 | moderate | held |
| OCA1A - OCA1B | high | tyrosinase deficiency, complete versus partial | 0.70 | moderate | held |
| Tay-Sachs - Sandhoff | high | the alpha and beta subunits of beta-hexosaminidase A | 0.629 | moderate | held |
| Griscelli 1 - Griscelli 3 | high | myosin Va and melanophilin, one melanosome transport complex | 0.4836 | moderate | known disagreement |
| Tietz - COMMAD | medium | MITF: monoallelic dominant versus biallelic | 0.70 | moderate | known disagreement |
| Hajdu-Cheney - Alagille 2 | medium | NOTCH2: gain versus loss of function | 0.70 | moderate | known disagreement |
| Galactokinase deficiency - classic galactosemia | medium | consecutive Leloir pathway enzymes | 0.5835 | moderate | held |
| OCA1A - OCA3 | medium | tyrosinase versus TYRP1, one pathway | 0.5042 | moderate | held |
| Tietz - AEG syndrome | low | MITF in melanocytes versus SOX2 in the eye and foregut; Reactome lists SOX2 as an MITF-M target | 0.5336 | moderate | known disagreement |
| Sandhoff - congenital stromal corneal dystrophy | low | lysosomal enzyme versus decorin, a substrate in Reactome | 0.5268 | moderate | known disagreement |
| Tay-Sachs - congenital stromal corneal dystrophy | low | lysosomal enzyme versus decorin, a substrate in Reactome | 0.448 | exploratory | held |
| SHORT syndrome - SCA29 | low | PI3K regulatory subunit versus IP3 receptor | 0.3251 | exploratory | held |
| Stickler 1 - osteopetrosis 3 | low | type II collagen versus carbonic anhydrase II | 0.2409 | exploratory | held |
| Finnish amyloidosis - classic galactosemia | low | gelsolin amyloid versus a galactose enzyme | 0 | none | held |

`lib/grading/answer-key.test.ts` (part of `npm test`, so part of CI) grades `public/graph.json` with the reference and checks, for every pair held to the key, that each high pair's biology is above each medium pair's, which is above each low pair's, and that a high pair is strong or moderate, a medium pair moderate, a low pair exploratory or none. It also checks that every rated pair has a "why" and a `source` that resolves to a URL in `sources`. Five pairs are listed in the test's `KNOWN_DISAGREEMENTS` with their cause (section 10): Tietz - COMMAD and Hajdu-Cheney - Alagille 2 score 0.70 like every allelic pair, level with or above the high pairs; Griscelli 1 - 3 scores below the medium pairs; Sandhoff - congenital stromal corneal dystrophy (decorin is a substrate in CS/DS degradation) and Tietz - AEG syndrome (SOX2 is an MITF-M target) are moderate although rated low. These last two were added as siblings of rated pairs (Tay-Sachs - the decorin dystrophy, and the MITF pairs), to test whether the key's agreement held beyond the pairs it happened to rate; it did not. The test fails when a new disagreement appears and when a listed one no longer holds. It prints the table with Kendall's tau-b between rating and biology: 0.8619 over the 9 held pairs, 0.5423 over all 14. The margins are thin: the closest low pair (Tay-Sachs and the decorin dystrophy, 0.448) sits 0.002 under the moderate cutoff, lifted from 0.3691 by variant types that partly agree.

To update it, a clinician or domain expert edits `expected` for any pair (and `why`, `source`), sets `rated_by` to their name and `rated_on` to the date, and runs `npm test`. If the engine disagrees, the test fails with the pair, its rating, its tier, its reason and the pairs it is out of order with. Then either the engine is wrong (constants live in `config.ts`; change them in one place, run `npm run grade`, commit the regenerated files), the data is (say which, and fix it at the source), or the disagreement is understood and listed in `KNOWN_DISAGREEMENTS` with its cause and in section 10. The ratings are never edited to make the test pass.

## 12. Neighbors, look-alikes, clusters, centrality, bridges, 3D

**Neighbors (the map).** For each disease, every other disease with a biology tier other than `none`, sorted by tier, then biology, then collaboration, then id. The first `MAX_NEIGHBORS` = 10 are shown; the rest are counted in `hidden` ("+N weaker links").

**Look-alikes.** `clinical_neighbors`: the 10 diseases with the highest clinical tier other than "Looks different", then the highest clinical score, ties broken by biology, then collaboration, then id. Sorting by tier first keeps a pair capped for a thin record below the pairs it was capped from, whatever its score. A pair in either list is in `pairs`. A collaboration bridge between two diseases that list each other in neither stays in `bridges` only, with its reason and edges; the map draws such a bridge only between diseases it already shows.

**Clusters** (`lib/grading/analytics.ts`). A disease graph of strong and moderate pairs, weighted by biology. Communities come from a deterministic Louvain (Blondel et al. 2008: resolution 1, nodes visited in sorted id order, a node moves only for a strictly better community, ties to the smaller community id, gains below 1e-12 ignored, then aggregation and repeat). Diseases with no strong or moderate link have no cluster. Larger clusters are named first and no two share a name. A cluster is named after the biology most of its pairs share: a mechanism, or a gene ("Same gene: COL2A1") when its links come from diseases of one gene. Ties go to the more specific name (higher weight; a gene weighs 1), then to a mechanism over a gene of equal weight, then to the id. Failing that, the rarest shared symptom names it ("Shared symptoms: ..."); failing that, "Group n". The eight largest clusters get color slots 1 to 8; the rest are gray as "Other".

**Centrality.** Weighted degree over strong and moderate links, divided by the largest weighted degree (0 for an isolated disease). It drives dot size.

**Two kinds of bridge.** A disease is a *bridge* when it has a strong or moderate biology link into a different cluster (none here). A *collaboration bridge* is a pair that shares at least one collaboration item that is not an umbrella resource; it is `cross_cluster` when the two diseases sit in different clusters (none here, section 9). Its reason names at most two kinds of shared work, in the order grant, researcher, study, paper, patient group, asset.

**3D layout.** Classical multidimensional scaling of the distance `1 - biology` over all diseases (power iteration with deflation from a seeded start vector, shifted by a Gershgorin bound; coordinates scaled so the farthest disease sits on the unit sphere; each axis flipped so the first disease with a non-zero value on it is positive). Pairs that were never graded count as biology 0, distance 1. The radial map and the 3D view both follow from the biology score; nothing places a disease by hand.

## 13. Bundles and AI judgments

For every pair in the relevance file, `npm run grade` writes a `PairBundle` (`buildBundles` in `lib/grading/grade.ts`): both labels, the eleven `DimensionResult`s, every edge behind a shared item plus the edges a dimension lists in its details (contradicted edges, and the two onset claims compared), and every node they refer to. The bundles are always built from the judgment-free baseline, and the file carries `meta.bundles_hash` (sha256 of the canonical JSON of the bundles array), so a judgments file is tied to exactly the evidence it judged.

An AI review workflow (any model or agent setup; none ships in this repository) returns judgments: a verdict (`supports`, `weakens`, `contradicts`, `insufficient`), a confidence, an optional `cap_tier`, coded caveats from `FLAGS`, a rationale and the edge ids it relies on. They are validated against `lib/grading/judgments.schema.json` and applied after the engine's own caps:

| Judgment | On a biology dimension, or `overall` | On a clinical or collaboration dimension |
|---|---|---|
| `supports`, `insufficient` | no change | no change |
| `weakens` | biology tier down one, once per pair | no tier change |
| `contradicts` | at most exploratory | no tier change |
| `cap_tier` | at most that tier | ignored |
| caveats | added to the pair's flags | added to the pair's flags |

A judgment about a pair the engine did not grade, or citing any edge outside the pair's evidence, is ignored and counted in a warning and in `meta.notes`. Judgments never change a number, so the map distances and the 3D layout never move because a model said so; a pair can only move outward or drop off.

## 14. Scale and output size

Comparing every disease with every other is quadratic. `candidatePairs` (`lib/grading/dimensions.ts`) builds an inverted index from genes, identical variants, mechanisms, the rarest-first prefix of each disease's symptom closure, and collaboration items that are not umbrella resources. Only pairs that share an entry are graded. The prefix filter (a standard set-similarity join) keeps, for each disease, the terms whose removal would leave at most `floor` of its information mass, where `floor` is the SimGIC at or below which the symptom score is 0; any two diseases with a higher SimGIC share a prefix term. A pair left out has biology 0, clinical 0 and no bridge, and a randomized test checks exactly that. The 3D layout never builds an n x n matrix: `sparseMds` (`lib/grading/analytics.ts`) multiplies by the double-centred matrix using only the graded pairs.

On the 93 diseases, grading takes about 60 ms (median of 7 warm runs; 124 ms on a cold start; `npm run grade` with reading, writing and the report, about 0.5 s, measured while other processes were running). The relevance file is 3.7 MB as written (2.2 MB without indentation); full pair records carry eleven dimension results and make up most of it. The bundles file is 6.6 MB. A pair that is only a research bridge stays in `bridges`, with its reason and edges, and gets no pair record or bundle.

## 15. Limitations

- **Symptoms are filtered upstream.** The pipeline keeps a phenotype only where another disease of the same Monarch cluster has it too, so 31 diseases have no symptoms, two diseases of one cluster share every symptom they list (7 pairs list identical sets), and diseases of different clusters rarely share any. Tay-Sachs and Sandhoff disease, clinically close, "look different" because neither has a symptom on record. 209 of the 332 pairs in the file carry `few_annotations`. The thin-record cap (section 8) keeps one shared symptom from reading as "looks very similar", but cannot add the symptoms that are missing. Keeping every Monarch phenotype of each disease in `pipeline/build_graph.py` would fix it.
- **No onset or inheritance.** No such term survives the filter, so the onset and inheritance dimension is unknown for every pair.
- **Variants per gene, three each.** The records are not tied to a disease, so they count only for the 34 genes with one disease here; for the other 18 (every allelic pair, and pairs such as Stickler syndrome 1 against any other gene) the variant line is unknown, 293 pairs in the file. Allelic pairs cannot be told apart by mechanism. Where the line counts, it rests on three records chosen by a search and still decides the tier of 4 pairs (section 10). Fetching ClinVar variants per condition would tie them to diseases.
- **Reactome coverage and granularity.** 9 genes (12 diseases) have no pathway; a pathway lists enzymes with their substrates and regulators with their targets, and reaches broad processes; complexes such as RAB27A-MLPH-MYO5A are not one lowest-level pathway. Weights depend on how many diseases here reach a pathway, so they change as the atlas grows.
- **Search hits and name matches.** Papers and grants are the first search results for the gene and disease name; patient groups are directory results kept by a name match. Matches on generic words are left out by a word list in the adapter (section 2); a group named for a family of diseases (albinism, ataxia, skeletal dysplasia) stays, and a word list cannot catch every general name. The pipeline is the right place for that filter.
- **The constants are priors.** Caps, thresholds, the mechanism floor, the size weight, the umbrella cutoff and the thin-record cap encode the team's judgment; the answer key (14 pairs, literature-rated, not yet reviewed by a clinician) is the only calibration of the biology score. Symptom anchors are measured on all of HPO, not on the atlas.
- **No "unknown" clinical tier.** When a disease has no symptoms on record, its clinical tier is "Looks different" and the clinical reason says the symptoms are missing.

## 16. How to run it

```bash
npm run data:hpo       # HPO files -> data/raw/hpo/ (first run only); writes data/reference/hpo-reference.json
npm run data:reactome  # Reactome analysis -> data/raw/reactome/ (cached); writes data/reference/reactome-pathways.json
npm run data:graph     # data/seed/rare_graph.json + the two reference files -> public/graph.json
npm run data:graph -- --check  # rebuild and compare with the committed graph; exit 1 on any difference
npm run grade          # -> public/relevance.json and data/grading/bundles.json, and a report
npm test               # node:test suites, including the answer key
npm run check:schema   # schema.json and public/graph.json
npm run grade:check    # recompute and compare byte for byte; exit 1 on any difference
```

`npm run grade` reads `public/graph.json`. Other flags: `--graph`, `--reference <file|none>`, `--judgments <file|none>`, `--out`, `--bundles`, `--check`; `node scripts/grade.ts --help` lists them. `npm run data:graph` takes `--seed`, `--reference <file>` or `--no-reference`, `--pathways <file>` or `--no-pathways`, `--out` and `--check`; `npm run data:reactome` takes `--refresh`, `--seed`, `--out` and `--release-date`. After changing any input, run the steps in this order, read the report, run `npm test` and `npm run grade:check`, and commit the regenerated files with the change.
