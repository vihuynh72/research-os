import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const run = promisify(execFile);

// Rebuilds the graph and grades with the same scripts used by CI. Local use only.
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "Refresh is available in local development only." }, { status: 403 });
  }
  try {
    const steps = ["data:graph", "grade"];
    const output: string[] = [];
    for (const step of steps) {
      const result = await run("npm", ["run", step], { cwd: process.cwd(), timeout: 120_000 });
      output.push(result.stdout.trim());
    }
    return NextResponse.json({ ok: true, output });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The pipeline failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
