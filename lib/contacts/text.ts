// Text helpers for the contact finder: entities, tags, name folding, emails and free-text cleanup.
// Pure. Files under lib/ also run directly in Node's test runner, so imports are relative with .ts.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  commat: "@",
  period: ".",
  szlig: "ß",
  aelig: "æ",
  AElig: "Æ",
  oelig: "œ",
  OElig: "Œ",
  oslash: "ø",
  Oslash: "Ø",
  eth: "ð",
  ETH: "Ð",
  thorn: "þ",
  THORN: "Þ",
};

// Accented letters are named letter + mark ("eacute", "Ouml"), so they are composed instead of listed.
const MARKS: Record<string, string> = {
  acute: "́",
  grave: "̀",
  circ: "̂",
  tilde: "̃",
  uml: "̈",
  ring: "̊",
  cedil: "̧",
  caron: "̌",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (Object.hasOwn(NAMED, body)) return NAMED[body];
    // Only real letters compose to one character ("eacute" → é); "xacute" is not an entity and stays.
    const accented = /^([a-z])(acute|grave|circ|tilde|uml|ring|cedil|caron)$/i.exec(body);
    const letter = accented ? (accented[1] + MARKS[accented[2]]).normalize("NFC") : "";
    return letter.length === 1 ? letter : whole;
  });
}

// Text inside an XML element: inline markup (<i>, <sup>) removed, entities decoded, spaces collapsed.
export function xmlText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// Letters that do not decompose into a base letter plus an accent.
const SPECIAL_LETTERS: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i" };

// "Méndez-Cobián, J." → "mendez cobian j": accents and case folded, everything else a single space.
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/g, (c) => SPECIAL_LETTERS[c])
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// No dots at either end of the local part, labels that start and end with a letter or digit, and a
// letters-only top-level domain, so "…@umassmed.edu." at the end of a sentence keeps its period out.
const EMAIL_SOURCE = String.raw`[a-z0-9_%+-](?:[a-z0-9._%+-]*[a-z0-9_%+-])?@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}`;
const EMAIL = new RegExp(`(?<![a-z0-9._%+-])${EMAIL_SOURCE}(?![a-z0-9-])`, "gi");

export function isEmail(s: string): boolean {
  return new RegExp(`^${EMAIL_SOURCE}$`, "i").test(s) && !s.includes("..");
}

// Every email in a text, once each (compared without case), in order of appearance.
export function findEmails(text: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const match of text.matchAll(EMAIL)) {
    const email = match[0];
    if (email.includes("..") || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    found.push(email);
  }
  return found;
}

// A run of digits and separators reads as a phone number when it holds at least nine digits in short
// groups ("508-856-1234") or starts with "+". Years ("2013–2014") and PubMed ids ("35145305 (2022)") stay.
const PHONE_LIKE = /\+?\(?\d[\d\s().\-]{6,}\d/g;

function isPhoneLike(run: string): boolean {
  const digits = run.replace(/\D/g, "").length;
  const longestGroup = Math.max(...run.split(/\D+/).map((group) => group.length));
  return digits >= 9 && (longestGroup <= 5 || run.startsWith("+"));
}

// True when free text carries an email, a link or a phone number of its own.
export function hasContactDetails(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return new RegExp(EMAIL.source, "i").test(value) || /\bhttps?:\/\/|\bwww\./i.test(value) || [...value.matchAll(PHONE_LIKE)].some((m) => isPhoneLike(m[0]));
}

// Model-written prose for the cards: no emails, links or phone numbers can ride along in it (only checked
// fields carry those), one line, and at most `max` characters, cut at a word.
export function cleanProse(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let text = value
    .replace(EMAIL, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(PHONE_LIKE, (run) => (isPhoneLike(run) ? "" : run))
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
  return text;
}

// An affiliation as a card may show it: PubMed's "Electronic address: x@y.edu" and any other address
// taken out (emails reach the card only through the checked email field), one line, at most `max` characters.
export function displayAffiliation(value: string, max = 300): string {
  return cleanProse(value.replace(/\belectronic address:?/gi, " "), max).replace(/[\s.,;:]+$/, "");
}

// Kinds of place, broadest first, matched against folded segments of an affiliation.
const PLACE_KINDS = [
  /\b(?:universit\w*|universidad\w*|universidade|college|polytechnic)\b/,
  /\b(?:school|faculty|facultad|faculdade)\b/,
  /\b(?:hospital\w*|hopita\w*|ospedal\w*|klinik\w*|clinic|clinics|chu|medical cent(?:er|re)|medical city|health|nhs)\b/,
  /\b(?:institut\w*|istituto|national|academy|akademie|foundation|fondation|inserm|cnrs|nih)\b/,
  /\b(?:cent(?:er|re)|centro|centrum|laborator\w*)\b/,
];

// The university, hospital or institute an affiliation names, for a card's one-line "where":
// "Department of Pediatrics, UMass Chan Medical School, Worcester, MA, USA" → "UMass Chan Medical School".
// The segment naming the broadest kind of place wins; "" when no segment names one.
export function institutionOf(affiliation: string): string {
  const segments = affiliation
    .split(/[;,]\s*/)
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter((s) => s && s.length <= 90);
  for (const kind of PLACE_KINDS) {
    const hit = segments.find((s) => kind.test(fold(s)));
    if (hit) return hit;
  }
  return "";
}

// "UNIVERSITY OF PENNSYLVANIA" → "University of Pennsylvania". Mixed-case text is left as written.
const SMALL_WORDS = new Set(["of", "and", "the", "for", "at", "in", "on", "de", "du", "la", "le", "des", "y"]);
export function titleCaseIfShouting(s: string): string {
  if (s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
}
