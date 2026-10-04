// Who the contact finder may suggest, decided without AI: the papers and grants RareVerse links to the
// disease(s), and the people on them who are worth writing to.
import type { AtlasGraph, GraphNode } from "../graph/types.ts";
import type { Candidate, CandidateSource, Grant, Paper, PatientGroup } from "./types.ts";
import { decodeEntities, displayAffiliation, fold } from "./text.ts";

export const MAX_PAPERS = 4;
export const MAX_GRANTS = 2;
export const MAX_CANDIDATES = 16;

export interface SourcePlan {
  diseases: GraphNode[];
  papers: GraphNode[]; // Paper nodes (PMID:…), best first
  grants: GraphNode[]; // Grant nodes (NIH:…), best first
}

// Words that say what kind of disease it is rather than which one; they never decide whether a title is about it.
const GENERIC_WORDS = new Set([
  "disease", "diseases", "syndrome", "syndromes", "disorder", "disorders", "type", "types", "form", "forms",
  "with", "deficiency", "autosomal", "recessive", "dominant", "linked", "infantile", "juvenile", "adult",
  "onset", "late", "early", "classic", "atypical", "variant",
]);

const squash = (s: string) => fold(s).replace(/ /g, "");

// "Tay-Sachs disease" → ["taysachs"]; "Gaucher disease type I" → ["gaucher"].
export function nameKeys(label: string): string[] {
  return label
    .split(/\s+/)
    .map(squash)
    .filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
}

export function titleMentions(title: string, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const squashed = squash(title);
  return keys.every((key) => squashed.includes(key));
}

function linkedNodes(graph: AtlasGraph, nodes: Map<string, GraphNode>, diseaseId: string, edgeType: string, nodeType: string, idPattern: RegExp): GraphNode[] {
  const found = new Map<string, GraphNode>();
  for (const edge of graph.edges) {
    if (edge.type !== edgeType) continue;
    const otherId = edge.object === diseaseId ? edge.subject : edge.subject === diseaseId ? edge.object : null;
    const node = otherId ? nodes.get(otherId) : undefined;
    if (node && node.type === nodeType && idPattern.test(node.id)) found.set(node.id, node);
  }
  return [...found.values()];
}

const idNumber = (node: GraphNode) => Number(node.id.split(":")[1]) || 0;

