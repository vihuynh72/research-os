import test from "node:test";
import assert from "node:assert/strict";
import { cleanProse, decodeEntities, displayAffiliation, findEmails, fold, institutionOf, isEmail, titleCaseIfShouting, xmlText } from "./text.ts";

test("entities in PubMed XML and web pages become plain text", () => {
  assert.equal(decodeEntities("J&#xe9;r&#xf4;me &amp; M&eacute;ndez-Cobi&aacute;n &Ouml;zt&uuml;rk"), "Jérôme & Méndez-Cobián Öztürk");
  assert.equal(decodeEntities("name&#64;uni.edu &commat; &#0; &bogus;"), "name@uni.edu @ &#0; &bogus;");
  assert.equal(decodeEntities("Fran&ccedil;ois Dvo&rcaron;&aacute;k"), "François Dvořák", "letter + mark names compose");
  assert.equal(decodeEntities("&xacute; &qcedil2;"), "&xacute; &qcedil2;", "names that are not letter + mark stay as written");
});

test("XML text loses inline markup but keeps its words together", () => {
  assert.equal(xmlText("GeneReviews<sup>&#xae;</sup>"), "GeneReviews®");
  assert.equal(xmlText("Loss of <i>HEXA</i>\n   function"), "Loss of HEXA function");
});

test("names fold to plain lowercase words", () => {
  assert.equal(fold("Méndez-Cobián, Daniela Anahí"), "mendez cobian daniela anahi");
  assert.equal(fold("Gärtner Øyvind Straße"), "gartner oyvind strasse");
  assert.equal(fold("  Dr. Miguel  Sena-Esteves, PhD "), "dr miguel sena esteves phd");
});

test("emails are found once each, without a sentence's final period", () => {
  const affiliation = "UMass Chan Medical School, Worcester, MA, USA. Terry.Flotte@umassmed.edu. Electronic address: terry.flotte@umassmed.edu.";
  assert.deepEqual(findEmails(affiliation), ["Terry.Flotte@umassmed.edu"]);
  assert.deepEqual(findEmails("xupl@zju.edu.cn; cshen@zju.edu.cn and (marco.prinz@uniklinik-freiburg.de)"), [
    "xupl@zju.edu.cn",
    "cshen@zju.edu.cn",
    "marco.prinz@uniklinik-freiburg.de",
  ]);
  assert.deepEqual(findEmails("no address here, just @handles and a@b"), []);
  assert.ok(isEmail("leonardo.astudillo31@gmail.com"));
  assert.ok(!isEmail("a..b@uni.edu"));
  assert.ok(!isEmail("name@uni"));
  assert.ok(!isEmail("Terry.Flotte@umassmed.edu."));
});

test("model prose keeps its sentence but never carries contact details of its own", () => {
  assert.equal(
    cleanProse("Senior author (PMID 35145305, 2022); write to x.y@uni.edu or call +1 508-856-1234, see https://uni.edu/x.", 300),
    "Senior author (PMID 35145305, 2022); write to or call, see",
  );
  assert.equal(cleanProse("Led the 2013–2014 NIH grant.", 300), "Led the 2013–2014 NIH grant.");
  assert.equal(cleanProse("Phone 508 856 1234 for the clinic", 300), "Phone for the clinic");
  assert.equal(cleanProse(42, 300), "");
  const long = cleanProse("word ".repeat(100), 40);
  assert.ok(long.length <= 40 && long.endsWith("…"));
});

test("shouting registry names are title-cased; others stay as written", () => {
  assert.equal(titleCaseIfShouting("UNIVERSITY OF PENNSYLVANIA"), "University of Pennsylvania");
  assert.equal(titleCaseIfShouting("WINSTON-SALEM"), "Winston-Salem");
  assert.equal(titleCaseIfShouting("UMass Chan Medical School"), "UMass Chan Medical School");
});

test("an affiliation as a card shows it: no addresses, one line, no trailing period", () => {
  assert.equal(
    displayAffiliation("Department of Pediatrics, UMass Chan Medical School, Worcester, MA, USA. Electronic address: terry.flotte@umassmed.edu."),
    "Department of Pediatrics, UMass Chan Medical School, Worcester, MA, USA",
  );
  assert.equal(displayAffiliation("Unit A; and B.\n  terry.flotte@umassmed.edu; jane@x.org"), "Unit A; and B");
  assert.equal(displayAffiliation("x@y.edu"), "");
});

test("the institution in an affiliation: the broadest kind of place it names", () => {
  const cases: [string, string][] = [
    ["Horae Gene Therapy Center and The Li Weibo Institute for Rare Diseases Research, UMass Chan Medical School, Worcester, MA, USA", "UMass Chan Medical School"],
    ["Clinical Professor, Medicine (Genetics), University College, Dublin, Ireland", "University College"],
    ["CHU Estaing et Université Clermont Auvergne, Hematology (Biology) et EA 7453 CHELTER, F-63000 Clermont-Ferrand, France", "CHU Estaing et Université Clermont Auvergne"],
    ["Department of Internal Medicine, Geneva University Hospital, Rue Gabrielle-Perret-Gentil 4, CH-1211 Genève, Switzerland", "Geneva University Hospital"],
    ["Unidad de Investigación Epidemiológica y en Servicios de Salud, Instituto Mexicano del Seguro Social, Guadalajara 44340, Jalisco, Mexico", "Instituto Mexicano del Seguro Social"],
    ["National Human Genome Research Institute, Bethesda, Maryland", "National Human Genome Research Institute"],
    ["NYU Langone Orthopedics, NYU Langone Health, New York, New York", "NYU Langone Health"],
    ["Institute of Neuropathology, Faculty of Medicine, University of Freiburg, Freiburg, Germany", "University of Freiburg"],
    ["Division of Pediatric Genetics", ""],
  ];
  for (const [affiliation, institution] of cases) assert.equal(institutionOf(affiliation), institution, affiliation);
});
