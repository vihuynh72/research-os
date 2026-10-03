# CVI Atlas: 16-hour plan (v2, Oct 3, 2026)

Hack-Nation 7th Global AI Hackathon, Challenge 05 (OpenAI x Buffalo Initiative). Team: Vi, Jaspaal, Paul. Co-located, everything to main (pull before push, commit every 45 minutes). Official deadline Oct 4, 9:00 AM ET (6:00 AM PT). Team cutoff: submitted and confirmed by 4:45 AM PT.

Slide sources live in `docs/slides/` (one HTML section per slide plus `deck.json`); the rendered deck is the Claude Slides artifact "Rare Disease Atlas 16-Hour Plan".

## What we build

CVI Atlas: one search, one sourced path, one next step for a parent.

- Slice, phenotype-first: HPO "Cerebral visual impairment" HP:0100704 (synonym: cortical visual impairment). Monarch lists 199 rare diseases annotated with it (sources HPO and Orphanet), mostly monogenic: developmental and epileptic encephalopathies, brain malformations, metabolic and mitochondrial disorders. Demo on the 20 to 30 that have a gene and a patient group. CVI itself is common and multi-cause; say so in the pitch.
- Persona: the parent (the brief's Devon), voiced by Paul.
- Demo path: types CVI, gets a plain-language map; sees the conditions where CVI is core, grouped by mechanism; finds groups, registries and assessments already built; leaves with a next step or an honest gap plus what to test.
- Judging map: graph quality (typed edges, Louvain clusters, bridge nodes); evidence integrity (source, date, confidence, observed vs inferred, contradictions); patient progress (action view); 10x (shared study timeline); craft (clean, Apple-like, one search, progressive reveal).
- Architecture: fetch public APIs (Jaspaal) -> OpenAI extract + reconcile (Jaspaal) -> graph.json + clusters.json (Jaspaal) -> Next.js app on Replit (Vi) -> OpenAI explain + next step at runtime (Jaspaal + Vi). Paul owns community data, evidence QA, demo, videos, submission.
- Platform: Replit for app and Autoscale deployment, OPENAI_API_KEY in Replit Secrets, GitHub main. Pipeline runs on Jaspaal's laptop and commits graph.json. Google Cloud not needed; Cloud Run only as a fallback.
- OpenAI: Responses API + Structured Outputs (text.format json_schema strict, responses.parse); gpt-6-luna for extraction and reconciliation tie-breaks; text-embedding-3-small for synonyms; gpt-6.1-sol for explain and next step; web_search tool optional for patient groups. Precompute extraction; live calls only for resolve, explain, next step. GPT-Rosalind is trusted-access only, skip it. Confirm exact model ids in the dashboard.

## Clock (PT)

| Time | Block | Must be true at the end | Owner |
|---|---|---|---|
| 11:30-12:30 | Kickoff | schema.json committed, mock graph in the app, Replit deployment live, community CSV started | All three |
| 12:30-17:30 | Build 1 | Jaspaal: 199 CVI diseases, genes, phenotypes cached. Vi: search + graph canvas on mock. Paul: CSV + parent questions | Each lane |
| 17:30 | Merge 1 | Real graph in the app, one parent path clicks end to end, ugly is fine | All three |
| 17:30-22:30 | Build 2 | Jaspaal: extraction, clusters, explain API. Vi: evidence panel, action view, no-route state. Paul: 10x case, QA round 1, demo script | Each lane |
| 22:30 | Merge 2 + freeze | Deployed on Replit. No new features after this, only fixes | All three |
| 22:30-01:30 | Polish | 20-edge evidence QA, README, empty states, performance, bug fixes | Paul QA, others fix |
| 01:30-03:30 | Ship | 1-minute walkthrough, team video, final deploy, submission form | Paul + Vi |
| 03:30-04:45 | Buffer | Fixes only. Submitted and confirmed by 4:45 AM PT | All three |

Rules: schema.json is the contract, change it only with all three at the table. Nothing shows in the UI without a source. After 22:30 only fixes. If one lane is behind at Merge 1, the other two stop features and unblock it.

## Jaspaal: data and AI

1. 11:30 Write schema.json with Vi (JSON Schema): node types Disease, Gene, Variant, Mechanism, Phenotype, PatientOrg, Paper, Trial, Grant, Investigator; every edge carries source, url, date, confidence, kind (observed, inferred, contradicted). 30-node mock to Vi by 12:15.
2. 12:30 Monarch: all 199 diseases with HP:0100704, their genes and phenotype profiles; Reactome pathways per gene; cache raw JSON in data/raw.
3. 14:00 PubMed abstracts (30 per disease), ClinicalTrials.gov and NIH RePORTER for "cerebral visual impairment" and each gene; build_graph.py; graph.json v1 to Vi by 17:30.
4. 15:30 OpenAI extraction (gpt-6-luna, Structured Outputs): claims to edges with PMID and evidence span, kind = inferred; names to ids via synonym dictionary, then text-embedding-3-small (accept cosine > 0.9, 0.75 to 0.9 to Luna with top 5 candidates, below rejected and logged).
5. 18:00 networkx: similarity = Jaccard(HPO terms) + shared pathway + shared gene; Louvain communities = clusters; betweenness = bridges; clusters.json. Ingest Paul's CSV as PatientOrg and Asset nodes.
6. 20:00 /api/explain and /api/next-step with Vi: gpt-6.1-sol, every sentence ends with [edge:ID], nothing outside the edges, "No supported route" when no path; delete-an-edge hallucination test.
7. 22:30 Freeze. `make graph` rebuilds from cache in under 5 minutes; README data section with counts.

APIs: Monarch `https://api-v3.monarchinitiative.org/v3/api/association?object=HP:0100704&category=biolink:DiseaseToPhenotypicFeatureAssociation&limit=100&offset=0`, then `/v3/api/entity/{id}` and `/v3/api/association?subject={id}`; Reactome `https://reactome.org/ContentService/search/query?query={gene}&species=Homo sapiens&types=Pathway`; NCBI E-utilities esearch/efetch (free api_key = 10 req/s); `https://clinicaltrials.gov/api/v2/studies?query.cond=...`; POST `https://api.reporter.nih.gov/v2/projects/search`. Skip OMIM API (key approval takes days) and DisGeNET (license). Ids, never names: MONDO, HGNC, HPO, PMID, NCT.

Done when: `make graph` yields graph.json + clusters.json with 199 diseases, genes, pathways, 3+ clusters, every edge sourced; explain cites only real edge ids.

## Vi: product and infra

1. 11:30 Replit: Next.js + TypeScript + Tailwind, GitHub main connected, first deployment live by 12:00. Agree schema.json with Jaspaal.
2. 12:15 Mock loader with Zod types generated from schema.json (json-schema-to-typescript) + index by id, name, synonym. Design tokens: #FFFFFF background, #1D1D1F text, #6E6E73 secondary, #0071E3 accent, 12px radius, 1px #E5E5EA borders, system font stack.
3. 13:00 One global search (disease, gene, symptom, org): index hits first, free text to /api/resolve.
4. 14:30 Graph canvas (Cytoscape.js or react-force-graph-2d): color = cluster, size = centrality, dashed = inferred or bridge; desktop split view (graph 60%, panel 40%), mobile bottom sheet.
5. 17:30 Merge 1: swap in graph.json; one parent path clicks end to end, polish later.
6. 18:30 Evidence panel on every edge: relation, source link, date, confidence, observed vs inferred, contradictions in their own block.
7. 20:30 Action view: assets, partners, next step from /api/next-step; the No supported route state; wire /api/explain. OpenAI calls stay in route handlers (app/api/*), key never reaches the browser.
8. 22:30 Freeze. Empty, loading, error states; smooth with 500 nodes (render one cluster plus bridges at a time); rehearse with Paul at 23:00.

Routes: /search, /disease/[id], /cluster/[id], /path/[a]/[b]. graph.json static in /public, loaded once; Replit Postgres only if needed.

Done when: live Replit URL; CVI search to cluster to edge evidence to action view works on real data; no-route state exists; usable on a phone.

## Paul: domain, evidence and story

1. 11:30 Write the parent's three questions in plain words and the exact demo path (what she types, what she must see). This is the team's definition of done.
2. 12:00 CVI community CSV (`data/community.csv`, columns: name, type, disease_or_gene, url, country, contact_url, notes): patient groups (PCVIS, Perkins CVI Center and CVI Now, CVI Scotland), gene foundations, registries, assessments, investigators, centers. No URL, no row.
3. 14:00 With Jaspaal, pick 3 demo conditions from the 199: each needs a gene, a group and a reusable asset. One-line story each.
4. 16:00 10x case: today's route for a family vs the atlas route to a shared study (natural history study or shared outcome measure); cite one real timeline; 3 assumptions max; no invented numbers.
5. 18:00 QA round 1: 10 edges, open the source, true, false or unclear, report misses to Jaspaal.
6. 20:00 Demo script (60 s: 10 s family experience, 40 s the parent's path with "observed" and "inferred" said once, 10 s next step and what is unknown) + README narrative (problem, who it is for, observed vs inferred, limits). QA round 2: 20 edges, numbers into README.
7. 23:00 Rehearse with Vi; record walkthrough + team video at 01:30; submit by 03:30; final check 04:30. Confirm the submission form's required fields early.

Done when: CSV ingested; 20-edge QA numbers in README; 10x case written; both videos uploaded; submission confirmed before 4:45 AM PT.

## Submission checklist (from the brief)

Working prototype on a public URL; source repo with README covering architecture and how to reproduce the dataset; team video plus a 1-minute walkthrough of one family's journey to a justified next step or an honest gap.
