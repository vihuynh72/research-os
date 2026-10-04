import path from "node:path";
import type { Metadata } from "next";
import AtlasApp from "@/components/atlas/AtlasApp";
import { nodeName } from "@/components/atlas/format";
import { parseState, type Query } from "@/components/atlas/urlState";
import { loadAtlasData, type DataNote } from "@/lib/data/source";

type SearchParams = Promise<Query>;

// "CLN3 · CVI Atlas" once something is in the center; the plain name on the blank start screen.
// The app keeps the title in step on the client as the center changes.
export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const result = loadAtlasData();
  if (!result.ok) return {};
  const { focusId } = parseState(await searchParams);
  const node = focusId ? result.data.graph.nodes.find((n) => n.id === focusId) : undefined;
  return node ? { title: `${nodeName(node, 32)} · CVI Atlas` } : {};
}

// The atlas opens blank: nothing is in the center until the person searches or picks something.
// A shared or screenshotted link (?d=&sel=&view=&mode=&r=&hide=&open=&list=) renders that exact
// state on the server, with no flash of another view.
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const initial = parseState(await searchParams);
  const result = loadAtlasData();
  if (!result.ok) return <DataMissing dir={result.dir} missing={result.missing} error={result.error} />;

  const { graph, relevance, sample, notes } = result.data;
  logNotes(notes);
  return <AtlasApp graph={graph} relevance={relevance} sample={sample} notes={notes} initial={initial} />;
}

// What a developer should do about the data goes to the server log, once per message, instead of
// onto the page that families read.
const logged = new Set<string>();
function logNotes(notes: DataNote[]) {
  for (const note of notes) {
    if (logged.has(note.detail)) continue;
    logged.add(note.detail);
    console.info(`[atlas data] ${note.detail}`);
  }
}

function DataMissing({ dir, missing, error }: { dir: string; missing: string[]; error?: string }) {
  const relative = path.relative(process.cwd(), dir);
  const where = !relative ? "." : relative.startsWith("..") || path.isAbsolute(relative) ? dir : relative;
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-5 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">CVI Atlas</h1>
      <div className="rounded-xl border border-line bg-surface p-5">
        <h2 className="font-semibold">Data not built yet</h2>
        <p className="mt-1 text-ink-2">
          Run <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[0.9em] text-ink">npm run data:graph &amp;&amp; npm run grade</code>, then reload.
        </p>
        {missing.length > 0 && (
          <p className="mt-3 text-sm text-ink-2">
            Missing in {where}/: {missing.join(", ")}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-ink">{error}</p>}
      </div>
    </main>
  );
}
