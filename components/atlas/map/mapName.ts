// A name as the map prints it (2D labels and 3D labels alike): wrapped whole over at most
// `maxLines` lines of about `perLine` characters. A name that needs more keeps its start and its
// last words and drops the middle ("Association of TriC/CCT / … during biosynthesis"), so siblings
// stay apart; the tooltip and the panel give it in full. Pure.
import { wrapName } from "../names.ts";

export function mapLines(name: string, perLine: number, maxLines: number): string[] {
  const whole = wrapName(name, perLine, Number.MAX_SAFE_INTEGER);
  if (whole.length <= maxLines) return whole;
  const words = name.trim().split(/\s+/);
  const tail: string[] = [];
  for (let i = words.length - 1; i > 0; i--) {
    if (`… ${[words[i], ...tail].join(" ")}`.length > perLine) break;
    tail.unshift(words[i]);
  }
  const last = tail.length ? `… ${tail.join(" ")}` : `…${words[words.length - 1].slice(-(perLine - 1))}`;
  return [...whole.slice(0, maxLines - 1), last];
}
