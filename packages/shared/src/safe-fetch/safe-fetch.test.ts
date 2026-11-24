import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBlockedAddress } from "./ip-policy.js";
import { SafeFetchError, safeFetch, safeFetchWithPolicy } from "./safe-fetch.js";

type Handler = Parameters<typeof createServer>[1] & {};

interface Local {
  server: Server;
  port: number;
  url: (host: string, path?: string) => string;
  seen: { path: string; headers: IncomingHttpHeaders; localAddress: string | undefined }[];
}

const servers: Server[] = [];

async function listen(handler: Handler): Promise<Local> {
  const seen: Local["seen"] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers, localAddress: req.socket.localAddress });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, seen, url: (host, path = "/") => `http://${host}:${port}${path}` };
}

/** Resolver mapping fake hostnames to fixed addresses; counts calls per host. */
function mapResolver(map: Record<string, string[]>) {
  const calls: string[] = [];
  const resolver = async (host: string) => {
    calls.push(host);
    const ips = map[host];
    if (!ips) throw new Error(`unexpected lookup: ${host}`);
    return ips;
  };
  return { resolver, calls };
}

/** Real policy, except the local test server's loopback address is reachable. */
const allowLoopbackOnly = (ip: string) => ip !== "127.0.0.1" && isBlockedAddress(ip);

beforeEach(() => {
  servers.length = 0;
});

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })),
  );
});

