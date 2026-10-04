import path from "node:path";
import type { Metadata } from "next";
import AtlasApp from "@/components/atlas/AtlasApp";
import { Wordmark } from "@/components/atlas/Brand";
import { decodeEntities } from "@/components/atlas/names";
import { parseState, type Query } from "@/components/atlas/urlState";
import { sentenceLabel } from "@/lib/graph/labels";
import { loadAtlasData, type DataNote } from "@/lib/data/source";

type SearchParams = Promise<Query>;

// "Tay-Sachs disease · RareVerse" once something is in the center; the plain name on the blank
// start screen. The app keeps the title in step on the client as the center changes.
export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const result = loadAtlasData();
  if (!result.ok) return {};
  const { focusId } = parseState(await searchParams);
  const node = focusId ? result.data.graph.nodes.find((n) => n.id === focusId) : undefined;
  return node ? { title: `${sentenceLabel(decodeEntities(node.label))} · RareVerse` } : {};
}

// RareVerse opens blank: nothing is in the center until the person searches or picks something.
// A shared or screenshotted link (?d=&sel=&mode=&r=&hide=&open=&list=) renders that exact state on
// the server, with no flash of another view.
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const initial = parseState(await searchParams);
  const result = loadAtlasData();
  if (!result.ok) {
    logOnce(`Data not built: ${missingDetail(result.dir, result.missing, result.error)} Run npm run data:graph && npm run grade, then reload.`);
    return <DataMissing />;
  }

  const { graph, relevance, sample, notes, aliases } = result.data;
  logNotes(notes);
  return <AtlasApp graph={graph} relevance={relevance} sample={sample} notes={notes} aliases={aliases} initial={initial} />;
}

// What a developer should do about the data goes to the server log, once per message, instead of
// onto the page that families read.
const logged = new Set<string>();
function logOnce(detail: string) {
  if (logged.has(detail)) return;
  logged.add(detail);
  console.info(`[RareVerse data] ${detail}`);
}

function logNotes(notes: DataNote[]) {
  for (const note of notes) logOnce(note.detail);
}

function missingDetail(dir: string, missing: string[], error?: string): string {
  const relative = path.relative(process.cwd(), dir);
  const where = !relative ? "." : relative.startsWith("..") || path.isAbsolute(relative) ? dir : relative;
  return [missing.length ? `missing in ${where}/: ${missing.join(", ")}.` : "", error ?? ""].filter(Boolean).join(" ");
}

function DataMissing() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <Wordmark />
      <div className="rounded-xl border border-line bg-surface p-5">
        <h1 className="font-semibold">The map isn’t ready yet</h1>
        <p className="mt-1 text-ink-2 text-pretty">RareVerse is still building its data. Please try again in a few minutes.</p>
      </div>
    </main>
  );
}
