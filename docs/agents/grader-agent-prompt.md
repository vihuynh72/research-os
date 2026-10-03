# Prompt: build the AI grader for CVI Atlas

## Note for Vi (do not paste this part)

This file is a prompt for another AI (ChatGPT, Codex, or the OpenAI Agent Builder assistant). It asks that AI to build the multi-agent grading workflow: a coordinator and 11 specialist agents that review the evidence for each pair of diseases, plus the glue that feeds their judgments back into our deterministic engine. Everything it needs is below the divider. It does not assume repo access.

Attach these files with the prompt:

| File | Why |
|---|---|
| `schema.json` | the graph contract: node and edge fields, observed / inferred / contradicted |
| `lib/grading/types.ts` | the TypeScript contract: `PairBundle` in, `Judgment` and `JudgmentsDoc` out |
| `lib/grading/config.ts` | caps, thresholds and the other constants that verdicts interact with |
| `lib/grading/judgments.schema.json` | the exact schema `npm run grade` validates judgments against |
| `data/grading/bundles.sample.json` | real input: one bundle per seed pair. About 300 KB for the 10 seed pairs; produced by `npm run grade`. |
| `docs/grading.md` | the algorithm in plain words |

Also useful if it has room: `lib/grading/synthesize.ts` (how judgments change tiers), `scripts/grade.ts` (flags and validation) and `PLAN.md` (the team's OpenAI rules). If you use Codex with repo access, point it at the repo instead and tell it to read `AGENTS.md` first.

Before you paste: fill in the model ids in section 2 if you have them, and if the data changed since this was written, re-run `npm run grade` and update the counts in section 3. Section 7 copies the contract files verbatim as of Oct 3, about 3 PM PT (`lib/grading/types.ts` changed twice that afternoon); if they changed again, re-copy those blocks or rely on the attached files, which win.

What it will probably ask you, with suggested answers:

1. *Agents SDK in the repo, or Agent Builder?* The repo path (8a) first. It keeps every deterministic step in code and works for the live route. Agent Builder (8b) only as a visual mirror if time allows.
2. *Which model ids, and does the model accept temperature?* Copy pinned snapshot ids from the OpenAI dashboard. If the model rejects `temperature`, it should use the lowest reasoning effort that passes the acceptance tests.
3. *May I add npm packages?* Yes for `@openai/agents` and `zod` (and `openai` if it needs it), but install them from the Replit shell so `package-lock.json` stays consistent, or rewrite the resolved URLs the way CI does. If that is a problem, the same design works with `fetch` and no new package.
4. *What budget?* Give it a dollar cap for the batch run and a daily cap for the live route, and set a usage limit in the OpenAI dashboard.
5. *Seed or real graph?* The seed now (10 pairs). The real graph when `public/graph.json` lands.
6. *Who builds the "AI review" block in the UI?* You do. The route returns the JSON shape in section 8a.
7. *Can I run `next build` or `next dev`?* Only when nobody else is editing the repo; CI runs build and typecheck on every push.

---------------------------------------- paste everything below this line ----------------------------------------

## 1. Role and mission

You are a senior TypeScript engineer with applied-AI experience. You are joining a three-person hackathon team for a few hours. Your job is to build the **AI review layer ("grader")** of CVI Atlas, a web app that helps families and patient groups facing a rare disease find related diseases, the evidence behind each link, and the work that already exists.

The atlas already grades every pair of related diseases with a deterministic engine. Your workflow reviews that evidence with OpenAI models, dimension by dimension, and returns discrete judgments that can only make a grade more cautious. The engine then recomputes the final grades. You build the AI part and the glue. You do not change the math.

Done means:

1. A coordinator and 11 specialist agents on OpenAI review every graded pair and return judgments that validate against our schema.
2. The workflow is deterministic: the same bundles, prompts and models give a byte-identical `judgments.json` (except `meta.generated_at`), through pinned models, strict schemas, majority votes and a content-addressed cache.
3. No hallucinated links: every edge id a judgment or sentence cites exists in that pair's evidence bundle, and judgments only ever lower a tier.
4. Our deterministic step (`npm run grade`) turns the judgments into final tiers, clusters and coordinates.
5. A live route, `POST /api/judge`, reviews one selected pair on the team's OpenAI key and returns 2 to 4 plain sentences, each ending with `[edge:ID]`, for the UI.

## 2. Project context

### The challenge

Hack-Nation 7th Global AI Hackathon, Challenge 05, "AI Atlas for the World's Rare Diseases" (OpenAI x Buffalo Initiative). The brief asks for a knowledge graph of diseases, genes and variants, mechanisms, symptoms, patient groups, papers, studies and research assets, whose edges "explain how those things relate and cite the evidence". It says to "use AI to assemble and reconcile the information, then graph analytics to find meaningful clusters".

Points from the brief that shape this work:

- "Different genes can disrupt the same biological process; one gene can have different effects; similar symptoms can have different causes. Organizing by disease name misses the research a community could share."
- "Cluster diseases by variant effect, pathway, and phenotype rather than by name or category."
- "Surface when two 'unrelated' disease communities already share a key opinion leader (researcher, clinician, biotech rep, investor/funder)."
- "Show the supporting source, distinguish observations from inferred links, and surface contradictory findings." And: "No supported route? Say so."
- Studies "might inform a cluster; assess eligibility and mechanism before suggesting a shared trial".
- Built with OpenAI: Extract, Reconcile, and "Explain. Turn a graph path into plain language a family can follow, with every step citing the edge that supports it."
- Judging criteria: graph quality ("defensible clustering ... counterexamples, and clear treatment of uncertainty"), evidence integrity ("sourced, cross-checked claims that distinguish data from hypotheses"), patient progress, 10x impact, ambition and product craft.

### Who it is for

Maria, the brief's patient-group leader, and a parent with no medical background (the brief's Devon). She types her child's disease, a gene or a symptom. She sees at most 10 related diseases, graded by how much biology they share, with the reasons and the sources. Everything else is grayed out or folded into "+N weaker links".

The screen answers three questions:

1. Who shares our biology, not just our disease name?
2. What useful work already exists?
3. What should we do together next?

### Team rules (from the team's plans)

