// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from "vitest";
import { httpIriOrUndefined, isHttpIri, sanitizeText, tryRead } from "./guards.js";

describe("isHttpIri — canonical-consistent boolean guard", () => {
  it("accepts absolute http(s) URLs that are ALREADY canonical", () => {
    expect(isHttpIri("https://example.org/a")).toBe(true);
    expect(isHttpIri("http://example.org/")).toBe(true);
    expect(isHttpIri("https://example.org/p?q=1#f")).toBe(true);
  });

  it("rejects non-http(s) schemes, relative refs, and empties", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "mailto:a@b.c",
      "urn:uuid:1",
      "/relative/path",
      "not a url",
      "",
      undefined,
    ]) {
      expect(isHttpIri(bad)).toBe(false);
    }
  });

  it("rejects NON-canonical http(s) strings (the guard agrees with httpIriOrUndefined)", () => {
    for (const noncanonical of [
      "http://example.org",
      "  https://example.org/a  ",
      "https://x.org\n",
    ]) {
      expect(isHttpIri(noncanonical)).toBe(false);
      expect(httpIriOrUndefined(noncanonical)).toBeDefined();
    }
  });

  it("isHttpIri(v) === (httpIriOrUndefined(v) === v) — the lock-step invariant", () => {
    for (const v of [
      "https://example.org/a",
      "http://example.org",
      "  https://x.org ",
      "javascript:1",
      "",
    ]) {
      expect(isHttpIri(v)).toBe(httpIriOrUndefined(v) === v);
    }
  });
});

describe("httpIriOrUndefined — returns the CANONICAL href (whitespace/control hardening)", () => {
  it("returns the value for a clean http(s) URL", () => {
    expect(httpIriOrUndefined("https://example.org/a")).toBe("https://example.org/a");
  });

  it("NORMALIZES whitespace/control noise WHATWG URL tolerates, never writing it through", () => {
    expect(httpIriOrUndefined("  https://example.org/a  ")).toBe("https://example.org/a");
    expect(httpIriOrUndefined("https://example.org/a\n")).toBe("https://example.org/a");
    expect(httpIriOrUndefined("\thttps://example.org")).toBe("https://example.org/");
    for (const v of ["  https://x.org ", "https://x.org\t", "\nhttps://x.org\n"]) {
      const out = httpIriOrUndefined(v);
      expect(out).toBeDefined();
      expect(out).not.toMatch(/\s/);
    }
  });

  it("returns undefined for non-http(s) / invalid input", () => {
    for (const bad of ["javascript:alert(1)", "urn:uuid:1", "nope", "", undefined]) {
      expect(httpIriOrUndefined(bad)).toBeUndefined();
    }
  });
});

describe("sanitizeText — strips C0/C1 controls, preserves tab/newline/cr", () => {
  it("leaves clean text (incl. markdown newlines) byte-for-byte unchanged", () => {
    expect(sanitizeText("# Markdown\n\nlong body")).toBe("# Markdown\n\nlong body");
    expect(sanitizeText("plain")).toBe("plain");
    expect(sanitizeText("a\tb\r\nc")).toBe("a\tb\r\nc");
  });

  it("removes C0 (except tab/newline/cr) and C1 control characters", () => {
    expect(sanitizeText("a\u0000b\u0001c")).toBe("abc");
    expect(sanitizeText("x\u0007y")).toBe("xy");
    expect(sanitizeText("p\u007fq\u009fr")).toBe("pqr");
    // A NUL-injection attempt in a title cannot land a raw control byte.
    expect(sanitizeText("Trap\u0000</script>")).toBe("Trap</script>");
  });
});

describe("tryRead — fail-closed read", () => {
  it("returns the value on success", () => {
    expect(tryRead(() => 42)).toBe(42);
  });
  it("returns undefined when the read throws (a malformed literal drops the field)", () => {
    expect(
      tryRead(() => {
        throw new Error("bad datatype");
      }),
    ).toBeUndefined();
  });
});
