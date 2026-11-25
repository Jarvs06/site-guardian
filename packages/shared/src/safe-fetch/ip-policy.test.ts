import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "./ip-policy.js";

describe("isBlockedAddress", () => {
  it("blocks the brief's private/special addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "2606:2800:220:1::1", "8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks other reserved IPv4 ranges", () => {
    for (const ip of [
      "0.1.2.3", // this network
      "127.255.255.254",
      "172.31.255.255",
      "100.127.255.255", // CGNAT upper edge
      "192.0.0.8", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "198.51.100.7", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
      "198.18.0.1", // benchmarking
      "192.88.99.1", // 6to4 relay anycast
      "239.255.255.250", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("does not over-block neighbours of private ranges", () => {
    for (const ip of ["172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "11.0.0.1", "192.169.0.1", "223.255.255.255"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("blocks other special IPv6 ranges", () => {
    for (const ip of [
      "::", // unspecified
      "::127.0.0.1", // IPv4-compatible (deprecated)
      "::0.0.0.1",
      "fd12:3456::1", // ULA
      "fe80::1%en0", // link-local with zone
      "fec0::1", // site-local (deprecated)
      "ff02::1", // multicast
      "2001:db8::1", // documentation
      "3fff::1", // documentation (RFC 9637)
      "100::1", // discard-only
      "2001::1", // Teredo / IETF protocol assignments
      "64:ff9b:1::1", // local-use NAT64
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("checks IPv4 embedded in mapped, NAT64 and 6to4 addresses", () => {
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true); // hex form of 169.254.169.254
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true); // NAT64 of 127.0.0.1
    expect(isBlockedAddress("64:ff9b::169.254.169.254")).toBe(true);
    expect(isBlockedAddress("64:ff9b::5db8:d822")).toBe(false); // NAT64 of 93.184.216.34
    expect(isBlockedAddress("2002:7f00:1::1")).toBe(true); // 6to4 of 127.0.0.1
    expect(isBlockedAddress("2002:a00:1::")).toBe(true); // 6to4 of 10.0.0.1
    expect(isBlockedAddress("2002:5db8:d822::1")).toBe(false); // 6to4 of 93.184.216.34
  });

  it("fails closed on anything that is not an IP address", () => {
    for (const ip of ["", "example.com", "localhost", "1.2.3", "999.1.1.1", "[::1]", "0x7f.0.0.1", "::ffff:zzzz"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
});
