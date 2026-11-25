import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function capture(): { lines: () => string; stream: Writable } {
  let buf = "";
  return {
    lines: () => buf,
    stream: new Writable({
      write(chunk, _enc, cb) {
        buf += String(chunk);
        cb();
      },
    }),
  };
}

describe("logger redaction", () => {
  it("redacts authorization, cookie, credential, token and challenge fields", () => {
    const c = capture();
    const log = createLogger("info", c.stream);
    log.info(
      {
        req: { headers: { authorization: "Bearer sgat_SECRET", cookie: "sess=SECRET" } },
        credential: "sgat_SECRET",
        token: "SECRET",
        challenge: "SECRET",
        body: { credential: "SECRET", challenge: "SECRET", token: "SECRET" },
      },
      "hello",
    );
    const out = c.lines();
    expect(out).toContain("hello");
    expect(out).not.toContain("SECRET");
  });
});
