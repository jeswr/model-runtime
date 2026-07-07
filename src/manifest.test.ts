// AUTHORED-BY Claude Opus 4.8
import { describe, expect, it } from "vitest";
import { isCompositeEntity, ManifestError, validateManifest } from "./manifest.js";

// Loose, mutable, tuple-typed shapes so a test can index [0] without an
// undefined check and smuggle an unknown key without a cast (that IS the test).
interface TField {
  name: string;
  predicate: string;
  kind: string;
  [k: string]: unknown;
}
interface TEntity {
  name: string;
  typeIris: string[];
  subject: { convention: string };
  fields: [TField];
}
interface TManifest {
  manifestVersion: number;
  runtime: { name: string; major: number };
  prefixes: Record<string, string>;
  entities: [TEntity];
}

function base(): TManifest {
  return {
    manifestVersion: 1,
    runtime: { name: "@jeswr/model-runtime", major: 0 },
    prefixes: { book: "https://w3id.org/jeswr/bookmark#" },
    entities: [
      {
        name: "Bookmark",
        typeIris: ["https://w3id.org/jeswr/bookmark#Bookmark"],
        subject: { convention: "hash-it" },
        fields: [{ name: "url", predicate: "http://schema.org/url", kind: "iri" }],
      },
    ],
  };
}

describe("validateManifest — accepts a well-formed manifest", () => {
  it("returns a normalized manifest", () => {
    const m = validateManifest(base());
    expect(m.manifestVersion).toBe(1);
    const first = m.entities[0];
    if (!first || isCompositeEntity(first)) throw new Error("expected a flat Bookmark entity");
    expect(first.name).toBe("Bookmark");
    expect(first.fields[0]?.kind).toBe("iri");
  });
});

describe("validateManifest — FAIL-CLOSED on malformed input", () => {
  const bad: Array<[string, () => unknown]> = [
    ["non-object", () => 42],
    ["wrong manifestVersion", () => ({ ...base(), manifestVersion: 2 })],
    ["wrong runtime major", () => ({ ...base(), runtime: { name: "x", major: 99 } })],
    ["unknown root key", () => ({ ...base(), evil: "x" })],
    [
      "unknown field key (no interpretation smuggling)",
      () => {
        const m = base();
        (m.entities[0].fields[0] as Record<string, unknown>).transform = "() => hack()";
        return m;
      },
    ],
    [
      "unknown guard key",
      () => {
        const m = base();
        (m.entities[0].fields[0] as Record<string, unknown>).guards = { evalMe: true };
        return m;
      },
    ],
    [
      "reserved field name (__proto__)",
      () => {
        const m = base();
        m.entities[0].fields[0].name = "__proto__";
        return m;
      },
    ],
    [
      "reserved field name (constructor)",
      () => {
        const m = base();
        m.entities[0].fields[0].name = "constructor";
        return m;
      },
    ],
    [
      "invalid accessor name",
      () => {
        const m = base();
        m.entities[0].fields[0].name = "has-dash";
        return m;
      },
    ],
    [
      "literal field without datatype",
      () => {
        const m = base();
        (m.entities[0].fields[0] as Record<string, unknown>).kind = "literal";
        return m;
      },
    ],
    [
      "control character in a predicate IRI",
      () => {
        const m = base();
        m.entities[0].fields[0].predicate = "http://x.org/\u0007p";
        return m;
      },
    ],
    ["empty entities", () => ({ ...base(), entities: [] })],
    [
      "duplicate field name",
      () => {
        const m = base();
        m.entities[0].fields.push({ ...m.entities[0].fields[0] });
        return m;
      },
    ],
    [
      "minCount > maxCount",
      () => {
        const m = base();
        Object.assign(m.entities[0].fields[0], { minCount: 3, maxCount: 1 });
        return m;
      },
    ],
  ];

  for (const [label, make] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => validateManifest(make())).toThrow(ManifestError);
    });
  }
});
