import test from "node:test";
import assert from "node:assert/strict";
import { allowList, cleanUrl, hostOf, isAllowed, isDocument, isProfileHost, urlKey } from "./urls.ts";

test("links are cleaned of tracking, fragments and anything that is not plain http(s)", () => {
  assert.equal(cleanUrl("https://www.umassmed.edu/sena-esteves-lab/?utm_source=openai#team"), "https://www.umassmed.edu/sena-esteves-lab/");
  assert.equal(cleanUrl(" https://example.edu/p?id=7&utm_medium=x "), "https://example.edu/p?id=7");
  for (const bad of ["javascript:alert(1)", "mailto:a@b.edu", "ftp://example.edu/x", "https://user:pw@example.edu/", "not a url", "", null, 42]) {
    assert.equal(cleanUrl(bad), null, String(bad));
  }
});

test("two spellings of one page compare equal; different pages do not", () => {
  assert.equal(urlKey("https://www.umassmed.edu/sena-esteves-lab/?utm_source=openai"), urlKey("http://umassmed.edu/sena-esteves-lab"));
  assert.notEqual(urlKey("https://umassmed.edu/a"), urlKey("https://umassmed.edu/b"));
  assert.notEqual(urlKey("https://umassmed.edu/p?id=1"), urlKey("https://umassmed.edu/p?id=2"));
});

test("only links among the consulted pages pass the allow-list", () => {
  const allowed = allowList(["https://www.umassmed.edu/sena-esteves-lab/?utm_source=openai", "https://pubmed.ncbi.nlm.nih.gov/35145305/", "garbage"]);
  assert.equal(allowed.size, 2);
  assert.ok(isAllowed("https://umassmed.edu/sena-esteves-lab", allowed));
  assert.ok(!isAllowed("https://umassmed.edu/sena-esteves-lab/team", allowed), "a page under it is a different page");
  assert.ok(!isAllowed("https://umassmed.edu.evil.example/sena-esteves-lab", allowed));
});

test("social media, directories, search engines and our own records are never a profile", () => {
  for (const url of [
    "https://www.linkedin.com/in/someone",
    "https://uk.linkedin.com/in/someone",
    "https://www.researchgate.net/profile/X",
    "https://orcid.org/0000-0002-8255-0588",
    "https://www.google.com/search?q=x",
    "https://scholar.google.com/citations?user=x",
    "https://pubmed.ncbi.nlm.nih.gov/35145305/",
    "https://reporter.nih.gov/project-details/8593531",
    "https://x.com/someone",
  ]) {
    assert.ok(!isProfileHost(url), url);
  }
  for (const url of ["https://www.umassmed.edu/sena-esteves-lab/", "https://sites.google.com/view/a-lab", "https://www.nih.gov/about", "https://box.com/x"]) {
    assert.ok(isProfileHost(url), url);
  }
  assert.equal(hostOf("https://www.mgh.harvard.edu/x"), "mgh.harvard.edu");
  assert.equal(hostOf("nonsense"), "");
});

test("documents are files, not pages", () => {
  assert.ok(isDocument("https://www.chu-clermontferrand.fr/sites/default/files/media/2024-01/Profil%20de%20poste.pdf"));
  assert.ok(isDocument("https://uni.edu/cv/smith.DOCX?download=1"));
  assert.ok(!isDocument("https://uni.edu/people/smith"));
  assert.ok(!isDocument("https://uni.edu/pdf-guide/"));
});
