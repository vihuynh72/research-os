// Validates schema.json, its embedded examples, and the graph files passed as arguments (default:
// public/graph.json, which must exist: it is the atlas). JSON Schema cannot check cross-references,
// so unique ids and edge endpoints are checked here too.
import { existsSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const schema = readJson("schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function integrityErrors(doc) {
  const errors = [];
  const nodeIds = new Set();
  for (const node of doc.nodes) {
    if (nodeIds.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
    for (const end of [edge.subject, edge.object]) {
      if (!nodeIds.has(end)) errors.push(`edge ${edge.id} points to missing node ${end}`);
    }
  }
  if (doc.clusters) {
    const clusterIds = new Set(doc.clusters.map((c) => c.id));
    for (const node of doc.nodes) {
      if (node.cluster && !clusterIds.has(node.cluster)) errors.push(`node ${node.id} has unknown cluster ${node.cluster}`);
    }
  }
  return errors;
}

const targets = (schema.examples ?? []).map((doc, i) => [`schema.json examples[${i}]`, doc]);
const files = process.argv.length > 2 ? process.argv.slice(2) : ["public/graph.json"];
for (const file of files) targets.push([file, existsSync(file) ? readJson(file) : null]);

let failed = false;
for (const [name, doc] of targets) {
  let errors;
  if (doc === null) errors = ["file not found (npm run data:graph writes public/graph.json)"];
  else if (!validate(doc)) errors = validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
  else errors = integrityErrors(doc);

  if (errors.length) {
    failed = true;
    console.error(`FAIL ${name}`);
    for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
    if (errors.length > 50) console.error(`  ... ${errors.length - 50} more`);
  } else {
    console.log(`ok   ${name} (${doc.nodes.length} nodes, ${doc.edges.length} edges)`);
  }
}

process.exit(failed ? 1 : 0);
