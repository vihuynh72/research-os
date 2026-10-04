// Is this the same person? Name checks for the contact finder, with accents and case folded.
import { fold } from "./text.ts";

export interface PersonName {
  firstName: string;
  lastName: string;
}

// Titles and degrees that may surround a name ("Dr. Miguel Sena-Esteves, PhD").
const TITLES = new Set([
  "dr", "prof", "professor", "mr", "mrs", "ms", "md", "phd", "ph", "d", "mph", "msc", "bsc", "mbbs", "frcp", "frcpc",
  "facmg", "facp", "faap", "dphil", "jr", "sr", "ii", "iii", "iv",
]);

function indexOfRun(tokens: string[], run: string[]): number {
  for (let i = 0; i + run.length <= tokens.length; i++) {
    if (run.every((word, j) => tokens[i + j] === word)) return i;
  }
  return -1;
}

// The model's spelling of a name matches a candidate when the whole last name appears and the first
// remaining word starts with the candidate's first initial. "Sena-Esteves, Miguel", "M. Sena-Esteves" and
// "Miguel Sena Esteves" all match Miguel Sena-Esteves; "Miguel Esteves" and "Pedro Sena-Esteves" do not.
// The candidate id is the identity; this only catches an id paired with someone else's name.
export function nameMatches(given: string, person: PersonName): boolean {
  const last = fold(person.lastName).split(" ").filter(Boolean);
  const initial = fold(person.firstName).charAt(0);
  if (last.length === 0 || !initial) return false;
  const tokens = fold(given).split(" ").filter(Boolean);
  const at = indexOfRun(tokens, last);
  if (at < 0) return false;
  const rest = [...tokens.slice(0, at), ...tokens.slice(at + last.length)].filter((t) => !TITLES.has(t) || t === initial);
  return rest.length > 0 && rest[0].charAt(0) === initial;
}

// Does a page name this person? The last name must appear as whole words in the folded page text. Short
// last names (Li, Xu, Wu) are shared by many people, so they need the first name right beside them.
export function nameOnPage(foldedText: string, person: PersonName): boolean {
  const last = fold(person.lastName);
  if (!last) return false;
  const padded = ` ${foldedText} `;
  if (last.replace(/ /g, "").length > 3) return padded.includes(` ${last} `);
  const first = fold(person.firstName).split(" ")[0];
  if (!first) return false;
  return padded.includes(` ${first} ${last} `) || padded.includes(` ${last} ${first} `);
}

// Does an email address belong to this person by its name? One word of its local part must be a word of
// their last name with at least four letters ("Miguel.Esteves@" for Sena-Esteves), such a word with their
// first initial ("mberger@", "toroc@"), or their first and last names together ("pinglong.xu@", "shenlu@").
// Whole words only, so "abergeron@" is not Berger's; a department's "info@" never qualifies.
export function emailNamesPerson(email: string, person: PersonName): boolean {
  const words = fold(email.split("@")[0].replace(/\d+/g, " ")).split(" ").filter(Boolean);
  const lastWords = fold(person.lastName).split(" ").filter(Boolean);
  const first = fold(person.firstName).split(" ")[0] ?? "";
  if (lastWords.length === 0 || !first) return false;
  const last = lastWords.join("");
  const initial = first.charAt(0);
  const long = [...new Set([...lastWords, last])].filter((w) => w.length >= 4);
  return words.some((word, i) => {
    if (word === first + last || word === last + first) return true;
    if (long.some((w) => word === w || word === initial + w || word === w + initial)) return true;
    const next = words[i + 1];
    return (word === first && next === last) || (word === last && next === first);
  });
}

function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Whose page is a link that could not be opened? Only its address can say: the person's last name in the
// path, as words ("…/sena-esteves-miguel/") or, for a name of six letters or more, run into another word
// ("…/sena-esteveslab/"). The host is left out (a Dr. Stanford is not every stanford.edu page), and an
// address like "…/main?p_id=22336" says nothing.
export function linkNamesPerson(url: string, person: PersonName): boolean {
  let address: string;
  try {
    const u = new URL(url);
    address = fold(decodePath(`${u.pathname} ${u.search}`));
  } catch {
    return false;
  }
  if (nameOnPage(address, person)) return true;
  const last = fold(person.lastName).replace(/ /g, "");
  return last.length >= 6 && address.replace(/ /g, "").includes(last);
}
