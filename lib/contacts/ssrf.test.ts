import test from "node:test";
import assert from "node:assert/strict";
import { hostnameAllowed, isPublicIp, parseIpv6, publicAddresses } from "./ssrf.ts";

test("private, loopback, link-local and reserved IPv4 ranges are not public", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
    assert.ok(!isPublicIp(ip), ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "128.103.1.1"]) assert.ok(isPublicIp(ip), ip);
  assert.ok(!isPublicIp("256.1.1.1") && !isPublicIp("1.2.3") && !isPublicIp("example.org"));
});

test("IPv6: only global unicast is public, and embedded IPv4 is judged as IPv4", () => {
  for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1%en0", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::a00:1", "2002:c0a8:0101::1", "[::1]"]) {
    assert.ok(!isPublicIp(ip), ip);
  }
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80e::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"]) assert.ok(isPublicIp(ip), ip);
  assert.deepEqual(parseIpv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.equal(parseIpv6("1::2::3"), null);
  assert.equal(parseIpv6("12345::"), null);
  assert.equal(parseIpv6("1:2:3:4:5:6:7"), null);
});

test("host names: public DNS names only", () => {
  for (const host of ["localhost", "api.localhost", "printer.local", "db.internal", "router.home.arpa", "intranet", "127.0.0.1", "[::1]", "::1", "10.0.0.1", "", "123.456"]) {
    assert.ok(!hostnameAllowed(host), host);
  }
  for (const host of ["www.umassmed.edu", "profiles.ucsf.edu", "example.co.uk.", "uniklinik-freiburg.de"]) assert.ok(hostnameAllowed(host), host);
});

test("a name is used only when every address it resolves to is public", async () => {
  const resolver = (answers: string[]) => async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  assert.deepEqual(await publicAddresses("lab.example.edu", resolver(["93.184.216.34"])), [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(publicAddresses("lab.example.edu", resolver(["93.184.216.34", "10.0.0.5"])), /private/);
  await assert.rejects(publicAddresses("rebind.example.edu", resolver(["::ffff:127.0.0.1"])), /private/);
  await assert.rejects(publicAddresses("empty.example.edu", resolver([])), /private/);
  await assert.rejects(publicAddresses("localhost", resolver(["93.184.216.34"])), /not a public/);
});
