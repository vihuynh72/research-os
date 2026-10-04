import test from "node:test";
import assert from "node:assert/strict";
import { emailNamesPerson, linkNamesPerson, nameMatches, nameOnPage } from "./names.ts";
import { fold } from "./text.ts";

const sena = { firstName: "Miguel", lastName: "Sena-Esteves" };
const mendez = { firstName: "Daniela Anahí", lastName: "Méndez-Cobián" };
const flotte = { firstName: "Terence R", lastName: "Flotte" };
const xu = { firstName: "Pinglong", lastName: "Xu" };

test("the model's spelling matches when the whole last name and the first initial agree", () => {
  for (const given of ["Miguel Sena-Esteves", "Sena-Esteves, Miguel", "M. Sena-Esteves", "Dr. Miguel Sena Esteves, PhD", "MIGUEL SENA-ESTEVES"]) {
    assert.ok(nameMatches(given, sena), given);
  }
  assert.ok(nameMatches("Daniela Mendez-Cobian", mendez), "accents folded");
  assert.ok(nameMatches("Terry Flotte", flotte), "a familiar first name keeps its initial");
  assert.ok(nameMatches("Prof. T. R. Flotte", flotte));
});

test("a different person, or a name too thin to tell, does not match", () => {
  assert.ok(!nameMatches("Miguel Esteves", sena), "part of the last name");
  assert.ok(!nameMatches("Pedro Sena-Esteves", sena), "another first initial");
  assert.ok(!nameMatches("Sena-Esteves", sena), "no first name at all");
  assert.ok(!nameMatches("Dr. Sena-Esteves", sena), "a title is not a first name");
  assert.ok(!nameMatches("Terence Flotter", flotte));
  assert.ok(!nameMatches("", flotte));
});

test("a page names the person when the last name appears as whole words", () => {
  assert.ok(nameOnPage(fold("Miguel Sena-Esteves, PhD — Professor of Neurology"), sena));
  assert.ok(nameOnPage(fold("Daniela Méndez Cobián, investigadora"), mendez));
  assert.ok(!nameOnPage(fold("The Sena lab studies gene therapy"), sena));
  assert.ok(!nameOnPage(fold("Flotterbach Hall"), flotte));
});

test("short last names need the first name beside them", () => {
  assert.ok(nameOnPage(fold("Pinglong Xu, PhD, Principal Investigator"), xu));
  assert.ok(nameOnPage(fold("XU Pinglong — Life Sciences Institute"), xu));
  assert.ok(!nameOnPage(fold("Prof. Xu leads the lab; Wei Xu manages it"), xu));
});

test("an email carries the person's name as a whole word, with an initial, or with the first name", () => {
  const yes: [string, { firstName: string; lastName: string }][] = [
    ["Albert.Rizvanov@kpfu.ru", { firstName: "Albert A", lastName: "Rizvanov" }],
    ["Miguel.Esteves@umassmed.edu", sena], // one word of a compound name
    ["mberger@chu-clermontferrand.fr", { firstName: "Marc G", lastName: "Berger" }],
    ["toroc@mail.nih.gov", { firstName: "Camilo", lastName: "Toro" }],
    ["levade.t@chu-toulouse.fr", { firstName: "Thierry", lastName: "Levade" }],
    ["thierry.billette@aphp.fr", { firstName: "Thierry", lastName: "Billette de Villemeur" }],
    ["pinglong.xu@zju.edu.cn", xu],
    ["shenlu@csu.edu.cn", { firstName: "Lu", lastName: "Shen" }],
    ["jsmith2@uni.edu", { firstName: "Jane", lastName: "Smith" }],
  ];
  for (const [email, person] of yes) assert.ok(emailNamesPerson(email, person), email);
  const no: [string, { firstName: string; lastName: string }][] = [
    ["xupl@zju.edu.cn", xu], // a short last name needs the first name too
    ["inter@kpfu.ru", { firstName: "Albert A", lastName: "Rizvanov" }],
    ["abergeron@chu.fr", { firstName: "Marc G", lastName: "Berger" }], // a longer name that contains his
    ["avis.metabolique@chu-clermontferrand.fr", { firstName: "Marc G", lastName: "Berger" }],
    ["valerio.carelli@unibo.it", { firstName: "Enrico", lastName: "Bertini" }], // his co-author's
    ["drliu@fas.harvard.edu", { firstName: "David R", lastName: "Liu" }], // too thin to tell from the address alone
  ];
  for (const [email, person] of no) assert.ok(!emailNamesPerson(email, person), email);
});

test("a link names the person when its path carries their last name", () => {
  assert.ok(linkNamesPerson("https://www.umassmed.edu/cancer-center/research/research-faculty-staff/sena-esteves-miguel/", sena));
  assert.ok(linkNamesPerson("https://www.umassmed.edu/sena-esteveslab/lab-members/principal-investigator/", sena), "a long name run into another word");
  assert.ok(linkNamesPerson("https://www.umassmed.edu/chancellor/senior-leadership/organization-chart/terence-r-flotte-md/", flotte));
  assert.ok(linkNamesPerson("https://www.unige.ch/medecine/dr-j%C3%A9r%C3%B4me-stirnemann", { firstName: "Jérôme", lastName: "Stirnemann" }), "percent-encoded accents");
  assert.ok(linkNamesPerson("https://example.edu/people/pinglong-xu", xu));
  assert.ok(!linkNamesPerson("https://example.edu/people/xu-lab", xu), "a short name alone could be anyone's");
  assert.ok(!linkNamesPerson("https://kpfu.ru/main?p_id=22336&p_lang=2&p_type=2", { firstName: "Albert A", lastName: "Rizvanov" }));
  assert.ok(!linkNamesPerson("https://med.stanford.edu/profiles/jane-doe", { firstName: "Leland", lastName: "Stanford" }), "the host is not the person");
  assert.ok(!linkNamesPerson("https://www.umassmed.edu/neurology/", flotte));
  assert.ok(!linkNamesPerson("not a link", flotte));
});
