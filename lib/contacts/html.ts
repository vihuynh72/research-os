// Reading a fetched profile or lab page: the text people see and the emails it prints. Pure.
import { decodeEntities, findEmails, isEmail } from "./text.ts";

export function htmlToText(html: string): string {
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(visible).replace(/\s+/g, " ").trim();
}

// Cloudflare's email protection prints addresses XOR-ed with the first byte as the key.
export function decodeCfEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){2,}$/i.test(hex)) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function decodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Emails a page shows its readers: in the text (also written "name [at] place [dot] edu"), in mailto links
// and behind Cloudflare's email protection. Once each, compared without case.
export function pageEmails(html: string): string[] {
  const decoded = decodeEntities(html);
  const found: string[] = [];
  for (const m of decoded.matchAll(/mailto:([^"'?\s<>]+)/gi)) found.push(decodeUri(m[1]));
  for (const m of decoded.matchAll(/(?:data-cfemail=["']?|email-protection#)([0-9a-f]+)/gi)) {
    const email = decodeCfEmail(m[1]);
    if (email) found.push(email);
  }
  const text = htmlToText(html)
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
  found.push(...findEmails(text));
  const seen = new Set<string>();
  return found.filter((email) => {
    const key = email.toLowerCase();
    if (!isEmail(email) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
