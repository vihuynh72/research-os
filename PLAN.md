# AI Atlas for the World's Rare Diseases

7th Global AI Hackathon, challenge 05. OpenAI × Buffalo Initiative × Hack-Nation.

**Team:** Jaspal, Vi, Paul. Who does what stays open. Vi is the only person with OpenAI credits, so the live API calls go through Vi's key.

The live demo must call OpenAI on Vi's key. Building the seed and the UI must not. A cached paragraph does not count as using the API.

## The bar

Maria leads a patient group for a rare disease with no approved treatment. She knows the gene. She does not know who shares the mechanism, what registry already exists, or what to do next.

She types one name into a public URL. The atlas walks a path: her disease, a pathway, another gene, a related disease, a patient group already on that pathway. Every edge has a type, a source, a confidence, and a status of `sourced` or `inferred`. She leaves with a sourced next step, or an honest gap and the question that would change the answer.

Three questions the screen must answer:

1. Who shares our biology, not just our disease name?
2. What useful work already exists?
3. What should we do together next?

If a judge cannot do that on a phone, on a public URL, the rest does not matter.

## What we are building

A small evidence graph and one complete journey. Not the world's rare-disease database. The brief says start with a focused slice.

**Slice, frozen by hour 1.** One mechanism neighborhood, about 12 diseases. Default is lysosomal storage unless Paul finds a better one in the first ten minutes. Switch only if he cannot find patient groups for at least four of the diseases. After hour 3 the slice does not change.

**Nodes we will fill:** disease (MONDO or Orphanet id), gene, mechanism or pathway, symptom (HPO), patient group, paper, study, research asset (registry, model, natural history study).

**Edges the demo must survive a click on:**

- Disease–gene, from OMIM or Orphanet, not from the model
- Disease–phenotype, from HPO
- Disease–disease via shared mechanism, labeled `sourced` or `inferred`
- Study–condition, from ClinicalTrials.gov
- Patient group–disease, from a page Paul actually opened
## OpenAI, live in the final product

Vi owns the only route that holds the key. The key goes in a Replit secret at hour 2. It never goes in git, Slack, or anyone else's laptop.

```text
POST /ai
{ "action": "explain" | "resolve" | "extract", "payload": { ... } }

200
{ "ok": true, "model": "…", "created_at": "…", "result": { ... } }
```

| Action | Payload | Result | Rule |
|---|---|---|---|
| explain | The path: edge ids, types, quotes, sources | List of `{ edge_id, sentence }` | Render a sentence only if its edge id exists. Drop extra prose. |
| resolve | `{ query, candidates }` where candidates are our node ids and aliases | One id, or null | The model cannot invent a disease. Unknown query shows the gap state. |
| extract | `{ text, pmid? }` one abstract | Claims | Keep a claim only if the quote is a substring of the pasted text. Show it as inferred, not fact. |

Until the route is real, Jaspal builds against a stub that returns `"ok": false, "stub": true`. The UI shows a visible "sample, not a live call" banner. We never demo the stub.

Vi's definition of done: the public URL triggers a new request on their key, the timestamp changes, and a failed call shows an error instead of silent fake text.

Do not call the model to decide whether two diseases are biologically the same. That decision is in Paul's seed, with a source. The model explains and proposes. The graph confirms.

**Credits and failure**

- Explain gets the path, not the whole graph. Resolve gets the candidate list. Extract gets one abstract.
- Low temperature. Timeout about 20 seconds, one retry, then an error. No unlabeled fallback.
- A labeled last-good explanation is allowed only if the screen says "cached, live call failed."
- Pre-warm one explain call before walking up to judges.
- Paul does not get a prompt playground. He reviews output Vi runs.

Hour-6 gate: one explain call succeeds on the deployed URL. If it fails, Vi fixes integration and Jaspal does not add screens.

## Hour by hour

**0–1, together. No split until the contract is written down.**

- Pick the pathway. Lysosomal storage if nobody has a better one in ten minutes.
- Write node types and the three payloads above into the decision log at the bottom.
- Paul starts listing disease names from Orphanet or NORD.
- Jaspal creates the app and the stub route, and deploys a page that says search is coming. A URL exists before lunch.
- Vi creates the OpenAI client against the payloads. Secret set before any real call.

**1–6, split.**

- Jaspal: edge store, search against the seed, path cards on the stub, phone layout started.
- Vi: the three actions and a tiny test page that hits the deployed route. Raw model output saved so a judge can see it was not typed.
- Paul: the spreadsheet. Columns are the schema. Disease, id, gene, pathway, phenotype, paper URL, trial URL, patient-group URL, one sentence on what is reusable, one sentence on what a scientist must check. He opens every URL. A link he has not opened does not go in.

**Hour 6.** Swap the stub for Vi's route. One live explain. Timestamp changes on a second click.

**6–8.** Jaspal loads Paul's JSON. Path renders. Paul sits beside the screen and rejects any card that sounds like medical advice or has no source. Vi records the tech video the moment the first extracted claim shows up on an edge. Ninety seconds, one take.

Hour-8 bar: her disease resolves, four edges render, sourced and inferred look different, one citation opens, one live call is visible.

