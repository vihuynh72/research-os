// The server opens pages the model names, so it must never be steered into the local network. Pure
// checks for hosts and addresses first; the DNS check is separate and runs again at connect time.
import { promises as dns, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

export function parseIpv4(ip: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

// Eight 16-bit groups, or null. Accepts "::" shorthand, an embedded IPv4 tail and a zone ("%en0").
export function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  let tail: number[] = [];
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const b = parseIpv4(v4[1]);
    if (!b) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = s.slice(0, -v4[1].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const known = head.length + rest.length + tail.length;
  const fill = halves.length === 2 ? 8 - known : 0;
  if (fill < 0 || (halves.length === 1 && known !== 8)) return null;
  return [...head.map((g) => parseInt(g, 16)), ...Array<number>(fill).fill(0), ...rest.map((g) => parseInt(g, 16)), ...tail];
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && (b & 0xc0) === 64) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && (b & 0xf0) === 16) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b & 0xfe) === 18) return false; // benchmarking
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false; // documentation
  return true;
}

const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function isPublicIpv6(g: number[]): boolean {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(5) && g[5] === 0xffff) return isPublicIpv4(v4Of(g[6], g[7])); // IPv4-mapped
  if (zeroUpTo(6)) return false; // unspecified, loopback, IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((x) => x === 0) && isPublicIpv4(v4Of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPublicIpv4(v4Of(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && (g[1] < 0x200 || g[1] === 0xdb8)) return false; // Teredo and protocol assignments, documentation
  return (g[0] & 0xe000) === 0x2000; // global unicast only (rules out ULA fc00::/7, link-local fe80::/10, multicast ff00::/8)
}

export function isPublicIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPublicIpv4(v4);
  const v6 = parseIpv6(ip);
  return v6 !== null && isPublicIpv6(v6);
}

const LOCAL_SUFFIXES = ["localhost", "local", "internal", "localdomain", "home.arpa", "lan", "intranet", "corp"];

// A public DNS name: no IP literals (URL parsing already turns "2130706433" or "0x7f.1" into one), no
// single-label names, nothing under local-only suffixes.
export function hostnameAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || host.startsWith("[") || parseIpv4(host)) return false;
  if (!host.includes(".") || /^[0-9.]+$/.test(host)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

// Every address the name resolves to must be public; one private answer blocks the host.
export async function publicAddresses(hostname: string, resolve: Resolver = systemResolver): Promise<LookupAddress[]> {
  if (!hostnameAllowed(hostname)) throw new Error("This host is not a public web address.");
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || addresses.some((a) => !isPublicIp(a.address))) throw new Error("This host resolves to a private address.");
  return addresses;
}

// For node:https: the check runs inside the connection's own DNS lookup, so the address that is checked
// is the address that is used, and a DNS answer that changes between check and connect cannot slip by.
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  publicAddresses(hostname).then(
    (addresses) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    },
    (error: Error) => callback(error, "", 0),
  );
};