- Nothing shows in the UI without a source.
- Observed versus inferred is always visible, and color is never the only signal.
- No supported route: say so plainly, with what was searched and what is missing.
- "The model explains and proposes. The graph confirms." "Do not call the model to decide whether two diseases are biologically the same."
- OpenAI output is a proposal until a source is attached.
- No diagnosis, no "this treatment will work", no dosing. Any shared-study suggestion stays behind the sentence "a scientist has to check eligibility and mechanism".
- `schema.json` is the data contract. It changes only when all three teammates agree.
- Lanes: Vi owns the app and infrastructure (and the only OpenAI key; this work is in Vi's lane). Jaspaal owns the data and AI pipeline (`graph.json`, extraction). Paul owns community data, evidence QA and the demo story.
- Deadline: official Oct 4, 2026, 9:00 AM ET (6:00 AM PT). Team cutoff: submitted and confirmed by **4:45 AM PT on Oct 4**. Feature freeze is 22:30 PT on Oct 3; after that, only fixes. Plan for a working core well before the freeze.

### OpenAI usage rules

- Use the Responses API with Structured Outputs in strict mode (`text.format` of type `json_schema` with `strict: true`, or the SDK's equivalent).
- Models (from the team plan): **`gpt-6-luna`** for high-volume judging (the 11 specialists) and **`gpt-6.1-sol`** for the coordinator's explanation step. Confirm the exact ids in the OpenAI dashboard and pin dated snapshots. GPT-Rosalind is trusted-access only; do not use it. Pinned ids to use: specialist `<fill in>`, explainer `<fill in>`. If these still say `<fill in>`, ask Vi before the first real call; read them from environment variables (for example `GRADER_MODEL_SPECIALIST`, `GRADER_MODEL_EXPLAINER`) with no silent default.
- The live demo must call OpenAI on Vi's key; "a cached paragraph does not count as using the API". Building the seed and the UI must not call it.
- Low temperature. Timeout about 20 seconds, one retry, then an error. No unlabeled fallback: a last-good result may be shown only if it is labeled "cached, live call failed".
- Log the model name and the response id of every call, and save the raw model output, so a judge can see the output was not typed by hand.
- The key lives only on the server: Replit Secrets in deployment, a gitignored `.env.local` locally. Never in the browser, never in git.

## 3. Current state of the app

This describes the repository on Oct 3, 2026, around 3 PM PT. The last commit is `fc2fcd8`; the seed adapter, the HPO reference, the grading engine and the UI were written after it and are not committed yet. Anything marked "being written" may have changed; check the files.

### Stack, deploy, CI

- Next.js 16.3 (App Router), React 19.3, TypeScript 7 (`tsgo`), Tailwind CSS v4, Node 24. One package at the repository root. Next 16 has breaking changes: read the matching guide in `node_modules/next/dist/docs/` before writing Next code (the repo's `AGENTS.md` says so). Route handlers: `01-app/01-getting-started/15-route-handlers.md`; environment variables: `01-app/02-guides/environment-variables.md`; route segment config (`runtime` defaults to `nodejs`, the Edge runtime is deprecated, `maxDuration`): `01-app/03-api-reference/03-file-conventions/02-route-segment-config/`.
- Repository: `github.com/vihuynh72/research-os`, branch `main`.
- Hosting: Replit. Dev: `npm run dev` (port 5000). Production: Replit Autoscale, build `npm run build`, run `npm run start` (port 5000, exposed on 80). Publishing is manual from the Replit workspace (the Publish button); a push to GitHub does not redeploy. Autoscale starts and stops instances on demand, and files written at runtime should not be expected to survive or to be shared between instances, so anything the live route must read has to be committed and published.
- CI (`.github/workflows/ci.yml`), on pushes to `main` and on pull requests, with Node 24: rewrite `package-lock.json` resolved URLs from `http://package-firewall.replit.internal/npm/` to `https://registry.npmjs.org/`, then `npm ci`, `npm run check:schema`, `npm run build`, `npm run typecheck`.
- Dependencies today: `next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `typescript`, `@types/node`, `@types/react`, `@types/react-dom`, `ajv`, `ajv-formats`. **No OpenAI SDK and no `zod` are installed.**
- npm scripts: `dev`, `build`, `start`, `typecheck`, `check:schema`, `data:sample`, `data:hpo`, `grade`, `grade:check`, `test`.
- Code conventions: files under `lib/` and `scripts/` are run directly by Node 24 with type stripping. They use relative imports **with the `.ts` extension**, only erasable TypeScript (no `enum`, no `namespace`, no constructor parameter properties, no `import x = require()`), and read JSON with `fs` + `JSON.parse`. App code (`app/`, `components/`) may use `@/...` imports. Comments are short and explain why. Outputs are deterministic: sorted, floats rounded to 4 decimals, JSON with 2-space indent and a trailing newline.

### Data

The demo data today is the **CLN (Batten disease) seed**: five neuronal ceroid lipofuscinoses. CLN1 = `MONDO:0009744`, CLN2 = `MONDO:0008769`, CLN3 = `MONDO:0008767` (the team's demo disease), CLN6 = `MONDO:0011144`, CLN7 = `MONDO:0012588`.

| File | What it is | How it is made |
|---|---|---|
| `data/seed/cln_graph.json` | the seed in the team's own format (not schema format): 160 nodes, 185 edge rows | Jaspaal's `pipeline/*.py` (`python3 pipeline/run_seed.py`; `--offline` only checks): Monarch for diseases, causal genes and symptoms; ClinicalTrials.gov (40 studies for "neuronal ceroid lipofuscinosis"); PubMed (3 papers per disease, title search); NIH RePORTER (up to 3 projects per disease query); ClinVar (3 pathogenic variants per gene); the public Orphanet directory (10 patient groups and 1 registry whose names match NCL or Batten terms, checked against the hand-made list in `data/curated/orphanet_groups.json`). No API keys, no OpenAI. |
| `public/graph.sample.json` | the seed in `schema.json` format: **168 nodes** (5 Disease, 5 Gene, 15 Variant, 1 Mechanism, 60 Phenotype, 10 PatientOrg, 15 Paper, 40 Trial, 8 Grant, 8 Investigator, 1 Asset) and **184 edges** (126 observed, 58 inferred, 0 contradicted). Passes `npm run check:schema`. | `npm run data:sample` (`scripts/seed-to-graph.ts`) |
| `data/reference/hpo-reference.json` | HPO labels, information content, ancestors and the null model: HPO release 2026-09-01, annotations 2026-09-02, **12,880** annotated diseases, 166 terms (the seed's 60 and their ancestors), 20,000 random disease pairs (seed 20261003) | `npm run data:hpo` (`scripts/build-hpo-reference.ts`; downloads go to the gitignored `data/raw/hpo/`) |
| `public/graph.json` | **not built yet.** The real graph from Jaspaal's pipeline: the CVI slice, built around HPO "Cerebral visual impairment" (HP:0100704), which Monarch lists for 199 rare diseases. Same schema. | Jaspaal's pipeline |

Your code must be graph-agnostic: everything works from node types and edge endpoints, so the same workflow runs on the seed now and on `graph.json` later.

**Known seed bug, already handled.** The seed paired HPO ids with the wrong names, because `pipeline/fetch_cln_seed.py` zips Monarch's `has_phenotype` and `has_phenotype_label` arrays, which are not in the same order. Example: the seed says HP:0001250 is "Loss of speech"; HPO says it is Seizure. `scripts/seed-to-graph.ts` takes every symptom label from the HPO reference instead (57 of 60 labels changed). Scoring always uses ids, never names.

The adapter also dropped 9 grant rows the seed listed twice, suffixed 5 reused edge ids with `-2`/`-3`, sanitized edge ids to `[A-Za-z0-9_-]` (so `e-HGNC:2074-MONDO:0008767` became `e-HGNC_2074-MONDO_0008767`), and kept the 28 studies that matched no disease keyword without inventing a link for them. One Investigator node is derived per grant PI (8 in the seed).

### How observed and inferred are assigned

`scripts/seed-to-graph.ts` maps each seed relation to a schema edge. This mapping is what the specialists see as `kind`, `confidence`, `source` and `evidence`:

| Edge type (subject -> object) | kind | confidence | source | evidence text | in the sample |
|---|---|---|---|---|---|
| `causes` (gene -> disease) | observed | 1 | Monarch | none | 5 |
| `has_phenotype` (disease -> symptom) | observed | 1 | HPO (via Monarch) | none | 98 |
| `variant_of` (variant -> gene) | observed | 1 | ClinVar | "Pathogenic ClinVar hit for CLN6. Does not by itself link this variant to another disease." | 15 |
| `investigates` (researcher -> grant, derived from the grant's PI) | observed | 1 | NIH RePORTER | none | 8 |
| `disrupts_process` (disease -> mechanism) | inferred | 0.9 | Team seed (curated) | "Team-curated shared process for the CLN slice. ..." | 5 |
| `studies` (study -> disease) | inferred | 0.6 | ClinicalTrials.gov | "Study title matched a keyword for this disease (pipeline search, not a curated condition link)." | 12 |
| `about` (paper -> disease) | inferred | 0.6 | PubMed | "Title search hit. Not a claim the paper's result transfers to another CLN." | 15 |
| `funds` (grant -> disease) | inferred | 0.6 | NIH RePORTER | "RePORTER title or terms hit. Not a claim the work transfers to another CLN." | 15 |
| `works_on` (patient group -> mechanism) | inferred | 0.5 | Orphanet | "Orphanet directory result includes this disease. Not a disease-specific listing." | 10 |
| `registers` (registry -> mechanism) | inferred | 0.5 | Orphanet | same as `works_on` | 1 |

Rule of thumb: a curated database stating the fact is observed; anything found by keyword, title or directory search, or curated by the team without a source that states it, is inferred. Every edge has `date` = 2026-10-03, the retrieval date (the seed has no publication dates).

### The deterministic engine

`lib/grading/` holds pure functions with no file or network access; `scripts/grade.ts` is the command line around them. `docs/grading.md` explains the method in plain words. The pieces:

| File | Does |
|---|---|
| `lib/grading/types.ts` | the contract (section 7) |
| `lib/grading/config.ts` | the constants: caps, tier thresholds, `MAX_NEIGHBORS` = 10, calibration points, information cutoffs (rare at 0.5, generic under 0.3), `MIN_ANNOTATIONS` = 5, umbrella share 0.8 from 4 diseases, `ROUND` = 4 |
| `lib/grading/dimensions.ts` | the 11 dimension scorers, and `candidatePairs` (an inverted index over genes, variants, mechanisms, rare symptoms and non-umbrella research items, so only pairs that share something are graded) |
| `lib/grading/variants.ts` | variant effect read from HGVS notation |
| `lib/grading/simgic.ts` | information-weighted symptom similarity, shared with the reference builder |
| `lib/grading/synthesize.ts` | noisy-OR, the modifier rule, tiers, caps, and how judgments apply |
| `lib/grading/analytics.ts` | Louvain clusters, centrality, collaboration bridges, 3D coordinates (classical MDS) |
| `lib/grading/grade.ts` | `gradeGraph(graph, reference, judgments)`, `buildBundles(graph, reference, doc)`, `bundleEdgeIds`, `canonicalJson` |
| `scripts/grade.ts` | `npm run grade` and `npm run grade:check` (flags `--graph`, `--reference`, `--judgments`, `--out`, `--bundles`, `--check`; `none` turns an optional input off) |

How a pair is graded, in short:

- Each of the 11 dimensions returns a `DimensionResult`: score 0..1, status (`match`, `partial`, `none`, `unknown`), coverage, shared items with the ids of the edges behind each one, support (`observed`, `inferred` or null), a plain summary sentence, and coded flags.
- `biology = 1 - prod(1 - CAPS[d] * score_d)` over the biology dimensions; `collaboration` likewise over the collaboration dimensions; `relevance = biology`. Caps: gene 0.7, mechanism 0.6, phenotype 0.6, variant 0.25, disease 0.1; patient_org 0.5, asset 0.5, trial 0.4, investigator 0.4, grant 0.3, paper 0.3.
- Modifier rule: variant and disease count only when gene, mechanism or phenotype has status `match` or `partial`.
- Tier from biology: strong at 0.75 or more, moderate at 0.45, exploratory at 0.2, else none. Then caps, which only lower: strong needs at least two lines of evidence (biology dimensions with status `match`) and observed support, else moderate; a `variant_type_conflict` caps at moderate; a `contradicted_evidence` flag on a biology dimension caps at exploratory; then AI judgments (section 5).
- Judgment intake (`lib/grading/grade.ts`): a judgment counts only if it names a pair the engine graded (the order of `a` and `b` does not matter) and every edge it cites is in that pair's evidence: the edges behind its shared items, plus contradicted edges that touch it (`bundleEdgeIds`). Anything else is ignored and counted in a console warning and in `meta.notes`. `scripts/grade.ts` first validates the whole file against `judgments.schema.json` and refuses an invalid one.
- Each disease gets at most 10 neighbors (tier not `none`), sorted by tier, biology, collaboration, id; the rest are counted in `hidden`. The output pairs are the pairs in any neighbor list plus the collaboration bridges, and each gets a bundle.

**Baseline on the seed** (`npm run grade`, no judgments): all 10 disease pairs are graded and all 10 are in the output. 9 are strong and 1 is moderate: CLN6-CLN7, capped because its symptom overlap comes only from related terms (no identical symptom) and its mechanism link is inferred, so no line of evidence is observed. Every pair shares the curated mechanism and has symptom profiles closer than 99% of random disease pairs. There is one cluster, "Lysosomal lipofuscin accumulation", with all 5 diseases, and three collaboration bridges (CLN2-CLN3, CLN2-CLN6, CLN3-CLN6), each "Same research grant and same researcher": the Batten disease consortium grant and its PI. `data/grading/bundles.sample.json` holds 10 bundles, about 300 KB.

So on the seed, almost everything is strong. The AI review is the part that can make this map more careful, for example by asking whether a team-curated mechanism and overlap through related symptom terms really carry a "strong" link (section 5).

### The UI

The UI is being written right now (`app/page.tsx`, `components/atlas/*`), so treat this list as the plan. The data loader (`lib/data/source.ts`) is done: it serves `graph.json` with `relevance.json` when both exist, otherwise the sample pair, and warns when the grades were computed for a different build of the graph.

- One search box for diseases, genes, symptoms, groups and research (a WAI-ARIA combobox); picking a hit focuses the map on its disease. CLN3 is the default focus.
- A 2D radial map: the focus in the center, at most 10 related diseases on three rings (strong, moderate, exploratory). Distance encodes shared biology only, the ring is the tier, color is the mechanism cluster, dot size is centrality, a dashed line means inferred. A list view is the accessible twin of the map.
- A knowledge-graph view of the focus disease's neighborhood (its own genes, mechanisms, symptoms, groups and research as icons, plus related diseases and the evidence they share), filtered by one relevance threshold.
- A 3D view drawn from the engine's MDS coordinates.
- A detail panel with "Why they're connected" (biology), "Already working together" (collaboration), "What we don't know" (unknown dimensions and flags in plain words) and a path from the focus disease to the selected one, every claim linked to its source and marked observed or inferred.
- Parent and researcher modes. Parents never see a number except the symptom percentile phrase ("closer than 99% of disease pairs"); researchers also see scores, edge ids and confidence.
- Flags, including your caveats, are shown in plain words from `components/atlas/format.ts`, for example `needs_expert_review` becomes "The AI review asks a specialist to check this link." and `keyword_match_only` becomes "Some links come only from a keyword search."
- With sample data, a banner says the grades come from the deterministic baseline and that the AI review layer is not connected yet. There is no "AI review" block yet; your route feeds it and Vi wires it.

## 4. Architecture to build

Vi's design, in Vi's words: "We have to make it first of all deterministic, very deterministic. Use OpenAI agent orchestration, like Agent Builder. A coordinator agent splits the input by type and calls sub-agents, one per node type: disease, gene, variant, mechanism, phenotype, patient org, paper, trial, grant, investigator, asset. They work in parallel. Say we evaluate 10 diseases: each sub-agent grades its part and returns a grade to the coordinator. The coordinator synthesizes everything and does the final compute: the final number, the final coordinate, the final relevance matching."

The requirements after the diagram keep that shape and make it deterministic and defensible: the sub-agents return discrete judgments instead of numbers, and the "final compute" is our deterministic engine, which the coordinator calls.

```
public/graph(.sample).json + data/reference/hpo-reference.json
          |
          |  npm run grade                         (lib/grading: deterministic, no AI)
          v
public/relevance(.sample).json   (baseline grades, method "deterministic-baseline")
data/grading/bundles(.sample).json   (one PairBundle per graded pair + meta.bundles_hash)
          |
          |  scripts/judge.ts  ->  Coordinator (code)
          |     for each pair, for each of the 11 dimensions:
          |        slice the bundle -> skip if nothing to review -> cache lookup
          |        on a miss: 3 runs of the specialist, in parallel with everything else
          |
          |        biology:        gene  variant  mechanism  phenotype  disease
          |        collaboration:  patient_org  paper  trial  grant  investigator  asset
          |
          |     validate each run (schema, enums, citations) -> majority vote -> Judgment
          |     assemble JudgmentsDoc -> ajv against lib/grading/judgments.schema.json
          v
public/judgments.json
          |
          |  npm run grade   (finalize: same engine, now reading the judgments)
          v
public/relevance(.sample).json   (method "agent-judged": tiers only lowered, caveats merged,
                                  neighbors, clusters, centrality, bridges recomputed)
          |
          v
UI: radial map rings, 3D view, panels

Live, one pair:  UI -> POST /api/judge {a, b} -> bundle -> cached judgments (or a live run)
                 -> explainer (gpt-6.1-sol) -> 2-4 sentences ending in [edge:ID] -> "AI review" block.
                 The live route never changes the map.
```

### Requirements, each with its reason

**R1. Specialists judge, code computes.** Each of the 11 specialists reads only its dimension of a `PairBundle` (built by our deterministic engine: `npm run grade` writes `data/grading/bundles*.json`) and returns a discrete, schema-checked judgment: a verdict (`supports`, `weakens`, `contradicts`, `insufficient`), a confidence, coded caveats from `FLAGS`, a short rationale and the edge ids it cites. No specialist outputs a similarity percentage, a score, a tier of its own or a coordinate. The final numbers, tiers and coordinates come from `lib/grading` (noisy-OR, tier rules, Louvain clustering, MDS) when the coordinator calls the deterministic finalize step (`npm run grade`, which reads `public/judgments.json`). *Reason:* model scores are not calibrated or reproducible. The team plan says "the model explains and proposes, the graph confirms"; the brief says AI assembles and reconciles, and graph analytics finds the clusters.

**R2. Judgments can only lower a tier or add caveats, never raise one, and a judgment that cites an edge id not in its bundle is discarded.** The engine enforces both (section 3, "the deterministic engine"); your workflow must enforce them too, before anything is written. *Reason:* no hallucinated links. A model can make the atlas more careful, never more confident.

**R3. Determinism controls.**
- Pinned model snapshot ids, recorded in `JudgmentsDoc.meta.models`.
- `temperature: 0` where the model supports it. If a model rejects `temperature` (reasoning models do), omit it and use the lowest reasoning effort that passes the acceptance tests.
- Structured Outputs in strict mode, with discrete enums for verdict, confidence, cap tier and caveats.
- 3 runs per specialist per pair with a majority vote; a tie goes to the more conservative verdict (`contradicts` > `weakens` > `insufficient` > `supports`). The judgment records `runs` and `agreement`.
- A content-addressed cache keyed by `sha256(canonical slice + dimension + prompt_version + model + runs per judgment)`, so the same input always replays the same output.
*Reason:* temperature 0 alone does not make model output reproducible. Votes absorb most run-to-run noise, and the cache turns the rest into a recorded, replayable fact.

**R4. Two families.** Biology specialists (gene, variant, mechanism, phenotype, disease) decide how close a disease sits on the map. Collaboration specialists (patient_org, paper, trial, grant, investigator, asset) describe existing work and the bridges between communities. *Reason:* shared funding never makes two diseases biologically similar, and a shared researcher across biologically distant diseases is exactly the "network overlap" the brief asks for, not a reason to doubt the biology. The engine already enforces this: only judgments on a biology dimension (or `overall`) can change a tier; judgments on a collaboration dimension add caveats only (`lib/grading/synthesize.ts`).

**R5. The unit of work is one pair per dimension.** Pairs (a focus disease and a candidate) come from the deterministic shortlist: the engine's neighbor lists (at most `MAX_NEIGHBORS` = 10 per disease) plus collaboration bridges, which is exactly the set of bundles. The AI never searches for new candidates, so cost stays bounded as the graph grows. The radial ring and the 3D position follow from the final tiers and scores; the AI never invents a coordinate.

**R6. The live demo calls OpenAI on Vi's key.** A route, `app/api/judge/route.ts`, runs the workflow for one selected pair (using the cache) and returns the judgments plus 2 to 4 plain sentences, each ending with `[edge:ID]`, for the UI's "AI review" block. The key stays on the server (Replit Secrets, or `.env.local` locally, which `.gitignore` already covers with `.env*`).

**R7. Skip what has nothing to review.** The coordinator calls a specialist only when its dimension has status `match` or `partial`, at least one shared item, or the flag `contradicted_evidence`. Otherwise it records "skipped: nothing to review" in the log and emits no judgment. *Reason:* with nothing shared and nothing disputed there is nothing to confirm or lower, and a call could only add noise and cost.

**R8. Evidence never passes through a model on its way to another model.** Specialists receive their slice from code. If the coordinator is itself an agent that calls specialists as tools, the tool arguments are only the pair and the dimension; the tool's code loads the slice. *Reason:* a model re-typing evidence into a tool call can change it.

## 5. The 11 specialists

### 5.0 Shared instructions (prepend to every specialist's brief)

Use this text as the start of every specialist's instructions, then append the specialist's own brief from 5.1 to 5.11.

```text
You review one dimension of the evidence that links two rare diseases, A and B, in a
rare-disease atlas for patient families. A deterministic engine has already compared the two
diseases. You check whether that evidence means what the engine assumed. You cannot make a
link stronger. You can confirm it, say it is weaker than it looks, say the evidence itself
contradicts it, or say there is too little to judge.

INPUT: one JSON object (a "slice"):
- a, b: disease ids; labels: their names; dimension, dimension_label, family.
- result: the engine's DimensionResult for this dimension: score, status
  (match | partial | none | unknown), coverage, shared items (each with the ids of the edges
  behind it), support (observed | inferred | null), a summary sentence, flags, details.
- edges: every edge the shared items cite, plus any contradicted edge that touches them (id,
  type, subject, object, source, url, kind, confidence, and evidence text when there is one).
  kind "observed" = stated by a curated source; "inferred" = derived by a pipeline or a
  search; "contradicted" = disputed by a source.
- nodes: the nodes those items and edges refer to (id, type, label, url).

RULES
1. Use only the slice. You may use general biomedical knowledge to interpret what is in it
   (for example whether a pathway is broad or a symptom is common), but never add a fact
   about these two diseases that the slice does not contain, and never cite anything that is
   not in the slice's edges.
2. Do not grade with numbers. No similarity, percentage, score or tier of your own: the
   engine computes every number.
3. Verdicts:
   - supports: the evidence is what the engine took it to be.
   - weakens: the evidence is real but weaker than the engine's status suggests, for a reason
     the engine cannot see from structure alone (meaning, specificity, provenance). Say what
     the reason is.
   - contradicts: the slice itself contains evidence against this link: an edge of kind
     "contradicted", or evidence text that states the opposite. Outside knowledge alone is
     never enough for contradicts; use weakens with the caveat needs_expert_review instead.
   - insufficient: too little in the slice to judge.
   What a verdict does depends on your family. Biology (gene, variant, mechanism, phenotype,
   disease): weakens moves the pair down one tier on the map, contradicts drops it to at most
   "exploratory", cap_tier caps it; supports and insufficient change nothing. Collaboration
   (patient_org, paper, trial, grant, investigator, asset): your verdict never moves a disease
   on the map; it tells the family whether the shared work is real, next to "Already working
   together". In both families your caveats are added to the pair's flags and shown in plain
   words.
4. Do not double count. The engine already keeps a pair out of "strong" when its evidence is
   only inferred, already discounts common symptoms and big pathways, and already flags
   umbrella resources, inactive studies and variant types read from notation. Repeat those
   flags as caveats when they apply, but do not choose weakens only because a flag the engine
   already set says so. Choose weakens for a reason beyond the flags, and name it.
5. cap_tier: set "moderate", "exploratory" or "none" only when you can name the highest tier
   this evidence could justify on its own. Otherwise null. It can only lower, and only biology
   judgments use it.
6. cited_edges: the ids of the edges your verdict rests on, copied exactly from the slice.
   supports, weakens and contradicts cite at least one edge when the slice has edges.
   insufficient may cite none.
7. caveats: zero or more codes from the FLAGS list and nothing else. Add needs_expert_review
   when a specialist (geneticist, clinician, trial coordinator) should check before anyone
   acts on this link.
8. rationale: one or two plain sentences, under 300 characters, that a parent with no medical
   background can follow. No edge ids in the text (they go in cited_edges). No diagnosis, no
   treatment or dosing advice, no claim that research on one disease transfers to the other.
9. confidence: high when the slice states it plainly; medium when you interpret it; low when
   you lean on general knowledge or the slice is thin.
10. Same input, same answer. Be literal and consistent.

OUTPUT: exactly one JSON object with verdict, confidence, cap_tier, rationale, cited_edges and
caveats, as defined by the output schema. Nothing else.

FLAGS: generic_symptoms_only, few_annotations, uncalibrated, same_gene_allelic,
variant_type_conflict, variant_effect_unknown, derived_from_variant_notation, via_mechanism,
keyword_match_only, name_match_only, inferred_only, contradicted_evidence, umbrella_resource,
inactive_or_withdrawn, no_data, needs_expert_review
```

Each brief below says what the specialist reads, the questions it answers, what each verdict means for its dimension, the caveats it may add, examples from the seed, and the usual mistakes. The seed examples use the CLN graph described in section 3 (CLN1 = MONDO:0009744, CLN2 = MONDO:0008769, CLN3 = MONDO:0008767, CLN6 = MONDO:0011144, CLN7 = MONDO:0012588). They are for orientation, not answers to copy.

How the engine applies a judgment (`lib/grading/synthesize.ts`), after its own caps:

| Judgment | Biology dimension, or `overall` | Collaboration dimension |
|---|---|---|
| `supports` | no change | no change |
| `weakens` | down one tier (once per pair, however many specialists say so) | no tier change |
| `contradicts` | at most `exploratory` | no tier change |
| `insufficient` | no change | no change |
| `cap_tier` | at most that tier | ignored |
| `caveats` | added to the pair's flags | added to the pair's flags |

A lowered pair gets a reason such as "Lowered to moderate after AI review: the reviewer found the evidence weaker than the scores suggest." The biology and collaboration numbers never change.

### 5.1 gene: "Same gene" (biology)

**Reads.** `result.shared`: Gene nodes linked to both diseases, each with its linking edges (typically `causes`, observed, from Monarch). `status` is `match` when a gene is shared, `none` when both diseases have genes but none in common, `unknown` when a side has no gene. The engine always sets `same_gene_allelic` on a match.

**Answers.**
- Do the edges say the gene causes both diseases, from a curated source? Or is one side an association, a candidate, a modifier or a search hit?
- Could these be allelic disorders that work differently? The same gene can lose its function in one disease and gain a harmful one in another, or affect a different part of the protein.

| Verdict | Means here |
|---|---|
| supports | Both links are observed causal edges, and nothing in the slice suggests different mechanisms. Keep `same_gene_allelic`. |
| weakens | One side's link is an association, a candidate or a search hit rather than a cause (being marked inferred alone is not enough; the engine already handles that), or the evidence text points to different effects (gain versus loss of function, dominant versus recessive). Add `needs_expert_review`. |
| contradicts | An edge is `contradicted`, or evidence text says the gene does not cause one of the diseases. |
| insufficient | The slice lacks the edges or text to tell. |

**Caveats:** `same_gene_allelic`, `inferred_only`, `contradicted_evidence`, `needs_expert_review`.

**Seed.** Each CLN disease has its own gene: CLN1 PPT1, CLN2 TPP1, CLN3 CLN3, CLN6 CLN6, CLN7 MFSD8 (observed `causes` edges from Monarch). No pair shares a gene, so this dimension is `none` for all 10 pairs and the specialist is skipped (R7). That is the brief's point: different genes can disrupt the same process. The CLN diseases connect through mechanism and symptoms, not through a gene.

**Pitfalls.** "Same gene" is the brief's own counterexample ("same gene, different mechanisms"). The engine compares ids, never symbols; do the same. A large deletion that removes many genes is not the same as a change in one of them.

### 5.2 variant: "Variant type" (biology, modifier)

**Reads.** The engine classifies each variant label from its HGVS notation as loss of function (nonsense, frameshift, start loss, canonical splice site, copy-number loss), missense, other, or unknown, and compares the share of loss-of-function variants per disease: `score = 1 - |fA - fB|`, `match` at 0.75 or more, `partial` at 0.4 or more; it needs 2 classified variants per side, else `unknown` with `variant_effect_unknown`. `result.details` holds the counts per side: `lof_a`, `missense_a`, `other_a`, `unknown_a`, the same for `b`, and `lof_fraction_a`, `lof_fraction_b` (null when a side has nothing classified). `result.shared` lists only identical variants, which are rare, so the slice often has no edges. Flags: `derived_from_variant_notation` (always), `variant_effect_unknown`, `variant_type_conflict`.

This dimension is a modifier. It adds to biology only when gene, mechanism or phenotype already matches at least partly, and its cap is 0.25. A `weakens` verdict still moves the whole pair down a tier, so use it only when the variant evidence actively argues against shared biology.

**Answers.**
- Is the comparison meaningful? How many variants were classified per side, and does one variant swing the share?
- Does the notation-based class plausibly reflect the effect? A missense change can mean anything.
- Does anything in the slice suggest a different mechanism, such as a gain of function?

| Verdict | Means here |
|---|---|
| supports | Both sides have enough classified variants with the same predominant class, and nothing suggests a different mechanism. |
| weakens | The slice shows a difference in variant effect that matters and that the engine did not already flag as `variant_type_conflict`. |
| contradicts | An edge is `contradicted`, or evidence text states an opposite effect. |
| insufficient | Small samples, unparseable labels, notation only. This is the usual honest answer; add `variant_effect_unknown` or `needs_expert_review` when they fit. |

**Caveats:** `derived_from_variant_notation`, `variant_effect_unknown`, `variant_type_conflict`, `needs_expert_review`.

**Seed.** The pipeline took 3 pathogenic ClinVar variants per gene. TPP1 (CLN2): two frameshifts and "GRCh38/hg38 11p15.4(chr11:4793595-7562692)x1", a copy-number loss of about 2.8 million bases that spans TPP1 and much more. CLN6: two loss-of-function changes and "Single allele", which cannot be parsed. PPT1 (CLN1), CLN3 and MFSD8 (CLN7): two loss-of-function changes and one missense change each. With three variants a side, one variant moves the share by a third. In the baseline, variant is `match` for CLN1-CLN3, CLN1-CLN7 and CLN3-CLN7 (2 of 3 loss of function on each side) and for CLN2-CLN6 (3 of 3 and 2 of 2), and `partial` for the other 6 pairs; it is named as a line of evidence for those 4 pairs ("Strong: same mechanism, rare shared symptoms and same variant type agree."). The bundle carries these counts but not the variant names behind them, so the slice has no edges and you cannot check the parse. Expect `insufficient` unless the counts themselves show a problem.

**Pitfalls.** Pathogenic does not mean loss of function. A change near the end of a gene can escape the cell's decay of faulty messages. A deletion of many genes can cause a broader disease than the one gene would. Never infer a mechanism from counts alone.

### 5.3 mechanism: "Same mechanism" (biology)

**Reads.** `result.shared`: Mechanism nodes linked to both diseases, directly or through their genes, with the linking edges. The score is a weighted overlap: when a mechanism node records its gene count, big pathways weigh less. `match` at 0.5 or more. `result.details` holds `shared_weight` and `union_weight`.

**Answers.**
- Is the shared mechanism specific (a named process whose disruption defines the diseases) or broad (metabolism, signal transduction, a pathway with thousands of genes)?
- Who says so? A curated pathway source (observed), or a team label, a model extraction or a search (inferred)? Does the cited page actually state it?
- Does anything in the slice say the two diseases disrupt the process in different ways?

| Verdict | Means here |
|---|---|
| supports | A specific mechanism, and the evidence names it for both diseases. |
| weakens | The mechanism is broad, or one side is linked only by a label that its source does not state, or only through a gene with many unrelated roles. Consider `cap_tier: "moderate"`. |
| contradicts | A `contradicted` edge, or evidence text that one disease works through a different process. |
| insufficient | The slice cannot tell. |

**Caveats:** `inferred_only`, `via_mechanism`, `contradicted_evidence`, `needs_expert_review`.

**Seed.** All 5 CLN diseases link to one mechanism node, `PW:NCL-LYSOSOME` "Lysosomal lipofuscin accumulation", by `disrupts_process` edges that are inferred (confidence 0.9, source "Team seed (curated)"). Their URL is each disease's Monarch page, and their evidence reads "Team-curated shared process for the CLN slice. Shared process. Not a claim that one therapy treats the other CLNs." So mechanism is a match for all 10 pairs, with inferred support. The process is specific to this family of diseases, but the cited page does not state it as a mechanism. A fair verdict is `supports` with `inferred_only` and `needs_expert_review`, not `weakens`: the engine already keeps inferred-only pairs out of "strong".

**Pitfalls.** A mechanism shared by every disease in a slice cannot tell them apart. Membership of a gene in a pathway database is not evidence that the disease disrupts that pathway.

### 5.4 phenotype: "Shared symptoms" (biology)

**Reads.** `result.raw` (SimGIC: information-weighted overlap of the two symptom profiles, ancestors included), `result.percentile` (share of 20,000 random disease pairs that score lower), `score` and `status` (`match` at the 99th percentile or above, `partial` at the 95th). `result.shared` lists the exact shared HPO terms, most informative first, with `weight` = normalized information content (0 = every disease has it, 1 = one disease has it; 0.5 or more counts as rare, under 0.3 as generic). `result.details` holds `shared_exact`, `shared_rare` (shared terms with weight 0.5 or more), `terms_a`, `terms_b` (symptom terms per disease) and `raw`. When there is no exact shared term but related terms still give a score, support is `inferred`. Edges are `has_phenotype`, observed, source "HPO (via Monarch)". Flags: `generic_symptoms_only`, `few_annotations` (a side has fewer than 5 symptom terms), `uncalibrated` (no reference loaded).

**Answers.**
- Is the overlap carried by rare, telling symptoms or by common ones (seizures, developmental delay, intellectual disability)?
- Are the shared rare symptoms the hallmark of both diseases, or incidental?
- Is a high percentile driven by broad ancestor terms with few exact shared terms? Is one profile so thin that any overlap looks large?

| Verdict | Means here |
|---|---|
| supports | Several rare shared symptoms that characterize both diseases. |
| weakens | The status rests mostly on common symptoms or broad ancestors in a way the flags do not already capture, or a profile is too thin to trust a match. |
| contradicts | A `contradicted` `has_phenotype` edge, for example a symptom a source says is absent. |
| insufficient | Too few annotations to judge. |

**Caveats:** `generic_symptoms_only`, `few_annotations`, `uncalibrated`, `needs_expert_review`.

**Seed** (labels and information content from the HPO reference). CLN1 and CLN3 share 13 exact symptom terms, 5 of them rare, including "Increased neuronal autofluorescent lipopigment" (HP:0002074, 0.7567) and "Vacuolated lymphocytes" (HP:0001922, 0.7211). CLN6 and CLN7 share no exact term. Common terms such as "Seizure" (HP:0001250, 0.1495) and "Intellectual disability" (HP:0001249, 0.1412) say little on their own. In the baseline every seed pair's phenotype status is `match` (percentiles from 0.991 to 0.9992). CLN2-CLN7: "3 shared symptoms, none of them rare (e.g. Cerebral atrophy). Closer than 99.8% of random disease pairs.", with `generic_symptoms_only`: the closeness comes from related, broader terms the slice does not list. CLN6-CLN7: "No identical symptoms, but related ones put them closer than 99.1% of random disease pairs." Its slice has no edges, and its support is inferred, which is why the engine caps that pair at moderate.

Overlap through related terms is by design (SimGIC gives partial credit to broader terms), so it is not by itself a reason to weaken. When the exact shared terms are all common, keep `generic_symptoms_only`, lower your confidence, and add `needs_expert_review` if the pair's tier rests on it.

**Pitfalls.** Similar symptoms can have different causes (the brief). Reason from ids and the labels the slice gives. The original seed attached labels to the wrong ids (fixed from HPO since); if a label ever looks wrong for its id, add `needs_expert_review` instead of reasoning from the label. Onset and inheritance are not symptoms; they belong to the `disease` dimension.

### 5.5 disease: "Onset and inheritance" (biology, modifier)

**Reads.** `result.shared`: shared HPO inheritance terms (aspect I) and onset or course terms (aspect C). Two facets, inheritance and onset; `score` = shared facets / facets present on both sides; `unknown` when no facet is present on both.

**Answers.**
- Do the shared terms mean the same thing (same inheritance mode, same onset class)?
- Does a difference matter for a shared natural-history study (for example, infantile versus juvenile onset)? That matters for study design, not for shared biology.

| Verdict | Means here |
|---|---|
| supports | Same inheritance and/or onset class, as stated. |
| weakens | Rare: only when the slice shows the facets conflict in a way the engine missed. |
| contradicts | A `contradicted` edge. |
| insufficient | A facet is missing on one side. |

**Caveats:** `few_annotations`, `no_data`, `needs_expert_review`.

**Seed.** Every symptom term in the seed has HPO aspect P (the seed fetch also dropped "Autosomal recessive inheritance"), so this dimension is `unknown` for all 10 pairs and the specialist is skipped.

**Pitfalls.** A disease's name and its MONDO category are **not** evidence. The brief says to cluster "by variant effect, pathway, and phenotype rather than by name or category". Two diseases named "neuronal ceroid lipofuscinosis" are not related because of the name, and a differently named disease can share the same mechanism. Most monogenic diseases in a slice share an inheritance mode, so it says little; that is why the cap is 0.1.

### 5.6 patient_org: "Patient groups" (collaboration)

**Reads.** `result.shared`: PatientOrg nodes linked to both diseases, directly or through a shared mechanism or gene (`via` is set and the flag `via_mechanism` is on). `umbrella_resource` marks a group linked to at least 80% of the graph's diseases (in a graph of at least 4 diseases).

**Answers.**
- Does the evidence say the group serves both diseases, or is it a directory listing that only "includes" them, or a name match?
- Is it an umbrella group for a whole disease family? Is the link direct, or only through the shared mechanism?

| Verdict | Means here |
|---|---|
| supports | The group's own listing names both diseases (or the family both belong to), and the link is direct. |
| weakens | A directory "includes" listing, a name match, or a link through the mechanism only. |
| contradicts | Evidence that the group serves only one of the two. |
| insufficient | No evidence text. |

**Caveats:** `name_match_only`, `via_mechanism`, `umbrella_resource`, `inferred_only`, `needs_expert_review`.

**Seed.** 10 patient groups from the public Orphanet directory (for example "BDFA UK - Batten Disease Family Association", "NCL-Gruppe Deutschland e.V.", "Norsk NCL-forening"), kept because their names match NCL, Batten, ceroid or lipofuscin. The directory says its results include the disease without being specific to it, so each group is attached to the shared mechanism node by an inferred `works_on` edge (confidence 0.5, evidence "Orphanet directory result includes this disease. Not a disease-specific listing."). Every pair therefore shares all 10 groups through the mechanism, with `via_mechanism` and `umbrella_resource` (5 of 5 diseases). They are real contacts for Maria, but they do not show that two specific CLN communities already work together.

**Pitfalls.** A national NCL federation plausibly serves every CLN type, but the evidence here is a directory match, not the group's own statement. Never upgrade a name match to a confirmed membership.

### 5.7 paper: "Papers" (collaboration)

**Reads.** `result.shared`: Paper nodes linked to both diseases, with the linking edges and their evidence text.

**Answers.** Is the paper about both diseases (a comparison, a review of the family), or a title search hit for one? Was the link curated or found by keyword?

| Verdict | Means here |
|---|---|
| supports | The evidence states the paper studies both diseases. |
| weakens | A title or keyword hit, or a broad review that covers the whole family. |
| contradicts | Evidence that the paper reports the two differ in the way claimed. |
| insufficient | No evidence text. |

**Caveats:** `keyword_match_only`, `inferred_only`, `umbrella_resource`, `needs_expert_review`.

**Seed.** 15 papers, 3 per disease from a PubMed title search, each linked to one disease (inferred, evidence "Title search hit. Not a claim the paper's result transfers to another CLN."). No paper is shared, so the specialist is skipped for every seed pair. The review "Neuronal ceroid lipofuscinoses: research update." (PMID:11073228) covers the whole family but is linked only to CLN1, and the atlas must not add the missing links on its own.

**Pitfalls.** A shared paper shows that two diseases were studied together, not that they share biology.

### 5.8 trial: "Clinical studies" (collaboration)

**Reads.** `result.shared`: Trial nodes linked to both diseases; the node label is the study title. Bundle nodes carry no status or eligibility, so the engine's flag `inactive_or_withdrawn` (status WITHDRAWN, TERMINATED or UNKNOWN) is how you learn a shared study is not active.

**Answers.** Does the evidence show the study covers both diseases (its listed conditions), or is the link a title keyword match? Is it active? Would a shared study need an eligibility and mechanism check? (Always yes.)

| Verdict | Means here |
|---|---|
| supports | The evidence states the study covers both diseases. |
| weakens | A keyword match only, an inactive status, or a title that names one disease. |
| contradicts | Evidence that the study excludes one of them. |
| insufficient | Nothing to tell from. |

**Caveats:** `keyword_match_only`, `inactive_or_withdrawn`, `inferred_only`, `needs_expert_review`.

**Seed.** 40 studies from a ClinicalTrials.gov search for "neuronal ceroid lipofuscinosis" (16 completed, 8 recruiting, 7 active not recruiting, 4 withdrawn, 2 terminated, 1 unknown, 1 enrolling by invitation, 1 not yet recruiting). 12 are linked to a disease because the title contains a keyword for it (inferred 0.6, evidence "Study title matched a keyword for this disease (pipeline search, not a curated condition link)."). The other 28 stay unlinked rather than guessed. No study is linked to two diseases, so the specialist is skipped for the seed.

**Pitfalls.** The brief: "assess eligibility and mechanism before suggesting a shared trial". A withdrawn study is not an asset. Never suggest that a family join a trial.

### 5.9 grant: "Research grants" (collaboration)

**Reads.** `result.shared`: Grant nodes linked to both diseases; the node label is the project title.

**Answers.** Does the grant fund work on both diseases, or did each disease's search terms hit the same grant? Is it a consortium grant for a whole family?

| Verdict | Means here |
|---|---|
| supports | The title or evidence covers both diseases, or the family both belong to. |
| weakens | A terms hit whose title names neither disease nor their family. |
| contradicts | Evidence that the grant is restricted to one of them. |
| insufficient | Nothing to tell from. |

**Caveats:** `keyword_match_only`, `inferred_only`, `umbrella_resource`, `needs_expert_review`.

**Seed.** `NIH:U54HD122210` "Batten Disease Clinical Research Consortium" (NICHD, fiscal year 2026, contact PI Erika Augustine) is linked to CLN2, CLN3 and CLN6 by `funds` edges from NIH RePORTER searches (inferred, confidence 0.6, evidence "RePORTER title or terms hit. Not a claim the work transfers to another CLN."). It is the seed's only shared grant, shared by 3 pairs (CLN2-CLN3, CLN2-CLN6, CLN3-CLN6). It reaches 3 of 5 diseases, under the 80% umbrella share, so these pairs become collaboration bridges. A clinical research consortium for Batten disease plausibly spans these types, so `supports` with `keyword_match_only` is a fair verdict: real shared infrastructure, and no statement about shared biology.

**Pitfalls.** Shared funding never means shared biology (R4). The pipeline's search queries differ per disease, so a missing grant link is not evidence of absence.

### 5.10 investigator: "Researchers" (collaboration)

**Reads.** `result.shared`: Investigator nodes linked to both diseases, directly or through one of their grants, papers or studies (`via` names that item). In the seed, researchers are the contact PIs of NIH grants (observed `investigates` edges).

**Answers.**
- Is it the same person? Names from different sources can collide; one node from one source is stronger than a name match.
- Is the overlap independent (the person works on each disease through different projects), or is it the same shared grant counted again?
- Does it connect biologically distant diseases? That is the brief's "network overlap", and it is valuable.

| Verdict | Means here |
|---|---|
| supports | The same person (one node) is tied to both diseases by sourced work. |
| weakens | The only tie is a single shared grant (say that it repeats the grant evidence), or identity rests on a name match. |
| contradicts | Evidence that two different people were merged. |
| insufficient | Nothing to tell from. |

**Caveats:** `inferred_only`, `keyword_match_only`, `needs_expert_review`.

**Seed.** Erika Augustine, contact PI of `NIH:U54HD122210`, connects CLN2, CLN3 and CLN6 through that grant (observed `investigates` edge from NIH RePORTER). The tie is real, but it is the same evidence as the shared grant, not a second independent connection.

**Pitfalls.** Do not lower a researcher link because the two diseases are biologically far apart; that is the point of this dimension. The brief: "Surface when two 'unrelated' disease communities already share a key opinion leader".

### 5.11 asset: "Registries and assets" (collaboration)

**Reads.** `result.shared`: Asset nodes (registries, natural history studies, models, biobanks) linked to both diseases, or through their mechanism or gene (`via_mechanism`), with `umbrella_resource` when they cover most of the graph.

**Answers.** Does the asset accept or describe both diseases? Could it be reused across the two (the brief's "find what can be shared")? Is the link a directory listing?

| Verdict | Means here |
|---|---|
| supports | The asset's own listing covers both diseases or their family, and the link is direct. |
| weakens | A directory listing or name match, or a link through the mechanism only. |
| contradicts | Evidence that the asset is limited to one of them. |
| insufficient | Nothing to tell from. |

**Caveats:** `name_match_only`, `via_mechanism`, `umbrella_resource`, `inferred_only`, `needs_expert_review`.

**Seed.** One registry, `ORPHA-REG:311059` "Batten Disease Neuronal Ceroid Lipofuscinosis (NCL) Patient Registry" (United Kingdom), attached to the shared mechanism by an inferred `registers` edge from the Orphanet directory (confidence 0.5). Every pair shares it, with `via_mechanism` and `umbrella_resource`. It is exactly the kind of existing asset the brief wants surfaced for Maria, while it says nothing about which two CLN types are closest.

**Pitfalls.** A registry "for NCL" may cover every type or only some; its own page decides. Never present joining a registry as a medical decision.

### 5.12 Optional, later: an overall reviewer

The schema allows `dimension: "overall"`. Leave it out of the first version. If time allows, add one reviewer that reads the whole bundle and looks only for problems no single specialist can see (for example a shared gene together with a `variant_type_conflict`), under the same rules, schema, votes and cache.

## 6. The coordinator

The coordinator turns a bundles file into a validated `JudgmentsDoc`, and one bundle into a live review. Its deterministic parts are code, not a model. In Vi's sketch the coordinator "does the final compute: the final number, the final coordinate, the final relevance matching". Here that compute is the finalize step (6.7): `npm run grade` produces the final biology scores and tiers, the neighbor lists (the relevance matching), the clusters and the 3D coordinates from the judgments. The coordinator calls it and never computes any of those itself.

### 6.1 Input

- A bundles file: `data/grading/bundles.sample.json` for the seed, `data/grading/bundles.json` for the real graph. Shape: `{ "meta": { "engine_version", "graph_generated_at", "bundles_hash" }, "bundles": PairBundle[] }`, one bundle per pair in the relevance output, sorted by `a` then `b`. `npm run grade` always builds the bundles from the judgment-free baseline, so the file and its hash stay the same after judgments are applied. `bundles_hash` is the sha256 (hex) of `canonicalJson(bundles)`, exported by `lib/grading/grade.ts` (object keys sorted at every level, no whitespace); reuse that function instead of writing your own.
- Check `meta.engine_version` against `ENGINE_VERSION` in `lib/grading/types.ts` and stop with a clear error if they differ. Recompute the hash of the `bundles` array the same way `scripts/grade.ts` does and stop if it differs from `meta.bundles_hash` (the file was edited or truncated).

### 6.2 Plan

For each bundle in file order (pairs are sorted by `a`, then `b`, and `a < b` in string order), for each dimension in `DIMENSIONS` order:

1. Build the slice: `{ a, b, labels, dimension, dimension_label: DIMENSION_LABEL[d], family: DIMENSION_FAMILY[d], result: bundle.dimensions[d], edges, nodes }`, where `edges` holds every bundle edge cited by `result.shared[*].edges` plus the contradicted edges listed in `result.details.contradicted_edges` (a space-separated string, present only when a source disputes something), and `nodes` holds the bundle nodes whose id is `a`, `b`, a shared item id, a `via` id, or an endpoint of one of those edges. This mirrors `bundleEdgeIds` in `lib/grading/grade.ts`, the set the engine accepts citations from.
2. Skip rule (R7): skip when `status` is `none` or `unknown`, `shared` is empty and `flags` does not contain `contradicted_evidence`.
3. Cache key: `sha256(canonicalJson({ slice, dimension, prompt_version, model, runs: 3 }))`, hex. Use `canonicalJson` from `lib/grading/grade.ts`: object keys sorted at every level, arrays in their given order, no whitespace.
4. Cache hit: reuse the stored judgment and runs. Miss: schedule 3 runs.

`prompt_version` must change whenever any instruction or schema changes. Make it `"<semver>-<first 12 hex chars of sha256(shared instructions + all 11 briefs + output schema)>"`, so editing a prompt invalidates the cache by itself.

### 6.3 Fan-out

Run every scheduled specialist call in parallel under one concurrency limit (default 8, a flag), so a batch finishes quickly without hitting rate limits.

Two acceptable designs with the OpenAI Agents SDK for TypeScript:

- **Recommended: orchestration in code.** Each specialist is an `Agent` with its instructions, model, model settings and output schema. The coordinator is a function that plans the calls, runs them with `Promise.all` behind the concurrency limit, and does everything else in code. The Agents SDK documentation describes this as orchestrating via code; it is the most predictable in speed, cost and output.
- **Closer to an "agent coordinator": agents as tools.** A coordinator `Agent` gets the 11 specialists as tools (the SDK's agents-as-tools feature) with parallel tool calls enabled, and is told to call every specialist in its plan exactly once. Code must still check the calls against the plan: a missing call is made directly by code, a duplicate is ignored, and tool arguments are only `{ pair, dimension }` (R8). The coordinator model never edits a specialist's output and never writes a judgment itself.

Check the current Agents SDK documentation for the exact API (how to declare an output schema, model settings such as temperature and parallel tool calls, agents as tools, tracing). Do not rely on memory for names and signatures.

### 6.4 Validate every run

A run is valid only if all of these hold:

1. It parses and matches the specialist output schema (section 7.6), including the enums.
2. `rationale` is 1 to 400 characters after trimming (`judgments.schema.json` allows at most 400; the prompt asks for under 300).
3. Every id in `cited_edges` is a key of the slice's `edges`. One unknown id invalidates the whole run.
4. `supports`, `weakens` and `contradicts` cite at least one edge when the slice has edges.
5. `caveats` contains only `FLAGS` values, without duplicates.

An invalid run is retried once with the same input. If it is invalid again, it is discarded and logged with the reason. Never repair a run by editing its content.

### 6.5 Vote

Over the valid runs of one (pair, dimension):

- The verdict with the most votes wins. A tie goes to the more conservative verdict: `contradicts`, then `weakens`, then `insufficient`, then `supports`.
- `runs` = number of valid runs; `agreement` = winning votes / `runs`, rounded to 4 decimals.
- Fewer than 2 valid runs: no judgment for this (pair, dimension). Log it. Never guess.
- Merge the winning runs: `confidence` = the lowest among them (`low` < `medium` < `high`); `cap_tier` = the lowest tier any of them set (`none` < `exploratory` < `moderate`), omitted if none set one; `caveats` = their union in `FLAGS` order; `cited_edges` = their union, sorted; `rationale` = the first winning run's, in run order.
- Store the runs (raw parsed output, response id, model, attempt count) and the resulting judgment in the cache entry. Only completed votes are cached; failures are not, so a later run can succeed.

### 6.6 Assemble the JudgmentsDoc

- `judgments`: one per voted (pair, dimension), with `a` and `b` copied exactly from the bundle, sorted by `a`, `b`, then dimension in `DIMENSIONS` order (`overall` last, if you add the optional reviewer in 5.12).
- `meta.generated_at`: the time of the run, ISO 8601 (the only field allowed to differ between replays).
- `meta.workflow`: a stable name, for example `"atlas-grader/agents-sdk-code"`, or the Agent Builder workflow id and version.
- `meta.prompt_version`: as in 6.2. `meta.models`: for example `{ "specialist": "<pinned id>" }`, plus any other model used.
- `meta.engine_version` and `meta.bundles_hash`: copied from the bundles file.
- `meta.runs_per_judgment`: 3.
- Validate the whole document with Ajv 2020 (`ajv/dist/2020.js` plus `ajv-formats`, as `scripts/check-schema.mjs` does) against `lib/grading/judgments.schema.json`, and re-check every citation against the pair's bundle edges. Write `public/judgments.json` only if both pass: 2-space indent, trailing newline, written to a temp file and renamed.

### 6.7 Finalize (deterministic)

Run `npm run grade` (`scripts/grade.ts`). It reads `public/judgments.json` when it exists (or `--judgments <file>`; `--judgments none` turns them off), validates the file against `lib/grading/judgments.schema.json` with Ajv and stops on any schema error, drops judgments about pairs it did not grade and judgments that cite an edge outside the pair's evidence (counted in a console warning and in `meta.notes`), notes a `bundles_hash` or `engine_version` mismatch, writes the relevance file with `meta.method` = `agent-judged`, and rewrites the bundles from the baseline. Then run `npm run grade:check` (recomputes everything and compares byte for byte). Then print, per pair, the tier before and after, and the number of judgments the engine applied and ignored. A rise in any tier is a bug: stop and report it.

### 6.8 Logging

Write one JSON line per model call to `data/raw/judge/log-<timestamp>.jsonl` (`data/raw/` is gitignored): pair, dimension, run index, attempt, model, response id, prompt_version, cache key, latency in ms, input and output tokens, outcome (`ok`, `schema_error`, `citation_error`, `timeout`, `http_<status>`, `error`) and the error message. Never log the API key or request headers. The committed cache entries (section 8a) hold the raw outputs that prove the calls happened.

### 6.9 Retries and errors

- Per call: 20-second timeout; one retry after a short backoff on timeouts, network errors, HTTP 429 (honor `Retry-After`) and 5xx. Then the run fails.
- A failed specialist yields no judgment, never a guess, a default verdict or a copied neighbor's verdict.
- The batch writes the judgments it could validate, lists every planned (pair, dimension) that has no judgment, and exits non-zero under `--strict` when any is missing.
- If the bundles file, the schema or the key is missing, stop before any call with a message that says what to run (`npm run grade`, or set `OPENAI_API_KEY`).

## 7. Contracts (verbatim from the repository)

These are copied from the files named. If anything here disagrees with the attached files, the files win.

### 7.1 Dimensions and families (`lib/grading/types.ts`)

```ts
export const ENGINE_VERSION = "0.1.0";

// Biology answers "who shares our biology?". Collaboration answers "who already works
// alongside us?". They are scored separately: shared funding never makes two diseases
// look biologically similar.
export const BIOLOGY_DIMENSIONS = ["gene", "variant", "mechanism", "phenotype", "disease"] as const;
export const COLLABORATION_DIMENSIONS = ["patient_org", "paper", "trial", "grant", "investigator", "asset"] as const;
export const DIMENSIONS = [...BIOLOGY_DIMENSIONS, ...COLLABORATION_DIMENSIONS] as const;

export type BiologyDimension = (typeof BIOLOGY_DIMENSIONS)[number];
export type CollaborationDimension = (typeof COLLABORATION_DIMENSIONS)[number];
export type Dimension = BiologyDimension | CollaborationDimension;
export type Family = "biology" | "collaboration";

export const DIMENSION_FAMILY: Record<Dimension, Family> = {
  gene: "biology",
  variant: "biology",
  mechanism: "biology",
  phenotype: "biology",
  disease: "biology",
  patient_org: "collaboration",
  paper: "collaboration",
  trial: "collaboration",
  grant: "collaboration",
  investigator: "collaboration",
  asset: "collaboration",
};

// Plain-language names for the UI and for prompts.
export const DIMENSION_LABEL: Record<Dimension, string> = {
  gene: "Same gene",
  variant: "Variant type",
  mechanism: "Same mechanism",
  phenotype: "Shared symptoms",
  disease: "Onset and inheritance",
  patient_org: "Patient groups",
  paper: "Papers",
  trial: "Clinical studies",
  grant: "Research grants",
  investigator: "Researchers",
  asset: "Registries and assets",
};
```

### 7.2 Flags, tiers, statuses (`lib/grading/types.ts`)

```ts
// Coded caveats. The engine sets some deterministically; the AI judge may add any of them.
export const FLAGS = [
  "generic_symptoms_only", // every shared symptom is common across diseases
  "few_annotations", // one disease has fewer than MIN_ANNOTATIONS symptoms on record
  "uncalibrated", // no background reference; scores are raw overlap, not percentiles
  "same_gene_allelic", // same gene: can still mean different mechanisms, check variant effect
  "variant_type_conflict", // one side loss-of-function, the other not
  "variant_effect_unknown", // too few classified variants to compare
  "derived_from_variant_notation", // variant type parsed from HGVS notation, not curated
  "via_mechanism", // linked through a shared mechanism node, not directly to the disease
  "keyword_match_only", // supported only by title or keyword search hits
  "name_match_only", // supported only by a directory name match
  "inferred_only", // no observed edge supports this line of evidence
  "contradicted_evidence", // a contradicted edge touches this link
  "umbrella_resource", // the shared item covers most diseases in the graph, so it says little
  "inactive_or_withdrawn", // shared study is withdrawn, terminated or unknown status
  "no_data", // one or both diseases have nothing recorded in this dimension
  "needs_expert_review", // the AI judge asks for a specialist to check
] as const;
export type Flag = (typeof FLAGS)[number];

export type Tier = "strong" | "moderate" | "exploratory" | "none";
export const TIER_ORDER: Record<Tier, number> = { strong: 3, moderate: 2, exploratory: 1, none: 0 };
export type Support = "observed" | "inferred";
export type DimensionStatus = "match" | "partial" | "none" | "unknown";
```

### 7.3 What a specialist reads: `PairBundle` and `DimensionResult`

```ts
// from lib/graph/types.ts
export const NODE_TYPES = [
  "Disease",
  "Gene",
  "Variant",
  "Mechanism",
  "Phenotype",
  "PatientOrg",
  "Paper",
  "Trial",
  "Grant",
  "Investigator",
  "Asset",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

// observed: stated by a curated source. inferred: derived by our pipeline or a model (drawn dashed).
// contradicted: disputed by a source (shown in its own block, never used to score).
export type EdgeKind = "observed" | "inferred" | "contradicted";

// from lib/grading/types.ts
export interface SharedItem {
  id: string;
  label: string;
  type: NodeType;
  weight: number; // 0..1 informativeness (normalized IC for symptoms, 1 otherwise)
  edges: string[]; // edge ids that tie both diseases to this item, sorted
  via?: string; // node the link passes through, e.g. a Mechanism shared by an org
  kind: EdgeKind | "mixed"; // provenance of `edges`
}

export interface DimensionResult {
  dimension: Dimension;
  family: Family;
  score: number; // 0..1, the input to synthesis
  raw?: number; // uncalibrated measure when it differs from score (e.g. phenotype SimGIC)
  percentile?: number; // phenotype: share of random disease pairs scoring lower (0..1)
  status: DimensionStatus;
  coverage: { a: number; b: number }; // items each disease has in this dimension
  shared: SharedItem[]; // sorted by weight desc, then label, then id
  support: Support | null; // observed when a shared item has observed edges on both sides
  summary: string; // deterministic plain-language sentence
  flags: Flag[];
  details?: Record<string, number | string | boolean | null>;
}

// Self-contained evidence for one pair, sent to the AI grading workflow.
export interface PairBundle {
  a: string;
  b: string;
  labels: { a: string; b: string };
  dimensions: Record<Dimension, DimensionResult>;
  edges: Record<string, { id: string; type: string; subject: string; object: string; source: string; url: string; kind: EdgeKind; confidence: number; evidence?: string }>;
  nodes: Record<string, { id: string; type: NodeType; label: string; url: string }>;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
```

### 7.4 What the workflow returns: `Judgment` and `JudgmentsDoc`

```ts
export type Verdict = "supports" | "weakens" | "contradicts" | "insufficient";
export type Confidence = "high" | "medium" | "low";

// One AI judgment. It can only lower a tier or add caveats; it never raises a grade.
export interface Judgment {
  a: string;
  b: string;
  dimension: Dimension | "overall";
  verdict: Verdict;
  confidence: Confidence;
  cap_tier?: Exclude<Tier, "strong">;
  rationale: string;
  cited_edges: string[];
  caveats: Flag[];
  runs: number;
  agreement: number; // share of runs that returned this verdict
}

export interface JudgmentsDoc {
  meta: {
    generated_at: string;
    workflow: string;
    prompt_version: string;
    models: Record<string, string>;
    engine_version: string;
    bundles_hash: string;
    runs_per_judgment?: number;
  };
  judgments: Judgment[];
}
```

### 7.5 `lib/grading/judgments.schema.json` (full)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/vihuynh72/research-os/blob/main/lib/grading/judgments.schema.json",
  "title": "Atlas grader judgments",
  "description": "Output of the AI grading workflow (judgments.json). A judgment can only lower a tier or add caveats; every number is computed by lib/grading. Mirrors Judgment and JudgmentsDoc in lib/grading/types.ts.",
  "type": "object",
  "required": ["meta", "judgments"],
  "additionalProperties": false,
  "properties": {
    "meta": {
      "type": "object",
      "required": ["generated_at", "workflow", "prompt_version", "models", "engine_version", "bundles_hash"],
      "additionalProperties": false,
      "properties": {
        "generated_at": { "type": "string", "format": "date-time" },
        "workflow": { "type": "string", "minLength": 1 },
        "prompt_version": { "type": "string", "minLength": 1 },
        "models": { "type": "object", "additionalProperties": { "type": "string" } },
        "engine_version": { "type": "string", "minLength": 1 },
        "bundles_hash": { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "sha256 of the bundles file the workflow judged." },
        "runs_per_judgment": { "type": "integer", "minimum": 1 }
      }
    },
    "judgments": { "type": "array", "items": { "$ref": "#/$defs/judgment" } }
  },
  "$defs": {
    "flag": {
      "enum": [
        "generic_symptoms_only",
        "few_annotations",
        "uncalibrated",
        "same_gene_allelic",
        "variant_type_conflict",
        "variant_effect_unknown",
        "derived_from_variant_notation",
        "via_mechanism",
        "keyword_match_only",
        "name_match_only",
        "inferred_only",
        "contradicted_evidence",
        "umbrella_resource",
        "inactive_or_withdrawn",
        "no_data",
        "needs_expert_review"
      ]
    },
    "judgment": {
      "type": "object",
      "required": ["a", "b", "dimension", "verdict", "confidence", "rationale", "cited_edges", "caveats", "runs", "agreement"],
      "additionalProperties": false,
      "properties": {
        "a": { "type": "string", "minLength": 1 },
        "b": { "type": "string", "minLength": 1 },
        "dimension": {
          "enum": ["gene", "variant", "mechanism", "phenotype", "disease", "patient_org", "paper", "trial", "grant", "investigator", "asset", "overall"]
        },
        "verdict": { "enum": ["supports", "weakens", "contradicts", "insufficient"] },
        "confidence": { "enum": ["high", "medium", "low"] },
        "cap_tier": { "enum": ["moderate", "exploratory", "none"] },
        "rationale": { "type": "string", "minLength": 1, "maxLength": 400 },
        "cited_edges": { "type": "array", "items": { "type": "string", "pattern": "^[A-Za-z0-9_-]+$" }, "uniqueItems": true },
        "caveats": { "type": "array", "items": { "$ref": "#/$defs/flag" }, "uniqueItems": true },
        "runs": { "type": "integer", "minimum": 1 },
        "agreement": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  }
}
```

### 7.6 Specialist output schema (strict mode)

This is the schema each specialist call uses. It is `judgments.schema.json`'s judgment minus the fields code fills in (`a`, `b`, `dimension`, `runs`, `agreement`). Strict mode needs every property listed in `required`, so `cap_tier` is nullable instead of optional; code drops it when it is `null`. Strict mode supports only a subset of JSON Schema keywords; check the current list, and enforce lengths and uniqueness in code (section 6.4) rather than in the schema.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "confidence", "cap_tier", "rationale", "cited_edges", "caveats"],
  "properties": {
    "verdict": { "type": "string", "enum": ["supports", "weakens", "contradicts", "insufficient"] },
    "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
    "cap_tier": { "anyOf": [{ "type": "string", "enum": ["moderate", "exploratory", "none"] }, { "type": "null" }] },
    "rationale": { "type": "string" },
    "cited_edges": { "type": "array", "items": { "type": "string" } },
    "caveats": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["generic_symptoms_only", "few_annotations", "uncalibrated", "same_gene_allelic", "variant_type_conflict", "variant_effect_unknown", "derived_from_variant_notation", "via_mechanism", "keyword_match_only", "name_match_only", "inferred_only", "contradicted_evidence", "umbrella_resource", "inactive_or_withdrawn", "no_data", "needs_expert_review"]
      }
    }
  }
}
```

Optional hardening for the code path: build this schema per call with `cited_edges.items.enum` set to the slice's edge ids, so an unknown id cannot even be generated. Keep the check in 6.4 anyway.

### 7.7 Explainer output schema (live route)

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["sentences"],
  "properties": {
    "sentences": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "edge_id"],
        "properties": { "text": { "type": "string" }, "edge_id": { "type": "string" } }
      }
    }
  }
}
```

### 7.8 One real bundle

From `data/grading/bundles.sample.json`: CLN3 (`MONDO:0008767`, the demo disease) and CLN6 (`MONDO:0011144`). It shows every kind of evidence the seed has: a shared curated mechanism, six exactly shared symptoms (four rare), the shared consortium grant and its PI (a collaboration bridge), and ten patient groups plus a registry reached through the mechanism (umbrella resources). The content is verbatim; only the layout is compacted to one edge, node or shared item per line. It is valid JSON.

```json
{
  "a": "MONDO:0008767",
  "b": "MONDO:0011144",
  "labels": {"a":"neuronal ceroid lipofuscinosis 3","b":"ceroid lipofuscinosis, neuronal, 6A"},
  "dimensions": {
    "gene": {
      "dimension": "gene",
      "family": "biology",
      "score": 0,
      "status": "none",
      "coverage": {"a":1,"b":1},
      "shared": [],
      "support": null,
      "summary": "Different genes: CLN3 for CLN3, CLN6 for CLN6.",
      "flags": []
    },
    "variant": {
      "dimension": "variant",
      "family": "biology",
      "score": 0.6667,
      "status": "partial",
      "coverage": {"a":3,"b":3},
      "shared": [],
      "support": "inferred",
      "summary": "CLN3 mixed (2 of 3 loss-of-function), CLN6 mostly loss-of-function (2 of 2).",
      "flags": ["derived_from_variant_notation"],
      "details": {"lof_a":2,"missense_a":1,"other_a":0,"unknown_a":0,"lof_b":2,"missense_b":0,"other_b":0,"unknown_b":1,"lof_fraction_a":0.6667,"lof_fraction_b":1}
    },
    "mechanism": {
      "dimension": "mechanism",
      "family": "biology",
      "score": 1,
      "status": "match",
      "coverage": {"a":1,"b":1},
      "shared": [
        {"id":"PW:NCL-LYSOSOME","label":"Lysosomal lipofuscin accumulation","type":"Mechanism","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech"],"kind":"inferred"}
      ],
      "support": "inferred",
      "summary": "Same mechanism: Lysosomal lipofuscin accumulation.",
      "flags": ["inferred_only"],
      "details": {"shared_weight":1,"union_weight":1}
    },
    "phenotype": {
      "dimension": "phenotype",
      "family": "biology",
      "score": 1,
      "raw": 0.2772,
      "percentile": 0.999,
      "status": "match",
      "coverage": {"a":30,"b":8},
      "shared": [
        {"id":"HP:0003208","label":"Fingerprint intracellular accumulation of autofluorescent lipopigment storage material","type":"Phenotype","weight":0.7678,"edges":["e-MONDO_0008767-HP_0003208","e-MONDO_0011144-HP_0003208"],"kind":"observed"},
        {"id":"HP:0002074","label":"Increased neuronal autofluorescent lipopigment","type":"Phenotype","weight":0.7567,"edges":["e-MONDO_0008767-HP_0002074","e-MONDO_0011144-HP_0002074"],"kind":"observed"},
        {"id":"HP:0003205","label":"Curvilinear intracellular accumulation of autofluorescent lipopigment storage material","type":"Phenotype","weight":0.7466,"edges":["e-MONDO_0008767-HP_0003205","e-MONDO_0011144-HP_0003205"],"kind":"observed"},
        {"id":"HP:0000529","label":"Progressive visual loss","type":"Phenotype","weight":0.5134,"edges":["e-MONDO_0008767-HP_0000529","e-MONDO_0011144-HP_0000529"],"kind":"observed"},
        {"id":"HP:0000546","label":"Retinal degeneration","type":"Phenotype","weight":0.4096,"edges":["e-MONDO_0008767-HP_0000546","e-MONDO_0011144-HP_0000546"],"kind":"observed"},
        {"id":"HP:0001250","label":"Seizure","type":"Phenotype","weight":0.1495,"edges":["e-MONDO_0008767-HP_0001250","e-MONDO_0011144-HP_0001250"],"kind":"observed"}
      ],
      "support": "observed",
      "summary": "6 shared symptoms, 4 of them rare (e.g. Fingerprint intracellular accumulation of autofluorescent lipopigment storage material). Closer than 99.9% of random disease pairs.",
      "flags": [],
      "details": {"shared_exact":6,"shared_rare":4,"terms_a":30,"terms_b":8,"raw":0.2772}
    },
    "disease": {
      "dimension": "disease",
      "family": "biology",
      "score": 0,
      "status": "unknown",
      "coverage": {"a":0,"b":0},
      "shared": [],
      "support": null,
      "summary": "No onset or inheritance on record for either disease.",
      "flags": ["no_data"],
      "details": {"inheritance_shared":null,"onset_shared":null}
    },
    "patient_org": {
      "dimension": "patient_org",
      "family": "collaboration",
      "score": 0.999,
      "status": "match",
      "coverage": {"a":10,"b":10},
      "shared": [
        {"id":"ORPHA-ORG:392089","label":"A-NCL - Associazione Nazionale Ceroidolipofuscinosi","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_392089-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:662124","label":"AEFAL: Asociación para el apoyo e investigación de la enfermedad de ceroidolipofuscinosis","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_662124-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:91211","label":"BDFA UK - Batten Disease Family Association","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_91211-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:274335","label":"Bee for Battens","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_274335-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:45762","label":"NCL-Gruppe Deutschland e.V.","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_45762-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:169890","label":"NCL-NÄCHSTENLIEBE e.V.","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_169890-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:586367","label":"Norsk NCL-forening","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_586367-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:139901","label":"Suomen INCL-yhdistys ry - INCL Föreningen","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_139901-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:139868","label":"Suomen JNCL-perheiden tukiyhdistys ry","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_139868-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"},
        {"id":"ORPHA-ORG:610594","label":"Svenska NCL föreningen","type":"PatientOrg","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-ORG_610594-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"}
      ],
      "support": "inferred",
      "summary": "10 shared patient groups, e.g. A-NCL - Associazione Nazionale Ceroidolipofuscinosi. Linked through Lysosomal lipofuscin accumulation. They cover most diseases in this atlas.",
      "flags": ["via_mechanism","inferred_only","umbrella_resource"],
      "details": {"umbrella_items":"ORPHA-ORG:139868 ORPHA-ORG:139901 ORPHA-ORG:169890 ORPHA-ORG:274335 ORPHA-ORG:392089 ORPHA-ORG:45762 ORPHA-ORG:586367 ORPHA-ORG:610594 ORPHA-ORG:662124 ORPHA-ORG:91211"}
    },
    "paper": {
      "dimension": "paper",
      "family": "collaboration",
      "score": 0,
      "status": "none",
      "coverage": {"a":3,"b":3},
      "shared": [],
      "support": null,
      "summary": "No shared papers (CLN3 has 3, CLN6 has 3).",
      "flags": []
    },
    "trial": {
      "dimension": "trial",
      "family": "collaboration",
      "score": 0,
      "status": "none",
      "coverage": {"a":3,"b":2},
      "shared": [],
      "support": null,
      "summary": "No shared clinical studies (CLN3 has 3, CLN6 has 2).",
      "flags": []
    },
    "grant": {
      "dimension": "grant",
      "family": "collaboration",
      "score": 0.5,
      "status": "match",
      "coverage": {"a":3,"b":1},
      "shared": [
        {"id":"NIH:U54HD122210","label":"Batten Disease Clinical Research Consortium","type":"Grant","weight":1,"edges":["e-NIH_U54HD122210-MONDO_0008767","e-NIH_U54HD122210-MONDO_0011144","e-NIH_U54HD122210-MONDO_0011144-2","e-NIH_U54HD122210-MONDO_0011144-3"],"kind":"inferred"}
      ],
      "support": "inferred",
      "summary": "Same research grant: Batten Disease Clinical Research Consortium.",
      "flags": ["inferred_only"]
    },
    "investigator": {
      "dimension": "investigator",
      "family": "collaboration",
      "score": 0.5,
      "status": "match",
      "coverage": {"a":3,"b":1},
      "shared": [
        {"id":"reporter:pi-augustine-erika","label":"Erika Augustine","type":"Investigator","weight":1,"edges":["e-NIH_U54HD122210-MONDO_0008767","e-NIH_U54HD122210-MONDO_0011144","e-NIH_U54HD122210-MONDO_0011144-2","e-NIH_U54HD122210-MONDO_0011144-3","e-inv-augustine-erika-NIH_U54HD122210"],"via":"NIH:U54HD122210","kind":"mixed"}
      ],
      "support": "inferred",
      "summary": "Same researcher: Erika Augustine. Linked through Batten Disease Clinical Research Consortium.",
      "flags": ["inferred_only"]
    },
    "asset": {
      "dimension": "asset",
      "family": "collaboration",
      "score": 0.5,
      "status": "match",
      "coverage": {"a":1,"b":1},
      "shared": [
        {"id":"ORPHA-REG:311059","label":"Batten Disease Neuronal Ceroid Lipofuscinosis (NCL) Patient Registry","type":"Asset","weight":1,"edges":["e-MONDO_0008767-mech","e-MONDO_0011144-mech","e-ORPHA-REG_311059-mech"],"via":"PW:NCL-LYSOSOME","kind":"inferred"}
      ],
      "support": "inferred",
      "summary": "Same registry or asset: Batten Disease Neuronal Ceroid Lipofuscinosis (NCL) Patient Registry. Linked through Lysosomal lipofuscin accumulation. It covers most diseases in this atlas.",
      "flags": ["via_mechanism","inferred_only","umbrella_resource"],
      "details": {"umbrella_items":"ORPHA-REG:311059"}
    }
  },
  "edges": {
    "e-MONDO_0008767-HP_0000529": {"id":"e-MONDO_0008767-HP_0000529","type":"has_phenotype","subject":"MONDO:0008767","object":"HP:0000529","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"observed","confidence":1},
    "e-MONDO_0008767-HP_0000546": {"id":"e-MONDO_0008767-HP_0000546","type":"has_phenotype","subject":"MONDO:0008767","object":"HP:0000546","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"observed","confidence":1},
    "e-MONDO_0008767-HP_0001250": {"id":"e-MONDO_0008767-HP_0001250","type":"has_phenotype","subject":"MONDO:0008767","object":"HP:0001250","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"observed","confidence":1},
    "e-MONDO_0008767-HP_0002074": {"id":"e-MONDO_0008767-HP_0002074","type":"has_phenotype","subject":"MONDO:0008767","object":"HP:0002074","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"observed","confidence":1},
    "e-MONDO_0008767-HP_0003205": {"id":"e-MONDO_0008767-HP_0003205","type":"has_phenotype","subject":"MONDO:0008767","object":"HP:0003205","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"observed","confidence":1},
    "e-MONDO_0008767-HP_0003208": {"id":"e-MONDO_0008767-HP_0003208","type":"has_phenotype","subject":"MONDO:0008767","object":"HP:0003208","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"observed","confidence":1},
    "e-MONDO_0008767-mech": {"id":"e-MONDO_0008767-mech","type":"disrupts_process","subject":"MONDO:0008767","object":"PW:NCL-LYSOSOME","source":"Team seed (curated)","url":"https://monarchinitiative.org/MONDO:0008767","kind":"inferred","confidence":0.9,"evidence":"Team-curated shared process for the CLN slice. Shared process. Not a claim that one therapy treats the other CLNs."},
    "e-MONDO_0011144-HP_0000529": {"id":"e-MONDO_0011144-HP_0000529","type":"has_phenotype","subject":"MONDO:0011144","object":"HP:0000529","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"observed","confidence":1},
    "e-MONDO_0011144-HP_0000546": {"id":"e-MONDO_0011144-HP_0000546","type":"has_phenotype","subject":"MONDO:0011144","object":"HP:0000546","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"observed","confidence":1},
    "e-MONDO_0011144-HP_0001250": {"id":"e-MONDO_0011144-HP_0001250","type":"has_phenotype","subject":"MONDO:0011144","object":"HP:0001250","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"observed","confidence":1},
    "e-MONDO_0011144-HP_0002074": {"id":"e-MONDO_0011144-HP_0002074","type":"has_phenotype","subject":"MONDO:0011144","object":"HP:0002074","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"observed","confidence":1},
    "e-MONDO_0011144-HP_0003205": {"id":"e-MONDO_0011144-HP_0003205","type":"has_phenotype","subject":"MONDO:0011144","object":"HP:0003205","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"observed","confidence":1},
    "e-MONDO_0011144-HP_0003208": {"id":"e-MONDO_0011144-HP_0003208","type":"has_phenotype","subject":"MONDO:0011144","object":"HP:0003208","source":"HPO (via Monarch)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"observed","confidence":1},
    "e-MONDO_0011144-mech": {"id":"e-MONDO_0011144-mech","type":"disrupts_process","subject":"MONDO:0011144","object":"PW:NCL-LYSOSOME","source":"Team seed (curated)","url":"https://monarchinitiative.org/MONDO:0011144","kind":"inferred","confidence":0.9,"evidence":"Team-curated shared process for the CLN slice. Shared process. Not a claim that one therapy treats the other CLNs."},
    "e-NIH_U54HD122210-MONDO_0008767": {"id":"e-NIH_U54HD122210-MONDO_0008767","type":"funds","subject":"NIH:U54HD122210","object":"MONDO:0008767","source":"NIH RePORTER","url":"https://reporter.nih.gov/project-details/11417480","kind":"inferred","confidence":0.6,"evidence":"RePORTER title or terms hit. Not a claim the work transfers to another CLN."},
    "e-NIH_U54HD122210-MONDO_0011144": {"id":"e-NIH_U54HD122210-MONDO_0011144","type":"funds","subject":"NIH:U54HD122210","object":"MONDO:0011144","source":"NIH RePORTER","url":"https://reporter.nih.gov/project-details/11173013","kind":"inferred","confidence":0.6,"evidence":"RePORTER title or terms hit. Not a claim the work transfers to another CLN."},
    "e-NIH_U54HD122210-MONDO_0011144-2": {"id":"e-NIH_U54HD122210-MONDO_0011144-2","type":"funds","subject":"NIH:U54HD122210","object":"MONDO:0011144","source":"NIH RePORTER","url":"https://reporter.nih.gov/project-details/11417480","kind":"inferred","confidence":0.6,"evidence":"RePORTER title or terms hit. Not a claim the work transfers to another CLN."},
    "e-NIH_U54HD122210-MONDO_0011144-3": {"id":"e-NIH_U54HD122210-MONDO_0011144-3","type":"funds","subject":"NIH:U54HD122210","object":"MONDO:0011144","source":"NIH RePORTER","url":"https://reporter.nih.gov/project-details/11417532","kind":"inferred","confidence":0.6,"evidence":"RePORTER title or terms hit. Not a claim the work transfers to another CLN."},
    "e-ORPHA-ORG_139868-mech": {"id":"e-ORPHA-ORG_139868-mech","type":"works_on","subject":"ORPHA-ORG:139868","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/139868","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_139901-mech": {"id":"e-ORPHA-ORG_139901-mech","type":"works_on","subject":"ORPHA-ORG:139901","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/139901","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_169890-mech": {"id":"e-ORPHA-ORG_169890-mech","type":"works_on","subject":"ORPHA-ORG:169890","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/169890","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_274335-mech": {"id":"e-ORPHA-ORG_274335-mech","type":"works_on","subject":"ORPHA-ORG:274335","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/274335","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_392089-mech": {"id":"e-ORPHA-ORG_392089-mech","type":"works_on","subject":"ORPHA-ORG:392089","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/392089","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_45762-mech": {"id":"e-ORPHA-ORG_45762-mech","type":"works_on","subject":"ORPHA-ORG:45762","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/45762","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_586367-mech": {"id":"e-ORPHA-ORG_586367-mech","type":"works_on","subject":"ORPHA-ORG:586367","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/586367","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_610594-mech": {"id":"e-ORPHA-ORG_610594-mech","type":"works_on","subject":"ORPHA-ORG:610594","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/610594","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_662124-mech": {"id":"e-ORPHA-ORG_662124-mech","type":"works_on","subject":"ORPHA-ORG:662124","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/662124","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-ORG_91211-mech": {"id":"e-ORPHA-ORG_91211-mech","type":"works_on","subject":"ORPHA-ORG:91211","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/patient-organisations/patient/91211","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-ORPHA-REG_311059-mech": {"id":"e-ORPHA-REG_311059-mech","type":"registers","subject":"ORPHA-REG:311059","object":"PW:NCL-LYSOSOME","source":"Orphanet","url":"https://www.orpha.net/en/research-trials/registry/311059","kind":"inferred","confidence":0.5,"evidence":"Orphanet directory result includes this disease. Not a disease-specific listing."},
    "e-inv-augustine-erika-NIH_U54HD122210": {"id":"e-inv-augustine-erika-NIH_U54HD122210","type":"investigates","subject":"reporter:pi-augustine-erika","object":"NIH:U54HD122210","source":"NIH RePORTER","url":"https://reporter.nih.gov/project-details/11417480","kind":"observed","confidence":1}
  },
  "nodes": {
    "HP:0000529": {"id":"HP:0000529","type":"Phenotype","label":"Progressive visual loss","url":"https://hpo.jax.org/browse/term/HP:0000529"},
    "HP:0000546": {"id":"HP:0000546","type":"Phenotype","label":"Retinal degeneration","url":"https://hpo.jax.org/browse/term/HP:0000546"},
    "HP:0001250": {"id":"HP:0001250","type":"Phenotype","label":"Seizure","url":"https://hpo.jax.org/browse/term/HP:0001250"},
    "HP:0002074": {"id":"HP:0002074","type":"Phenotype","label":"Increased neuronal autofluorescent lipopigment","url":"https://hpo.jax.org/browse/term/HP:0002074"},
    "HP:0003205": {"id":"HP:0003205","type":"Phenotype","label":"Curvilinear intracellular accumulation of autofluorescent lipopigment storage material","url":"https://hpo.jax.org/browse/term/HP:0003205"},
    "HP:0003208": {"id":"HP:0003208","type":"Phenotype","label":"Fingerprint intracellular accumulation of autofluorescent lipopigment storage material","url":"https://hpo.jax.org/browse/term/HP:0003208"},
    "MONDO:0008767": {"id":"MONDO:0008767","type":"Disease","label":"neuronal ceroid lipofuscinosis 3","url":"https://monarchinitiative.org/MONDO:0008767"},
    "MONDO:0011144": {"id":"MONDO:0011144","type":"Disease","label":"ceroid lipofuscinosis, neuronal, 6A","url":"https://monarchinitiative.org/MONDO:0011144"},
    "NIH:U54HD122210": {"id":"NIH:U54HD122210","type":"Grant","label":"Batten Disease Clinical Research Consortium","url":"https://reporter.nih.gov/project-details/11417480"},
    "ORPHA-ORG:139868": {"id":"ORPHA-ORG:139868","type":"PatientOrg","label":"Suomen JNCL-perheiden tukiyhdistys ry","url":"https://www.orpha.net/en/patient-organisations/patient/139868"},
    "ORPHA-ORG:139901": {"id":"ORPHA-ORG:139901","type":"PatientOrg","label":"Suomen INCL-yhdistys ry - INCL Föreningen","url":"https://www.orpha.net/en/patient-organisations/patient/139901"},
    "ORPHA-ORG:169890": {"id":"ORPHA-ORG:169890","type":"PatientOrg","label":"NCL-NÄCHSTENLIEBE e.V.","url":"https://www.orpha.net/en/patient-organisations/patient/169890"},
    "ORPHA-ORG:274335": {"id":"ORPHA-ORG:274335","type":"PatientOrg","label":"Bee for Battens","url":"https://www.orpha.net/en/patient-organisations/patient/274335"},
    "ORPHA-ORG:392089": {"id":"ORPHA-ORG:392089","type":"PatientOrg","label":"A-NCL - Associazione Nazionale Ceroidolipofuscinosi","url":"https://www.orpha.net/en/patient-organisations/patient/392089"},
    "ORPHA-ORG:45762": {"id":"ORPHA-ORG:45762","type":"PatientOrg","label":"NCL-Gruppe Deutschland e.V.","url":"https://www.orpha.net/en/patient-organisations/patient/45762"},
    "ORPHA-ORG:586367": {"id":"ORPHA-ORG:586367","type":"PatientOrg","label":"Norsk NCL-forening","url":"https://www.orpha.net/en/patient-organisations/patient/586367"},
    "ORPHA-ORG:610594": {"id":"ORPHA-ORG:610594","type":"PatientOrg","label":"Svenska NCL föreningen","url":"https://www.orpha.net/en/patient-organisations/patient/610594"},
    "ORPHA-ORG:662124": {"id":"ORPHA-ORG:662124","type":"PatientOrg","label":"AEFAL: Asociación para el apoyo e investigación de la enfermedad de ceroidolipofuscinosis","url":"https://www.orpha.net/en/patient-organisations/patient/662124"},
    "ORPHA-ORG:91211": {"id":"ORPHA-ORG:91211","type":"PatientOrg","label":"BDFA UK - Batten Disease Family Association","url":"https://www.orpha.net/en/patient-organisations/patient/91211"},
    "ORPHA-REG:311059": {"id":"ORPHA-REG:311059","type":"Asset","label":"Batten Disease Neuronal Ceroid Lipofuscinosis (NCL) Patient Registry","url":"https://www.orpha.net/en/research-trials/registry/311059"},
    "PW:NCL-LYSOSOME": {"id":"PW:NCL-LYSOSOME","type":"Mechanism","label":"Lysosomal lipofuscin accumulation","url":"https://github.com/vihuynh72/research-os/blob/main/data/seed/cln_graph.json"},
    "reporter:pi-augustine-erika": {"id":"reporter:pi-augustine-erika","type":"Investigator","label":"Erika Augustine","url":"https://reporter.nih.gov/project-details/11417480"}
  }
}
```

## 8. Implementation targets

### 8a. Code path: OpenAI Agents SDK for TypeScript, inside this repo (recommended)

**Packages.** `@openai/agents` (the Agents SDK for TypeScript) and `zod` (the schema library it uses; install the version its docs require). Add `openai` only if you call the API outside the SDK.

**Dependency caveat.** `package-lock.json` was written on Replit and its `resolved` URLs point at `http://package-firewall.replit.internal/npm/`, which only resolves inside Replit. CI rewrites those URLs to `https://registry.npmjs.org/` before `npm ci` (see section 3). So either add packages from the Replit shell (Vi does this) and commit the lockfile, or, if you install elsewhere, keep the lockfile's existing entries untouched and check that CI still passes. Do not regenerate the whole lockfile. If adding packages is blocked, implement the same design with `fetch` against the Responses API and no new package; keep the orchestration identical.

**Files.**

| File | Contents |
|---|---|
| `lib/agents/grader/prompts.ts` | shared instructions, the 11 briefs, the explainer instructions, `PROMPT_VERSION` computed from their text |
| `lib/agents/grader/schemas.ts` | specialist and explainer output schemas (7.6, 7.7), FLAGS imported from `lib/grading/types.ts` |
| `lib/agents/grader/slice.ts` | `sliceBundle(bundle, dimension)`, `shouldReview(slice)`, `canonicalJson`, `sha256` |
| `lib/agents/grader/validate.ts` | run validation (6.4), returning reasons |
| `lib/agents/grader/vote.ts` | majority vote, conservative tie-break, merge rules (6.5) |
| `lib/agents/grader/cache.ts` | content-addressed store: `data/grading/judge-cache/<first 2 hex>/<key>.json`, committed |
| `lib/agents/grader/specialists.ts` | the 11 agents (model, instructions, settings, output schema) |
| `lib/agents/grader/coordinator.ts` | `judgeBundles(doc, options)` for the batch and `judgePair(bundle, options)` for the route |
| `lib/agents/grader/explain.ts` | `explainPair(bundle, judgments)` returning checked sentences |
| `lib/agents/grader/*.test.ts` | `node:test` tests with no network: slicing, hashing, validation, vote, assembly, and a recorded seed fixture |
| `scripts/judge.ts` | the batch CLI (below) |
| `app/api/judge/route.ts` | the live route (below) |

Follow the repo conventions in section 3: `lib/` and `scripts/` files use relative imports with `.ts` extensions and erasable syntax only, because `scripts/judge.ts` runs under plain Node. Do not put `import "server-only"` in `lib/agents/grader/*` (plain Node would fail on it); keep the key out of anything a client component imports.

**`scripts/judge.ts` (batch).** Add `"judge": "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/judge.ts"` to `package.json`, next to the existing scripts. Flags: `--bundles` (default `data/grading/bundles.json` if `public/graph.json` exists, else `data/grading/bundles.sample.json`), `--out` (default `public/judgments.json`), `--concurrency` (default 8), `--pairs a|b,...` (limit to some pairs), `--dry-run` (print the plan, the number of calls and the cache hits; make no call), `--strict` (exit 1 if any planned judgment is missing). Locally, load the key with `node --env-file=.env.local`; on Replit it is already in the environment. Then run `npm run grade` (6.7).

**`app/api/judge/route.ts` (live, one pair).**

- `POST` with JSON `{ "a": "<disease id>", "b": "<disease id>" }`. Order the ids (`a < b`). Find the pair in the bundles file that matches the graph the app shows (`bundles.json` when `public/graph.json` exists, else `bundles.sample.json`), read with `fs` from `process.cwd()`. Parse it once per process and keep it in memory, as `lib/data/source.ts` does for the graph: it grows with the number of pairs (about 300 KB for the 10 seed pairs). Unknown pair: 404. Only ids that exist in the bundles file reach a model; no free text does.
- Judgments: read the committed cache entries for the pair's slices. On a miss, run the specialists live with the same code, under an overall time budget, and keep the result in memory only (runtime files on Autoscale are not a reliable store).
- Explanation: always a live call to the explainer model (`gpt-6.1-sol` per the team plan; output schema 7.7), so the demo shows a real request with a new timestamp. Input: the labels, the engine's tier and `tier_reason`, each dimension's summary and shared items with their edge ids, the judgments, and the list of allowed edge ids with their source and kind. Instructions: 2 to 4 sentences for a parent; plain words; each sentence rests on exactly one edge and reports that edge's claim; say "inferred" when that edge is inferred; a sentence may mention a judgment only through one of that judgment's cited edges; no numbers except the symptom percentile phrase the engine already wrote; no diagnosis, treatment or dosing; a shared-study idea always comes with "a scientist has to check eligibility and mechanism"; if nothing is shared, return no sentences.
- Check the explainer output in code: drop any sentence whose `edge_id` is not in the bundle's `edges` or whose text contains another `[edge:` tag; render each kept sentence as `text + " [edge:" + edge_id + "]"`. If no sentence survives, return `no_supported_route: true`, and the UI says "No supported route" plainly.
- Response, following the team's earlier `/ai` contract:

```json
{
  "ok": true,
  "model": { "specialist": "<pinned id>", "explainer": "<pinned id>" },
  "created_at": "2026-10-03T21:04:05Z",
  "result": {
    "pair": { "a": "MONDO:0008767", "b": "MONDO:0008769" },
    "tier": "moderate",
    "tier_reason": "<from relevance>",
    "judgments": [],
    "judgments_source": "cache",
    "sentences": ["... [edge:e-...]"],
    "no_supported_route": false,
    "response_ids": ["resp_..."]
  }
}
```

  Errors: `{ "ok": false, "error": "unknown_pair" | "rate_limited" | "timeout" | "upstream_error" | "disabled", "message": "..." }` with a matching HTTP status. If the explainer fails and an earlier explanation for this pair is in memory, it may be returned only with `"cached": true` and the message "cached, live call failed".
- Safety: the key is read from `process.env.OPENAI_API_KEY` on the server only (never a `NEXT_PUBLIC_` variable, never sent to the browser, never logged). Add a small in-memory rate limit per client IP and a kill switch (`JUDGE_LIVE=off` returns cached judgments without new calls, labeled as such). The route never writes to `public/` and never changes the map: tiers change only through the batch and `npm run grade`.
- UI: the "AI review" block in the disease detail panel is Vi's to wire. It shows the sentences with each `[edge:ID]` rendered as a link to that edge's source, the model and time, and "live" or "cached, live call failed".

### 8b. Agent Builder path (optional mirror)

If Vi wants the workflow visible in OpenAI's Agent Builder:

- One Agent node per specialist: instructions = shared instructions + that brief; model = the pinned specialist model; output format = JSON with the schema in 7.6; temperature 0 if the node offers it; no web search or file tools (specialists must not fetch outside facts).
- A start node that receives one pair's slices (the JSON built by code, section 6.2) and routes each slice to its specialist. Use parallel branches if the canvas has them; sequential is acceptable. An end node that returns `{ "<dimension>": <specialist output>, ... }`.
- Everything deterministic stays in our repo: slicing, the skip rule, the cache, the 3 runs and the vote, validation, `JudgmentsDoc` assembly, Ajv, and `npm run grade`. Our code calls the published workflow (or the Agents SDK code exported from it; check the current docs for both), so the canvas never computes a number or writes a file.
- Check the current Agent Builder documentation for node types, output schemas, versioning, how to call a published workflow from server code, and code export. Do not guess. If calling the workflow from our server is not practical within the deadline, use 8a and keep the canvas as a diagram for the demo.

## 9. Acceptance tests

Run these before you call it done. Report each result with numbers.

1. **Schema.** Every `JudgmentsDoc` the workflow writes validates against `lib/grading/judgments.schema.json` with Ajv 2020 + formats. Every specialist output validates against 7.6 before use.
2. **Citations: 100%.** Every id in every judgment's `cited_edges` is in that pair's bundle `edges` (and in the specialist's slice); every live sentence's edge id is in the bundle. Count and print the invalid ones: the number must be 0.
3. **Never raises a tier.** Run `npm run grade` without judgments and save the relevance file; run it with judgments; for every pair, the tier after is at most the tier before (`TIER_ORDER`), and `biology` and `collaboration` are unchanged. Also craft a judgment with verdict `supports` on a pair below `strong` and check the tier does not rise.
4. **Replay determinism.** With a warm cache, run `scripts/judge.ts` twice: the two `public/judgments.json` files are byte-identical except `meta.generated_at`. Then `npm run grade` twice gives identical files, and `npm run grade:check` passes.
5. **Delete-an-edge hallucination test** (from the team plan). Copy the sample graph, delete one edge that a judgment or a live sentence cites, for example `e-MONDO_0008767-mech`, which ties CLN3 to the shared mechanism (and through it to the patient groups and the registry). Regenerate relevance and bundles into a temp folder: `node scripts/grade.ts --graph <copy> --judgments none --out <tmp>/relevance.json --bundles <tmp>/bundles.json`. Review the affected pairs again from those bundles (their slices changed, so the cache misses). No judgment or sentence may cite the deleted id, and no sentence may state the claim that edge supported. Where it was the only support, the dimension shows nothing shared and the explainer returns no sentence for it ("No supported route" when nothing is left).
6. **Seed expectations.** Under the skip rule (R7), the seed plan is: variant 10 pairs, mechanism 10, phenotype 10, patient_org 10, asset 10, grant 3, investigator 3; gene, disease, paper and trial 0. That is 56 reviews. Check:
   - No judgment for gene, disease, paper or trial.
   - Mechanism (10 pairs): never `contradicts` (the seed has no contradicted edge); cites at least one of the pair's two `disrupts_process` edges; carries `inferred_only`.
   - Phenotype (10 pairs): never `contradicts`; CLN6-CLN7 cites nothing (its slice has no edges); CLN2-CLN7 keeps `generic_symptoms_only`.
   - Variant (10 pairs): `cited_edges` empty (no edges in the slice) and `derived_from_variant_notation` in caveats.
   - Patient_org and asset (10 pairs each): caveats include `umbrella_resource` and `via_mechanism`.
   - Grant and investigator (CLN2-CLN3, CLN2-CLN6, CLN3-CLN6): never `contradicts`; grant caveats include `keyword_match_only`.
   - After `npm run grade` with the judgments: `biology` and `collaboration` identical to the baseline for all 10 pairs; no tier higher than its baseline; a pair with a biology `weakens` is exactly one tier lower and its `tier_reason` starts with "Lowered to"; `meta.method` is `agent-judged`; `meta.notes` reports how many judgments were applied, with 0 ignored.
7. **Failure behavior.** With an invalid key, the batch writes nothing new and exits non-zero; the route returns `ok: false` with an error, never fake text. A specialist forced to return invalid JSON twice produces no judgment and a log line.
8. **Key safety.** After `npm run build`, search `.next/static` for the key's prefix and for `OPENAI_API_KEY`: no match. `git grep` finds no key.
9. **Latency and cost budget.** The seed worst case is 10 pairs x 11 specialists x 3 runs = 330 calls; with the skip rule (R7) it is 56 reviews x 3 runs = 168 calls. Print calls, cache hits, tokens in and out, wall time and estimated cost (from the current price sheet) for each batch. A batch over the seed should finish in a few minutes at concurrency 8. The live route answers in under 20 seconds on a cache miss and in a few seconds on a hit (one explainer call). Inputs are small: the largest seed slice is about 11 KB of JSON (CLN1-CLN3 phenotype, roughly 3,000 tokens at about 4 bytes per token), and a whole bundle is 18 to 33 KB.

## 10. Non-goals and forbidden actions

- Do not change `lib/grading/*` math or constants, `lib/grading/types.ts`, `lib/grading/judgments.schema.json`, `lib/graph/*`, or `schema.json` (that one needs all three teammates). If you think one needs a change, write it down for Vi.
- Do not let any model output a score, percentage, tier, cluster or coordinate that is used as such. Do not raise a tier. Do not add nodes or edges to the graph.
- Do not cite, or let a sentence mention, anything that is not in the pair's bundle. Do not give specialists web search or file search.
- Do not send the whole graph to a model; send slices (specialists) or one bundle (explainer).
- Do not put the key in client code, `NEXT_PUBLIC_*` variables, git, logs or error messages.
- Do not regenerate `package-lock.json` or add packages from outside the Replit shell without checking CI.
- Do not edit `data/seed/`, `pipeline/`, or other teammates' files. Do not commit or push; Vi reviews and pushes.
- No medical advice, no diagnosis, no patient records, no private community data.
- Do not "fix" disagreement by rerunning until the output looks right. Votes and the cache are the record.
- Do not use `Math.random()` or the clock in anything written to `public/` or the cache key, except `meta.generated_at`.

## 11. Deliverables and questions

### Deliverables checklist

- [ ] `lib/agents/grader/*` (prompts, schemas, slice, validate, vote, cache, specialists, coordinator, explain) with `node:test` tests that pass without network (`npm test` runs `lib/**/*.test.ts`).
- [ ] `scripts/judge.ts` and the `judge` npm script.
- [ ] `app/api/judge/route.ts`, with rate limit and kill switch.
- [ ] A seed run: `public/judgments.json`, the committed cache under `data/grading/judge-cache/`, and `public/relevance.sample.json` regraded (method `agent-judged`).
- [ ] The acceptance results from section 9, with numbers.
- [ ] A short `docs/agents/grader.md`: how to run the batch and the route, environment variables, and what the cache holds.
- [ ] A list of anything you could not finish or verify.

### Ask Vi before you build

1. Which path: Agents SDK in the repo (8a), Agent Builder (8b), or both?
2. The exact model snapshot ids available on the key, and whether they accept `temperature`.
3. The budget: a dollar cap for batch runs and a daily cap for the live route.
4. Who adds the npm packages from the Replit shell, and when?
5. Seed only for now, or also the real graph when `public/graph.json` lands? Which demo diseases first?
6. Is the response shape in 8a right for the "AI review" block?
7. Are committed cache files under `data/grading/judge-cache/` acceptable for the demo?
8. Do you want the optional overall reviewer (5.12) in the first version, or later?