// Records linked to every disease come first, then each disease's own in turn, so a pair is read evenly.
// Within a list: titles that name the disease first, then the newest (PubMed and NIH ids grow over time).
// A grant renewed under the same title is one project, so only its newest year is read.
function pickRecords(diseases: GraphNode[], lists: GraphNode[][], max: number, oneProjectPerTitle: boolean): GraphNode[] {
  const keys = diseases.map((d) => nameKeys(d.label));
  const rank = (keySets: string[][]) => (a: GraphNode, b: GraphNode) => {
    const named = (n: GraphNode) => keySets.filter((k) => titleMentions(n.label, k)).length;
    return named(b) - named(a) || idNumber(b) - idNumber(a);
  };
  const chosen: GraphNode[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const take = (node: GraphNode) => {
    const title = fold(node.label);
    if (chosen.length >= max || seenIds.has(node.id) || (oneProjectPerTitle && seenTitles.has(title))) return;
    seenIds.add(node.id);
    seenTitles.add(title);
    chosen.push(node);
  };
  const shared = lists.length > 1 ? lists[0].filter((n) => lists.every((list) => list.some((m) => m.id === n.id))) : [];
  [...shared].sort(rank(keys)).forEach(take);
  const own = lists.map((list, i) => list.filter((n) => !seenIds.has(n.id)).sort(rank([keys[i]])));
  const rounds = Math.max(0, ...own.map((list) => list.length));
  for (let round = 0; round < rounds; round++) for (const list of own) if (list[round]) take(list[round]);
  return chosen;
}

export function planSources(graph: AtlasGraph, diseaseIds: string[]): SourcePlan {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const diseases = diseaseIds.map((id) => nodes.get(id)).filter((n): n is GraphNode => n?.type === "Disease");
  const papers = diseases.map((d) => linkedNodes(graph, nodes, d.id, "about", "Paper", /^PMID:\d+$/));
  const grants = diseases.map((d) => linkedNodes(graph, nodes, d.id, "funds", "Grant", /^NIH:\d+$/));
  return {
    diseases,
    papers: pickRecords(diseases, papers, MAX_PAPERS, false),
    grants: pickRecords(diseases, grants, MAX_GRANTS, true),
  };
}

// The patient groups RareVerse lists for the disease(s), for a family with no researcher to write to:
// such groups often know who works on the disease. Straight from graph.json, once each.
export function patientGroups(graph: AtlasGraph, diseaseIds: string[]): PatientGroup[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const groups = new Map<string, PatientGroup>();
  for (const id of diseaseIds) {
    for (const node of linkedNodes(graph, nodes, id, "works_on", "PatientOrg", /\S/)) {
      if (/^https:\/\//.test(node.url)) groups.set(node.id, { name: decodeEntities(node.label), url: node.url });
    }
  }
  return [...groups.values()];
}

interface Person {
  name: string;
  firstName: string;
  lastName: string;
  affiliation: string;
  emails: string[];
  orcid: string | null;
  source: CandidateSource;
  priority: number; // 0 senior author or grant lead, 1 corresponding author, 2 first author
}

function paperPeople(paper: Paper): Person[] {
  const { authors } = paper;
  // An email in the affiliation marks the corresponding author, but only when few authors give one:
  // some journals print every author's address.
  const emailCount = authors.filter((a) => a.emails.length > 0).length;
  const people: Person[] = [];
  const add = (index: number, role: string, priority: number) => {
    const a = authors[index];
    people.push({
      name: `${a.foreName} ${a.lastName}`.trim(),
      firstName: a.foreName,
      lastName: a.lastName,
      affiliation: a.affiliation,
      emails: a.emails,
      orcid: a.orcid,
      source: {
        kind: "paper",
        id: `PMID:${paper.pmid}`,
        ref: `PMID ${paper.pmid}`,
        role,
        title: paper.title,
        year: paper.year,
        url: paper.url,
        affiliation: displayAffiliation(a.affiliation),
      },
      priority,
    });
  };
  const last = authors.length - 1;
  if (last < 0) return people;
  if (last === 0) {
    add(0, "sole author", 0);
    return people;
  }
  add(last, "senior author", 0);
  add(0, "first author", 2);
  for (let i = 1; i < last; i++) if (authors[i].emails.length > 0 && emailCount <= 3) add(i, "corresponding author", 1);
  return people;
}

function grantPeople(grant: Grant): Person[] {
  const where = [grant.organization, grant.place].filter(Boolean).join(", ");
  return grant.investigators.map((pi) => ({
    name: pi.name,
    firstName: pi.firstName,
    lastName: pi.lastName,
    affiliation: where,
    emails: [],
    orcid: null,
    source: {
      kind: "grant" as const,
      id: `NIH:${grant.applId}`,
      ref: `NIH grant ${grant.applId}`,
      role: pi.contact || grant.investigators.length === 1 ? "principal investigator" : "co-principal investigator",
      title: grant.title,
      year: grant.fiscalYear,
      url: grant.url,
      affiliation: where,
    },
    priority: 0,
  }));
}

// Same person when the last names fold to the same words and the first names agree: equal first words,
// or one is an initial of the other ("Terry" and "T").
function samePerson(a: { firstName: string; lastName: string }, b: { firstName: string; lastName: string }): boolean {
  if (fold(a.lastName) !== fold(b.lastName)) return false;
  const fa = fold(a.firstName).split(" ")[0] ?? "";
  const fb = fold(b.firstName).split(" ")[0] ?? "";
  if (!fa || !fb || fa[0] !== fb[0]) return false;
  return fa === fb || fa.length === 1 || fb.length === 1;
}

// One candidate per person, in reading order, with every role they hold. When there are too many, first
// authors from the later papers go first, then corresponding authors; senior authors and grant leads stay.
export function buildCandidates(papers: Paper[], grants: Grant[]): Candidate[] {
  const people = [...papers.flatMap(paperPeople), ...grants.flatMap(grantPeople)];
  const merged: (Omit<Candidate, "id"> & { priority: number; order: number })[] = [];
  people.forEach((p, order) => {
    const hit = merged.find((m) => samePerson(m, p));
    if (hit) {
      hit.sources.push(p.source);
      for (const e of p.emails) if (!hit.emails.some((h) => h.toLowerCase() === e.toLowerCase())) hit.emails.push(e);
      hit.affiliation ||= p.affiliation;
      hit.orcid ??= p.orcid;
      hit.priority = Math.min(hit.priority, p.priority);
      return;
    }
    const { source, priority, ...person } = p;
    merged.push({ ...person, emails: [...p.emails], sources: [source], priority, order });
  });
  return merged
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .slice(0, MAX_CANDIDATES)
    .sort((a, b) => a.order - b.order)
    .map(({ priority, order, ...c }, i) => ({ id: `c${i + 1}`, ...c }));
}
