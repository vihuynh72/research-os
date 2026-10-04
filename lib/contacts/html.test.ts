import test from "node:test";
import assert from "node:assert/strict";
import { decodeCfEmail, htmlToText, pageEmails } from "./html.ts";

test("page text is what a reader sees: no scripts, styles or comments, entities decoded", () => {
  const html = `<html><head><title>Miguel Sena-Esteves | UMass</title><style>p{color:red}</style>
    <script>var name = "Someone Else";</script></head><body><!-- Old Name -->
    <h1>Miguel Sena&#8209;Esteves,&nbsp;PhD</h1><p>Professor&nbsp;of Neurology &amp; Gene Therapy</p></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /^Miguel Sena-Esteves \| UMass Miguel Sena‑Esteves, PhD Professor of Neurology & Gene Therapy$/);
  assert.ok(!text.includes("Someone Else") && !text.includes("Old Name") && !text.includes("color"));
});

test("emails a page shows: plain, mailto, written out, or behind Cloudflare's protection", () => {
  // "a@b.co" encoded with key 0x42, the way Cloudflare prints it.
  const key = 0x42;
  const hex = [key, ..."a@b.co"].map((c) => (typeof c === "number" ? c : c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
  assert.equal(decodeCfEmail(hex), "a@b.co");
  assert.equal(decodeCfEmail("zz"), null);
  const html = `<p>Contact: <a href="mailto:Miguel.Esteves@umassmed.edu?subject=Hi">email</a></p>
    <p>Lab manager: jane.doe [at] umassmed [dot] edu.</p>
    <p><a href="/cdn-cgi/l/email-protection#${hex}">[email&#160;protected]</a> <span data-cfemail="${hex}"></span></p>
    <p>Again: miguel.esteves@umassmed.edu and &#109;&#64;uni.edu</p>`;
  assert.deepEqual(pageEmails(html), ["Miguel.Esteves@umassmed.edu", "a@b.co", "jane.doe@umassmed.edu", "m@uni.edu"]);
});