describe("safeFetch: request validation", () => {
  it("refuses a host that resolves to the cloud metadata address", async () => {
    await expect(safeFetch("http://evil.test/", { resolver: async () => ["169.254.169.254"] })).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "blocked_address",
    });
  });

  it("refuses if ANY resolved address is blocked", async () => {
    await expect(
      safeFetch("http://mixed.test/", { resolver: async () => ["93.184.216.34", "10.0.0.5"] }),
    ).rejects.toMatchObject({ code: "blocked_address" });
    await expect(
      safeFetch("http://mixed.test/", { resolver: async () => ["::1", "93.184.216.34"] }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("refuses non-http(s) schemes and unparsable URLs", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toMatchObject({ code: "bad_scheme" });
    await expect(safeFetch("ftp://example.com/")).rejects.toMatchObject({ code: "bad_scheme" });
    await expect(safeFetch("gopher://example.com/")).rejects.toMatchObject({ code: "bad_scheme" });
    await expect(safeFetch("not a url")).rejects.toMatchObject({ code: "bad_scheme" });
  });

  it("refuses ports outside allowedPorts", async () => {
    const resolver = async () => ["93.184.216.34"];
    await expect(safeFetch("http://example.com:22/", { resolver })).rejects.toMatchObject({ code: "bad_port" });
    await expect(safeFetch("https://example.com:8443/", { resolver })).rejects.toMatchObject({ code: "bad_port" });
  });

  it("validates IP-literal hosts directly without DNS", async () => {
    const { resolver, calls } = mapResolver({});
    await expect(safeFetch("http://127.0.0.1/", { resolver })).rejects.toMatchObject({ code: "blocked_address" });
    await expect(safeFetch("http://[::1]/", { resolver })).rejects.toMatchObject({ code: "blocked_address" });
    await expect(safeFetch("http://[::ffff:169.254.169.254]/", { resolver })).rejects.toMatchObject({
      code: "blocked_address",
    });
    await expect(safeFetch("http://2130706433/", { resolver })).rejects.toMatchObject({ code: "blocked_address" });
    expect(calls).toEqual([]);
  });

  it("reports DNS failures and empty answers as dns_failed", async () => {
    const boom = new Error("ENOTFOUND");
    const err = await safeFetch("http://nope.test/", {
      resolver: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err).toMatchObject({ code: "dns_failed", cause: boom });
    await expect(safeFetch("http://empty.test/", { resolver: async () => [] })).rejects.toMatchObject({
      code: "dns_failed",
    });
  });
});

describe("safeFetch: fetching", () => {
  it("fetches from an allowed address and returns status, headers and body", async () => {
    const local = await listen((_req, res) => {
      res.setHeader("x-test", "yes");
      res.end("hello ✓");
    });
    const { resolver } = mapResolver({ "site.test": ["127.0.0.1"] });
    const res = await safeFetch(local.url("site.test", "/page?q=1"), {
      resolver,
      allowPrivate: true,
      allowedPorts: [local.port],
    });
    expect(res).toMatchObject({
      status: 200,
      finalUrl: local.url("site.test", "/page?q=1"),
      body: "hello ✓",
      truncated: false,
    });
    expect(res.headers["x-test"]).toBe("yes");
    expect(local.seen[0]?.headers.host).toBe(`site.test:${local.port}`);
  });

  it("allowPrivate still enforces the port rule", async () => {
    const local = await listen((_req, res) => res.end("x"));
    await expect(safeFetch(`http://127.0.0.1:${local.port}/`, { allowPrivate: true })).rejects.toMatchObject({
      code: "bad_port",
    });
  });

  it("supports HEAD", async () => {
    const local = await listen((req, res) => {
      res.setHeader("x-method", req.method ?? "");
      res.end(req.method === "HEAD" ? undefined : "body");
    });
    const res = await safeFetch(`http://127.0.0.1:${local.port}/`, {
      method: "HEAD",
      allowPrivate: true,
      allowedPorts: [local.port],
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-method"]).toBe("HEAD");
    expect(res.body).toBe("");
  });

  it("pins the connection to the first validated address (DNS rebinding)", async () => {
    const local = await listen((_req, res) => res.end("pinned"));
    // First answer is the validated one; any later lookup would "rebind" to an unroutable address.
    // rebind.test is not resolvable by real DNS, so reaching the server proves the socket used the pinned IP.
    let n = 0;
    const resolver = async () => (n++ === 0 ? ["127.0.0.1"] : ["192.0.2.1"]);
    const res = await safeFetch(local.url("rebind.test"), {
      resolver,
      allowPrivate: true,
      allowedPorts: [local.port],
      timeoutMs: 2000,
    });
    expect(res.body).toBe("pinned");
    expect(n).toBe(1);
    expect(local.seen[0]?.localAddress).toBe("127.0.0.1");
  });

  it("truncates bodies at maxBytes instead of throwing", async () => {
    const big = "a".repeat(2 * 1024 * 1024);
    const local = await listen((_req, res) => res.end(big));
    const opts = { allowPrivate: true, allowedPorts: [local.port] };
    const res = await safeFetch(`http://127.0.0.1:${local.port}/`, opts);
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(1_048_576);
    const small = await safeFetch(`http://127.0.0.1:${local.port}/`, { ...opts, maxBytes: 10 });
    expect(small).toMatchObject({ truncated: true, body: "aaaaaaaaaa" });
  });

  it("times out a slow server", async () => {
    const local = await listen(() => {
      /* never respond */
    });
    const started = Date.now();
    await expect(
      safeFetch(`http://127.0.0.1:${local.port}/`, { allowPrivate: true, allowedPorts: [local.port], timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out a slow resolver", async () => {
    const resolver = () => new Promise<string[]>(() => {});
    await expect(safeFetch("http://slow-dns.test/", { resolver, timeoutMs: 100 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("applies timeoutMs as a total budget across hops", async () => {
    const local = await listen((req, res) => {
      setTimeout(() => {
        if (req.url === "/1") res.writeHead(302, { location: "/2" }).end();
        else res.end("done");
      }, 150);
    });
    const opts = { allowPrivate: true, allowedPorts: [local.port] };
    // Each hop alone fits in 250ms; both together do not.
    await expect(safeFetch(`http://127.0.0.1:${local.port}/1`, { ...opts, timeoutMs: 250 })).rejects.toMatchObject({
      code: "timeout",
    });
    const ok = await safeFetch(`http://127.0.0.1:${local.port}/1`, { ...opts, timeoutMs: 2000 });
    expect(ok.body).toBe("done");
  });
});

describe("safeFetch: redirects", () => {
  it("follows relative redirects and reports the final URL", async () => {
    const local = await listen((req, res) => {
      if (req.url === "/a") res.writeHead(301, { location: "b?x=1" }).end();
      else if (req.url === "/b?x=1") res.writeHead(308, { location: "/c" }).end();
      else res.end(`at ${req.url}`);
    });
    const res = await safeFetch(`http://127.0.0.1:${local.port}/a`, { allowPrivate: true, allowedPorts: [local.port] });
    expect(res).toMatchObject({ status: 200, body: "at /c", finalUrl: `http://127.0.0.1:${local.port}/c` });
  });

  it("re-validates the address on every hop (public -> private redirect is blocked)", async () => {
    const local = await listen((_req, res) => res.writeHead(302, { location: "http://internal.test/" }).end());
    const { resolver, calls } = mapResolver({ "a.test": ["127.0.0.1"], "internal.test": ["10.0.0.5"] });
    await expect(
      safeFetchWithPolicy(local.url("a.test"), { resolver, allowedPorts: [80, local.port] }, allowLoopbackOnly),
    ).rejects.toMatchObject({ code: "blocked_address" });
    expect(calls).toEqual(["a.test", "internal.test"]);
    expect(local.seen).toHaveLength(1);
  });

  it("blocks redirects to IP-literal metadata addresses even with mapped forms", async () => {
    const local = await listen((_req, res) =>
      res.writeHead(307, { location: "http://[::ffff:169.254.169.254]/latest/meta-data/" }).end(),
    );
    await expect(
      safeFetchWithPolicy(`http://127.0.0.1:${local.port}/`, { allowedPorts: [80, local.port] }, allowLoopbackOnly),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("re-checks scheme and port on every hop", async () => {
    const local = await listen((req, res) => {
      if (req.url === "/file") res.writeHead(302, { location: "file:///etc/passwd" }).end();
      else res.writeHead(302, { location: "http://127.0.0.1:6379/" }).end();
    });
    const opts = { allowPrivate: true, allowedPorts: [local.port] };
    await expect(safeFetch(`http://127.0.0.1:${local.port}/file`, opts)).rejects.toMatchObject({ code: "bad_scheme" });
    await expect(safeFetch(`http://127.0.0.1:${local.port}/port`, opts)).rejects.toMatchObject({ code: "bad_port" });
  });

  it("allows maxRedirects hops and refuses one more", async () => {
    const local = await listen((req, res) => {
      const n = Number(req.url?.slice(1));
      if (n < 6) res.writeHead(302, { location: `/${n + 1}` }).end();
      else res.end("end");
    });
    const opts = { allowPrivate: true, allowedPorts: [local.port] };
    // /0 -> ... -> /6 is 6 redirects: one too many for the default of 5.
    await expect(safeFetch(`http://127.0.0.1:${local.port}/0`, opts)).rejects.toMatchObject({
      code: "too_many_redirects",
    });
    // /1 -> ... -> /6 is exactly 5 redirects.
    const ok = await safeFetch(`http://127.0.0.1:${local.port}/1`, opts);
    expect(ok.body).toBe("end");
    await expect(safeFetch(`http://127.0.0.1:${local.port}/5`, { ...opts, maxRedirects: 0 })).rejects.toMatchObject({
      code: "too_many_redirects",
    });
  });

  it("never sends cookies and strips authorization after the first hop", async () => {
    const local = await listen((req, res) => {
      if (req.url === "/start") res.writeHead(302, { location: `http://b.test:${local.port}/next` }).end();
      else res.end("ok");
    });
    const { resolver } = mapResolver({ "a.test": ["127.0.0.1"], "b.test": ["127.0.0.1"] });
    const res = await safeFetch(local.url("a.test", "/start"), {
      resolver,
      allowPrivate: true,
      allowedPorts: [local.port],
      headers: { Authorization: "Bearer secret", Cookie: "sid=1", "X-Keep": "1", Host: "evil.example" },
    });
    expect(res.body).toBe("ok");
    const [first, second] = local.seen;
    expect(first?.headers.authorization).toBe("Bearer secret");
    expect(first?.headers.cookie).toBeUndefined();
    expect(first?.headers.host).toBe(`a.test:${local.port}`);
    expect(first?.headers["x-keep"]).toBe("1");
    expect(second?.headers.authorization).toBeUndefined();
    expect(second?.headers.cookie).toBeUndefined();
    expect(second?.headers.host).toBe(`b.test:${local.port}`);
    expect(second?.headers["x-keep"]).toBe("1");
  });

  it("returns a redirect status without Location as the final response", async () => {
    const local = await listen((_req, res) => res.writeHead(302).end("no location"));
    const res = await safeFetch(`http://127.0.0.1:${local.port}/`, { allowPrivate: true, allowedPorts: [local.port] });
    expect(res).toMatchObject({ status: 302, body: "no location" });
  });
});
