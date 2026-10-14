import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({
  promises: { lookup: mocks.lookup },
  default: { promises: { lookup: mocks.lookup } },
}));

import { assertSafeHost, isPrivateAddress, isPrivateIPv4, isPrivateIPv6, SsrfBlockedError } from "./ssrf";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isPrivateIPv4", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range end"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["10.255.255.255", "RFC1918 10/8 end"],
    ["172.16.0.1", "RFC1918 172.16/12 start"],
    ["172.31.255.255", "RFC1918 172.16/12 end"],
    ["192.168.0.1", "RFC1918 192.168/16"],
    ["192.168.255.255", "RFC1918 192.168/16 end"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "CGNAT start"],
    ["100.127.255.255", "CGNAT end"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this network"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above it
    "192.167.1.1",
    "192.169.1.1",
    "169.253.1.1",
    "169.255.1.1",
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above it
    "11.0.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "223.255.255.255", // last address below multicast
  ])("allows public %s", (ip) => {
    expect(isPrivateIPv4(ip)).toBe(false);
  });

  it.each(["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.x", "-1.2.3.4", "localhost"])(
    "fails closed on malformed %j",
    (ip) => {
      expect(isPrivateIPv4(ip)).toBe(true);
    },
  );
});

describe("isPrivateIPv6", () => {
  it.each([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "ULA"],
    ["fd12:3456:789a::1", "ULA"],
    ["FD00::1", "ULA, upper case"],
    ["fe80::1", "link-local"],
    ["FE80::abcd", "link-local, upper case"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "v4-mapped loopback"],
    ["::ffff:10.0.0.1", "v4-mapped RFC1918"],
    ["::ffff:192.168.1.1", "v4-mapped RFC1918"],
    ["::ffff:169.254.169.254", "v4-mapped metadata"],
    ["::FFFF:127.0.0.1", "v4-mapped, upper case"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each([
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
  ])("allows public %s", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(false);
  });

  // `new URL("https://[::ffff:127.0.0.1]/").hostname` is "[::ffff:7f00:1]":
  // the WHATWG URL parser rewrites the dotted tail as hex, and that is the
  // form assertSafeHost receives from the CIMD fetch.
  it.each([
    ["::ffff:7f00:1", "127.0.0.1"],
    ["::ffff:a00:1", "10.0.0.1"],
    ["::ffff:c0a8:101", "192.168.1.1"],
    ["::ffff:a9fe:a9fe", "169.254.169.254"],
  ])("blocks the hex form of a v4-mapped private address %s (%s)", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each([
    ["0:0:0:0:0:0:0:1", "loopback, uncompressed"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback, zero padded"],
    ["0:0:0:0:0:0:0:0", "unspecified, uncompressed"],
    ["0:0:0:0:0:ffff:127.0.0.1", "v4-mapped loopback, uncompressed"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each([
    ["64:ff9b::7f00:1", "NAT64 of 127.0.0.1"],
    ["64:ff9b::169.254.169.254", "NAT64 of the metadata address"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["2002:a00:1::1", "6to4 of 10.0.0.1"],
    ["2002:c0a8:101::", "6to4 of 192.168.1.1"],
    ["::10.0.0.1", "v4-compatible RFC1918"],
    ["fec0::1", "site-local"],
    ["fe80::1%eth0", "link-local with a zone"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPrivateIPv6(ip)).toBe(true);
  });

  it.each(["64:ff9b::808:808", "2002:808:808::1", "::ffff:808:808", "2001:db8::ffff:7f00:1"])(
    "allows %s, whose embedded IPv4 address (if any) is public",
    (ip) => {
      expect(isPrivateIPv6(ip)).toBe(false);
    },
  );

  it.each(["", "1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "gggg::1", "12345::1"])(
    "fails closed on malformed %j",
    (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    },
  );
});

describe("isPrivateAddress", () => {
  it("dispatches on the address family", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateAddress("::ffff:10.1.2.3")).toBe(true);
    expect(isPrivateAddress("::ffff:1.1.1.1")).toBe(false);
  });

  it.each(["", "localhost", "example.com", "1.2.3", "999.1.1.1", "[::1]", "127.0.0.1:80", "0x7f.0.0.1", "2130706433"])(
    "fails closed on %j, which is not an IP address",
    (value) => {
      expect(isPrivateAddress(value)).toBe(true);
    },
  );
});

describe("assertSafeHost", () => {
  it.each(["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1"])(
    "refuses the private IPv4 literal %s without a lookup",
    async (host) => {
      await expect(assertSafeHost(host)).rejects.toThrow("Blocked: private or loopback address");
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );

  it.each(["[::1]", "::1", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::]"])(
    "refuses the private IPv6 literal %s, brackets or not",
    async (host) => {
      await expect(assertSafeHost(host)).rejects.toThrow("Blocked: private or loopback address");
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );

  it("refuses a v4-mapped private literal in the form URL.hostname gives it", async () => {
    const host = new URL("https://[::ffff:127.0.0.1]/client.json").hostname;
    expect(host).toBe("[::ffff:7f00:1]");
    await expect(assertSafeHost(host)).rejects.toThrow(/Blocked/);
    const metadata = new URL("https://[::ffff:169.254.169.254]/latest").hostname;
    await expect(assertSafeHost(metadata)).rejects.toThrow(/Blocked/);
  });

  it("accepts public IP literals without a lookup", async () => {
    await expect(assertSafeHost("8.8.8.8")).resolves.toBeUndefined();
    await expect(assertSafeHost("[2001:4860:4860::8888]")).resolves.toBeUndefined();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("accepts a host that resolves to public addresses only", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    await expect(assertSafeHost("example.com")).resolves.toBeUndefined();
    expect(mocks.lookup).toHaveBeenCalledWith("example.com", { all: true });
  });

  it.each([
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["172.20.0.1", 4],
    ["192.168.0.10", 4],
    ["169.254.169.254", 4],
    ["0.0.0.0", 4],
    ["::1", 6],
    ["fd00::1", 6],
    ["fe80::1", 6],
    ["::ffff:127.0.0.1", 6],
  ])("refuses a host resolving to %s", async (address, family) => {
    mocks.lookup.mockResolvedValue([{ address, family }]);
    await expect(assertSafeHost("internal.example")).rejects.toThrow("Blocked: resolves to a private or loopback address");
  });

  it("refuses when any one record is private, whatever its position", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(assertSafeHost("mixed.example")).rejects.toThrow("Blocked: resolves to a private or loopback address");
  });

  it("refuses a host with no records", async () => {
    mocks.lookup.mockResolvedValue([]);
    await expect(assertSafeHost("nothing.example")).rejects.toThrow("Blocked: DNS resolution failed");
  });

  it("marks a private address as a verdict, a failed resolution as a plain error", async () => {
    await expect(assertSafeHost("10.0.0.1")).rejects.toBeInstanceOf(SsrfBlockedError);
    mocks.lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(assertSafeHost("internal.example")).rejects.toBeInstanceOf(SsrfBlockedError);
    mocks.lookup.mockResolvedValue([]);
    await expect(assertSafeHost("nothing.example")).rejects.not.toBeInstanceOf(SsrfBlockedError);
  });

  it("refuses a record that is not an IP address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "not-an-ip", family: 4 }]);
    await expect(assertSafeHost("odd.example")).rejects.toThrow(/Blocked/);
  });

  it("lets a resolver failure through as a rejection", async () => {
    mocks.lookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND nope.example"));
    await expect(assertSafeHost("nope.example")).rejects.toThrow("ENOTFOUND");
  });

  it("resolves localhost like any name and refuses what it points at", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]);
    await expect(assertSafeHost("localhost")).rejects.toThrow(/Blocked/);
    expect(mocks.lookup).toHaveBeenCalledWith("localhost", { all: true });
  });
});
