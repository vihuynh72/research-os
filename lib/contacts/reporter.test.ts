import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapReporter, reporterQuery } from "./reporter.ts";

// A real NIH RePORTER answer (2026-10-03) for the Tay-Sachs grant, trimmed to the fields we ask for.
const json: unknown = JSON.parse(readFileSync(new URL("./fixtures/reporter.json", import.meta.url), "utf8"));

test("a RePORTER project becomes a grant with its leader, organization and years", () => {
  const [grant] = mapReporter(json, ["8593531"]);
  assert.deepEqual(grant, {
    applId: "8593531",
    url: "https://reporter.nih.gov/project-details/8593531",
    title: "Endoplasmic reticulum quality control of mutant HexA enzyme in Tay-Sachs disease",
    organization: "University of Pennsylvania",
    place: "Philadelphia, PA, United States",
    fiscalYear: 2013,
    years: "2013–2014",
    investigators: [{ name: "Devin Dersh", firstName: "Devin", lastName: "Dersh", contact: true }],
  });
});

test("grants come back in the order asked for; unknown or malformed answers give nothing", () => {
  assert.deepEqual(
    mapReporter(json, ["1", "8593531"]).map((g) => g.applId),
    ["8593531"],
  );
  assert.deepEqual(mapReporter({ results: "nope" }, ["8593531"]), []);
  assert.deepEqual(mapReporter(null, ["8593531"]), []);
});

test("the contact principal investigator comes first on a multi-PI grant", () => {
  const multi = {
    results: [
      {
        appl_id: 5,
        project_title: "X",
        principal_investigators: [
          { first_name: "ANN", last_name: "LEE", middle_name: "", is_contact_pi: false },
          { first_name: "Bo", last_name: "Chen", middle_name: "J", is_contact_pi: true },
        ],
      },
    ],
  };
  const [grant] = mapReporter(multi, ["5"]);
  assert.deepEqual(
    grant.investigators.map((p) => [p.name, p.contact]),
    [
      ["Bo J Chen", true],
      ["Ann Lee", false],
    ],
  );
  assert.equal(grant.years, "");
});

test("the RePORTER query asks for exactly these projects", () => {
  const query = reporterQuery(["8593531", "8699525"]);
  assert.deepEqual(query.criteria, { appl_ids: [8593531, 8699525] });
  assert.equal(query.limit, 2);
  assert.ok(query.include_fields.includes("PrincipalInvestigators"));
});