**8–16.**

- Jaspal: path cards, edge drawer, gap state, paste-an-abstract box, phone. Search calls resolve. Path button calls explain. Paste box calls extract.
- Vi: quote check, candidate check, edge-id check, log model name and response id. Counterexample encoded once Paul names it: two diseases that share a common symptom and are deliberately not linked. README as he goes. Push every hour.
- Paul: the words on the cards. "Here is the group. Here is the registry. Here is what differs. Here is what to ask before you join forces." Then the 10× page, which is not a model call. Walkthrough script in Maria's voice, timed to 75 seconds. No new papers after hour 12.

**16, feature freeze.** No new diseases, edge types, or AI actions. Bugfix, copy, videos. Paul has veto on last-minute model copy.

**16–20.** Jaspal clicks every link on a phone. Vi cleans the README: how the seed was built, how to reproduce one call, no keys in the repo. Paul records the walkthrough from the public URL, including one paste-an-abstract so the video itself contains a live call.

**20–23.** Team video, 60 seconds, all three faces, filmed in the room. Two-page doc with five links. Paul presents Maria. Jaspal answers the graph question. Vi answers "show me the call that just happened." Practice the handoff once.

**23–24.** Submit. Do not refactor.


Every edge stores: type, source URL, evidence quote or field, confidence, status, optional contradiction. No edge without a source. Inferred edges look different from sourced ones, and the word is on the card, not only the color.

**Seed size.** About 12 diseases, 15 genes, 30 phenotypes, 10 papers, 8 studies, 6 groups. JSON in the repo. No live ETL against OMIM.

## Who we serve
## 10× page

One screen. One milestone, not an approved drug. A shared natural history study, or a go/no-go on a therapeutic hypothesis.

Two timelines. The usual path, in years, assumption written next to it. Our path, and the assumption that makes it shorter. What must be validated next. If we cannot say the assumption out loud, we are hand-waving.

## Deliverables

All five, or we are not in judging. Deadline is feature freeze plus the video window, not the start of judging.

| Artifact | Limit | Owner |
|---|---|---|
| Live demo | Public URL. Not localhost. Judges open it on their phone. | Jaspal |
| GitHub repo | Public. README covers architecture and how to reproduce the dataset and one model call. | Vi, Jaspal reviews |
| Demo / walkthrough video | 60–90 seconds. Maria's path, including one live extract. | Paul records |
| Tech video | 90 seconds. Abstract, extracted claim with a quote, reconciled node, edge on screen. Record at hour 8. | Vi |
| Team video | 60 seconds. Who did what, filmed here. | Paul |
| Doc | Two pages. User, what is real, what is mocked, five links. | Paul |

Presentation is about five minutes. Three on the demo, two for questions. If the slides disagree with the URL, the URL wins.

## How we score ourselves before they do

Event rubric, equal weight: tech depth, communication, innovation.

Their brief also looks for:

| Their row | Where it lives |
|---|---|
| Graph quality | Typed edges, clustering by mechanism not by name, a useful path, the counterexample |
| Evidence integrity | Source on every edge, inferred vs sourced, one contradiction if we have one, rejected-claims file |
| Patient progress | Maria's next-step card |
| 10× impact | One milestone, two timelines, assumptions |
| Ambition and craft | One search, plain language, the gap state |

Innovation is the path and the honesty, not a second product. The separate creativity prize is not something we design the night around.

## Hard lines

- No diagnosis. No "this treatment will work." No dosing. The next step is research collaboration.
- No real patient records. No private family stories. No scraped private groups.
- Any shared-study suggestion stays behind the sentence "a scientist has to check eligibility and mechanism." That sentence is in the UI.
- OpenAI output is a proposal until a source is attached.
- Color is never the only signal for sourced versus inferred.

## If someone gets stuck

- Vi blocked on the API for more than 45 minutes: Jaspal pairs for 30 minutes. We still need one real extraction on screen. Other claims can be labeled `manual` if the pipeline is late. A labeled manual claim beats a fake AI claim.
- Jaspal blocked on deploy: Vi owns publish. Path logic can run as a script until the URL is up. The URL is still the demo.
- Paul cannot find groups for the slice: change the slice before hour 3. After hour 3 it is frozen.
- Key dies at judging: we still have a graph, and we will likely lose the track prize. That is why hour 6 exists.
- Running out of time: drop visual polish first. Do not drop the gap state, the 10× page, the public URL, or the live explain call.

## Decision log

Fill this in during hour 0. If it is not here, it was not decided.

- Pathway:
- Maria's demo disease:
- Counterexample pair (shared symptom, not linked):
- Model name:
- Public URL:
- Repo:
- Hour-6 live call proved at:
- Hour-8 gate passed at:


| Person | Ship? |
|---|---|
| Maria, patient-group leader | Yes. This is the demo and the walkthrough. |
| Devon, newly diagnosed | One state of the same search. If no exact group exists, say so and show the closest community. |
| Priya, biotech scout | No. |
| Dr. Osei, researcher | No separate tool. He can appear as an investigator node on Maria's path. |
