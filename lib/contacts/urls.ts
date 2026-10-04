// Links in the contact finder's answer. A link is only shown when it was among the pages the web search
// consulted or cited, or is a PubMed / NIH record we supplied; these helpers make that comparison exact.

// Tracking parameters that search engines and OpenAI's citations add ("?utm_source=openai").
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;

// An http(s) link without credentials, fragment or tracking parameters; null when it is anything else.
export function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url.toString();
}

// The form two links are compared in: no scheme, no "www.", no trailing slash.
export function urlKey(raw: unknown): string | null {
  const clean = cleanUrl(raw);
  if (!clean) return null;
  const url = new URL(clean);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`;
}

export function allowList(urls: Iterable<unknown>): Set<string> {
  const keys = new Set<string>();
  for (const url of urls) {
    const key = urlKey(url);
    if (key) keys.add(key);
  }
  return keys;
}

export function isAllowed(url: unknown, allowed: Set<string>): boolean {
  const key = urlKey(url);
  return key !== null && allowed.has(key);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Never a profile or lab page: social media, people-search and directory sites, search engines, and the
// records we already link to as the reason (PubMed, RePORTER). Each entry covers its subdomains.
const NOT_A_PROFILE = [
  "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "threads.net", "tiktok.com", "youtube.com",
  "bsky.app", "mastodon.social", "researchgate.net", "academia.edu", "orcid.org", "scholar.google.com", "bing.com",
  "duckduckgo.com", "wikipedia.org", "doximity.com", "healthgrades.com", "vitals.com", "webmd.com", "zoominfo.com",
  "rocketreach.co", "signalhire.com", "contactout.com", "lusha.com", "apollo.io", "whitepages.com", "spokeo.com",
  "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "reporter.nih.gov", "europepmc.org", "semanticscholar.org",
];
// Google search itself, but not the lab sites some groups keep on sites.google.com.
const NOT_A_PROFILE_EXACT = ["google.com"];

export function isProfileHost(url: string): boolean {
  const host = hostOf(url);
  if (!host || NOT_A_PROFILE_EXACT.includes(host)) return false;
  return !NOT_A_PROFILE.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

// A file rather than a page (a job posting PDF, a CV in Word): never shown as someone's profile or lab page.
export function isDocument(url: string): boolean {
  try {
    return /\.(pdf|docx?|pptx?|xlsx?|rtf|odt|zip)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
