// NIH RePORTER records for the contact finder: who leads each linked grant, and where.
import type { Grant, GrantInvestigator } from "./types.ts";
import { titleCaseIfShouting } from "./text.ts";

const SEARCH = "https://api.reporter.nih.gov/v2/projects/search";
const FIELDS = [
  "ApplId",
  "ProjectTitle",
  "PrincipalInvestigators",
  "Organization",
  "FiscalYear",
  "ProjectStartDate",
  "ProjectEndDate",
  "ProjectDetailUrl",
];

export function reporterUrl(applId: string): string {
  return `https://reporter.nih.gov/project-details/${applId}`;
}

export function reporterQuery(applIds: string[]) {
  return { criteria: { appl_ids: applIds.map(Number) }, include_fields: FIELDS, offset: 0, limit: Math.max(1, applIds.length) };
}

export async function fetchGrants(applIds: string[], signal: AbortSignal): Promise<Grant[]> {
  if (applIds.length === 0) return [];
  const res = await fetch(SEARCH, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(reporterQuery(applIds)),
  });
  if (!res.ok) throw new Error(`NIH RePORTER answered ${res.status}`);
  return mapReporter(await res.json(), applIds);
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const yearOf = (v: unknown): number | null => {
  const match = /^(\d{4})/.exec(str(v));
  return match ? Number(match[1]) : null;
};

// Results come back in RePORTER's order; they are returned in the order asked for, unknown ids dropped.
export function mapReporter(json: unknown, applIds: string[]): Grant[] {
  const results = Array.isArray((json as Json | null)?.results) ? ((json as Json).results as Json[]) : [];
  const byId = new Map<string, Grant>();
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const applId = String(r.appl_id ?? "");
    if (!/^\d+$/.test(applId) || byId.has(applId)) continue;
    const org = (r.organization ?? {}) as Json;
    const start = yearOf(r.project_start_date);
    const end = yearOf(r.project_end_date);
    byId.set(applId, {
      applId,
      url: reporterUrl(applId),
      title: str(r.project_title),
      organization: titleCaseIfShouting(str(org.org_name)),
      place: [titleCaseIfShouting(str(org.org_city)), str(org.org_state), titleCaseIfShouting(str(org.org_country))].filter(Boolean).join(", "),
      fiscalYear: typeof r.fiscal_year === "number" ? r.fiscal_year : null,
      years: start && end && start !== end ? `${start}–${end}` : String(start ?? end ?? ""),
      investigators: readInvestigators(r.principal_investigators),
    });
  }
  return applIds.map((id) => byId.get(id)).filter((g): g is Grant => !!g);
}

function readInvestigators(list: unknown): GrantInvestigator[] {
  if (!Array.isArray(list)) return [];
  const people: GrantInvestigator[] = [];
  for (const p of list as Json[]) {
    const firstName = titleCaseIfShouting(str(p?.first_name));
    const lastName = titleCaseIfShouting(str(p?.last_name));
    if (!lastName || !firstName) continue;
    const middle = titleCaseIfShouting(str(p?.middle_name));
    people.push({ name: [firstName, middle, lastName].filter(Boolean).join(" "), firstName, lastName, contact: p?.is_contact_pi === true });
  }
  // The contact principal investigator first: the person NIH lists as the grant's point of contact.
  return people.sort((a, b) => Number(b.contact) - Number(a.contact));
}
