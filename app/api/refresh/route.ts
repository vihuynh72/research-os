import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const run = promisify(execFile);

// Rebuilds the seed weights and the two JSON files the page loads. Local use only.
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "Refresh is available in local development only." }, { status: 403 });
  }
  try {
    const steps = ["pipeline/weight_graph.py", "pipeline/export_atlas.py"];
    const output: string[] = [];
    for (const step of steps) {
      const result = await run("python3", [step], { cwd: process.cwd(), timeout: 120_000 });
      output.push(result.stdout.trim());
    }
    return NextResponse.json({ ok: true, output });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The pipeline failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
