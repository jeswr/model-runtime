// AUTHORED-BY Claude Opus 4.8
// Phase G — the SHACL generator-readiness capabilities the runtime must interpret:
//   G3  numeric-range + string-length / non-blank closed value guards
//   G4  xsd:duration (closed lexical validator) + datatype-preserving integer writes
import { DataFactory, Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { isXsdDuration, literalMapper, XSD } from "./datatypes.js";
import { type ManifestField, validateManifest } from "./manifest.js";
import { defineModel } from "./model.js";

const RES = "http://localhost:3000/alice/x";

function manifestWith(field: ManifestField) {
  return {
    manifestVersion: 1 as const,
    runtime: { name: "@jeswr/model-runtime", major: 0 },
    prefixes: { ex: "http://example.org/", xsd: XSD },
    entities: [
      {
        name: "Thing",
        typeIris: ["http://example.org/Thing"],
        subject: { convention: "hash-it" as const },
        fields: [field],
      },
    ],
  };
}

function thing(m: ReturnType<typeof defineModel>) {
  const t = m.entities.Thing;
  if (!t) throw new Error("Thing entity missing");
  return t;
}

function objectValues(store: Store, predicate: string): string[] {
  return store.getQuads(`${RES}#it`, predicate, null, null).map((q) => q.object.value);
}
function objectDatatype(store: Store, predicate: string): string | undefined {
  const q = store.getQuads(`${RES}#it`, predicate, null, null)[0];
  return q && q.object.termType === "Literal"
    ? (q.object as { datatype: { value: string } }).datatype.value
    : undefined;
}

// --- G3: numeric range guards (minInclusive / maxInclusive) ---
describe("G3 — numeric range guards", () => {
  const model = defineModel(
    manifestWith({
      name: "rating",
      predicate: "http://example.org/rating",
      kind: "literal",
      datatype: "xsd:integer",
      maxCount: 1,
      guards: { minInclusive: 1, maxInclusive: 5 },
    }),
  );
  const t = thing(model);

  it("writes a number inside the range", () => {
    expect(objectValues(t.build(RES, { rating: 3 }), "http://example.org/rating")).toEqual(["3"]);
  });
  it("DROPS a number below minInclusive (fail-closed, not coerced)", () => {
    expect(objectValues(t.build(RES, { rating: 0 }), "http://example.org/rating")).toEqual([]);
  });
  it("DROPS a number above maxInclusive", () => {
    expect(objectValues(t.build(RES, { rating: 9 }), "http://example.org/rating")).toEqual([]);
  });
  it("DROPS an out-of-range value on READ too (untrusted pod data)", () => {
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/rating> "42"^^<${XSD}integer> .`,
      ),
    );
    expect(t.parse(RES, store)?.rating).toBeUndefined();
  });
  it("accepts an in-range value on READ", () => {
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/rating> "4"^^<${XSD}integer> .`,
      ),
    );
    expect(t.parse(RES, store)?.rating).toBe(4);
  });
});

// --- G3: string-length + singleton non-blank guards ---
describe("G3 — minLength + singleton non-blank guards", () => {
  const model = defineModel(
    manifestWith({
      name: "code",
      predicate: "http://example.org/code",
      kind: "literal",
      datatype: "xsd:string",
      maxCount: 1,
      guards: { minLength: 1, nonBlank: true },
    }),
  );
  const t = thing(model);

  it("keeps a non-blank string", () => {
    expect(objectValues(t.build(RES, { code: "abc" }), "http://example.org/code")).toEqual(["abc"]);
  });
  it("DROPS an empty string (minLength 1)", () => {
    expect(objectValues(t.build(RES, { code: "" }), "http://example.org/code")).toEqual([]);
  });
  it("DROPS a whitespace-only string (nonBlank / \\S)", () => {
    expect(objectValues(t.build(RES, { code: "   " }), "http://example.org/code")).toEqual([]);
  });
});

// --- G4: xsd:duration lexical validator ---
describe("G4 — isXsdDuration lexical validator (rejects the P…W week form)", () => {
  it("accepts valid XSD durations", () => {
    for (const d of ["P1D", "PT30M", "P1Y2M3DT4H5M6S", "-PT10M", "PT0.5S", "P1Y"]) {
      expect(isXsdDuration(d)).toBe(true);
    }
  });
  it("REJECTS the ISO week form P1W (XSD 1.1 excludes it)", () => {
    expect(isXsdDuration("P1W")).toBe(false);
    expect(isXsdDuration("P2W")).toBe(false);
  });
  it("rejects malformed / empty durations", () => {
    for (const d of ["P", "-P", "PT", "1D", "P1H", "garbage", "", "P1Dx"]) {
      expect(isXsdDuration(d)).toBe(false);
    }
  });
  it("accepts decimal-second forms (xsd:decimal lexical: 1.5, 1., .5)", () => {
    for (const d of ["PT1.5S", "PT1.S", "PT.5S", "PT0.001S"]) {
      expect(isXsdDuration(d)).toBe(true);
    }
  });
});

describe("G4 — xsd:duration field (string-carried, lexically validated)", () => {
  const model = defineModel(
    manifestWith({
      name: "offset",
      predicate: "http://example.org/offset",
      kind: "literal",
      datatype: "xsd:duration",
      maxCount: 1,
    }),
  );
  const t = thing(model);

  it("writes a valid duration tagged xsd:duration (not xsd:string)", () => {
    const store = t.build(RES, { offset: "PT30M" });
    expect(objectValues(store, "http://example.org/offset")).toEqual(["PT30M"]);
    expect(objectDatatype(store, "http://example.org/offset")).toBe(`${XSD}duration`);
  });
  it("DROPS an invalid (week-form) duration on write", () => {
    expect(objectValues(t.build(RES, { offset: "P1W" }), "http://example.org/offset")).toEqual([]);
  });
  it("does NOT silently sanitize an invalid duration into a valid one (validate raw)", () => {
    // a control char / trailing space must DROP the value, not be repaired to "PT30M"
    expect(
      objectValues(t.build(RES, { offset: "PT30M\u0000" }), "http://example.org/offset"),
    ).toEqual([]);
    expect(objectValues(t.build(RES, { offset: "PT30M " }), "http://example.org/offset")).toEqual(
      [],
    );
    // a duration set behaves identically (build set === live add)
    const setModel = defineModel(
      manifestWith({
        name: "offsets",
        predicate: "http://example.org/offsets",
        kind: "literal",
        datatype: "xsd:duration",
        collection: "set",
      }),
    );
    const st = thing(setModel);
    expect(
      objectValues(
        st.build(RES, { offsets: ["PT30M\u0000", "PT5M"] }),
        "http://example.org/offsets",
      ),
    ).toEqual(["PT5M"]);
  });
  it("DROPS an invalid duration on READ (untrusted pod data)", () => {
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/offset> "P1W"^^<${XSD}duration> .`,
      ),
    );
    expect(t.parse(RES, store)?.offset).toBeUndefined();
  });
  it("enforces the RDF DATATYPE on read — a xsd:string that looks like a duration is dropped", () => {
    const wrongType = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/offset> "PT30M" .`,
      ),
    );
    expect(t.parse(RES, wrongType)?.offset).toBeUndefined();
    const rightType = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/offset> "PT30M"^^<${XSD}duration> .`,
      ),
    );
    expect(t.parse(RES, rightType)?.offset).toBe("PT30M");
  });
});

// --- G4: datatype-preserving integer writes ---
describe("G4 — datatype-preserving integer subtype writes", () => {
  it("xsd:positiveInteger round-trips its DECLARED datatype (not xsd:integer)", () => {
    const model = defineModel(
      manifestWith({
        name: "count",
        predicate: "http://example.org/count",
        kind: "literal",
        datatype: "xsd:positiveInteger",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    const store = t.build(RES, { count: 7 });
    expect(objectValues(store, "http://example.org/count")).toEqual(["7"]);
    expect(objectDatatype(store, "http://example.org/count")).toBe(`${XSD}positiveInteger`);
    // and it reads back as a number
    expect(t.parse(RES, store)?.count).toBe(7);
  });
  it("plain xsd:integer still writes xsd:integer (backward-compatible)", () => {
    const model = defineModel(
      manifestWith({
        name: "n",
        predicate: "http://example.org/n",
        kind: "literal",
        datatype: "xsd:integer",
        maxCount: 1,
      }),
    );
    const store = thing(model).build(RES, { n: 3 });
    expect(objectDatatype(store, "http://example.org/n")).toBe(`${XSD}integer`);
  });
  it("the mapper for a subtype reports jsType number", () => {
    expect(literalMapper("xsd:positiveInteger").jsType).toBe("number");
  });
  it("covers the full integer-subtype set (datatype-preserving + range-validated)", () => {
    for (const [dt, ok, bad] of [
      ["xsd:byte", 100, 200],
      ["xsd:short", 30000, 40000],
      ["xsd:unsignedInt", 5, -1],
      ["xsd:unsignedByte", 255, 256],
      ["xsd:negativeInteger", -3, 0],
      ["xsd:nonPositiveInteger", 0, 1],
    ] as const) {
      const model = defineModel(
        manifestWith({
          name: "v",
          predicate: "http://example.org/v",
          kind: "literal",
          datatype: dt,
          maxCount: 1,
        }),
      );
      const t = thing(model);
      const store = t.build(RES, { v: ok });
      expect(objectValues(store, "http://example.org/v")).toEqual([String(ok)]);
      expect(objectDatatype(store, "http://example.org/v")).toBe(`${XSD}${dt.slice(4)}`);
      // an out-of-range value is dropped (not tagged with an invalid subtype)
      expect(objectValues(t.build(RES, { v: bad }), "http://example.org/v")).toEqual([]);
    }
  });
  it("xsd:double PERMITS NaN/INF/-INF with correct XSD lexical (not 'Infinity')", () => {
    const model = defineModel(
      manifestWith({
        name: "d",
        predicate: "http://example.org/d",
        kind: "literal",
        datatype: "xsd:double",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    expect(
      objectValues(t.build(RES, { d: Number.POSITIVE_INFINITY }), "http://example.org/d"),
    ).toEqual(["INF"]);
    expect(
      objectValues(t.build(RES, { d: Number.NEGATIVE_INFINITY }), "http://example.org/d"),
    ).toEqual(["-INF"]);
    expect(objectValues(t.build(RES, { d: Number.NaN }), "http://example.org/d")).toEqual(["NaN"]);
    expect(objectDatatype(t.build(RES, { d: 1.5 }), "http://example.org/d")).toBe(`${XSD}double`);
    // round-trips a special value back to the JS number
    const store = t.build(RES, { d: Number.POSITIVE_INFINITY });
    expect(t.parse(RES, store)?.d).toBe(Number.POSITIVE_INFINITY);
  });
  it("xsd:float rejects a finite value outside the 32-bit range (1e308) but keeps INF/NaN", () => {
    const model = defineModel(
      manifestWith({
        name: "f",
        predicate: "http://example.org/f",
        kind: "literal",
        datatype: "xsd:float",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    expect(objectValues(t.build(RES, { f: 1e308 }), "http://example.org/f")).toEqual([]);
    expect(objectValues(t.build(RES, { f: 1.5 }), "http://example.org/f")).toEqual(["1.5"]);
    expect(
      objectValues(t.build(RES, { f: Number.POSITIVE_INFINITY }), "http://example.org/f"),
    ).toEqual(["INF"]);
    expect(objectDatatype(t.build(RES, { f: 1.5 }), "http://example.org/f")).toBe(`${XSD}float`);
  });

  it("xsd:decimal REJECTS NaN/INF (no infinities in the decimal value space)", () => {
    const model = defineModel(
      manifestWith({
        name: "amt",
        predicate: "http://example.org/amt",
        kind: "literal",
        datatype: "xsd:decimal",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    expect(
      objectValues(t.build(RES, { amt: Number.POSITIVE_INFINITY }), "http://example.org/amt"),
    ).toEqual([]);
    expect(objectValues(t.build(RES, { amt: Number.NaN }), "http://example.org/amt")).toEqual([]);
    expect(objectDatatype(t.build(RES, { amt: 2.5 }), "http://example.org/amt")).toBe(
      `${XSD}decimal`,
    );
  });
  it("DROPS a NON-number (string / NaN) on a numeric field — no invalid typed literal", () => {
    const model = defineModel(
      manifestWith({
        name: "count",
        predicate: "http://example.org/count",
        kind: "literal",
        datatype: "xsd:positiveInteger",
        collection: "set",
      }),
    );
    const t = thing(model);
    // a string "-1" must not be serialized as "-1"^^xsd:positiveInteger
    const store = t.build(RES, { count: ["-1", "abc", Number.NaN, 3] as unknown[] });
    expect(objectValues(store, "http://example.org/count")).toEqual(["3"]);
    // singleton numeric field: a string input is dropped fail-closed
    const single = defineModel(
      manifestWith({
        name: "n",
        predicate: "http://example.org/n",
        kind: "literal",
        datatype: "xsd:integer",
        maxCount: 1,
      }),
    );
    expect(
      objectValues(
        thing(single).build(RES, { n: "5" as unknown as number }),
        "http://example.org/n",
      ),
    ).toEqual([]);
  });
  it("DROPS an out-of-value-space subtype value (positiveInteger -1) — no invalid literal", () => {
    const model = defineModel(
      manifestWith({
        name: "count",
        predicate: "http://example.org/count",
        kind: "literal",
        datatype: "xsd:positiveInteger",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    expect(objectValues(t.build(RES, { count: -1 }), "http://example.org/count")).toEqual([]);
    expect(objectValues(t.build(RES, { count: 0 }), "http://example.org/count")).toEqual([]);
    expect(objectValues(t.build(RES, { count: 1.5 }), "http://example.org/count")).toEqual([]);
    // ...and rejects an out-of-space literal on READ (untrusted pod data)
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/count> "-1"^^<${XSD}positiveInteger> .`,
      ),
    );
    expect(t.parse(RES, store)?.count).toBeUndefined();
  });
});

// --- roborev fixes: guarded defaults + code-point minLength ---
describe("Phase G hardening — defaults obey the guards, minLength counts code points", () => {
  it("a default that violates a datatype/scalar guard is DROPPED, not surfaced", () => {
    const durModel = defineModel(
      manifestWith({
        name: "offset",
        predicate: "http://example.org/offset",
        kind: "literal",
        datatype: "xsd:duration",
        maxCount: 1,
        default: "P1W", // invalid duration default
      }),
    );
    // absent + invalid default ⇒ undefined (never the bad default)
    expect(thing(durModel).parse(RES, thing(durModel).build(RES, {}))?.offset).toBeUndefined();

    const numModel = defineModel(
      manifestWith({
        name: "rating",
        predicate: "http://example.org/rating",
        kind: "literal",
        datatype: "xsd:integer",
        maxCount: 1,
        default: 0,
        guards: { minInclusive: 1, maxInclusive: 5 },
      }),
    );
    expect(thing(numModel).parse(RES, thing(numModel).build(RES, {}))?.rating).toBeUndefined();
  });

  it("a LIVE literal set enforces datatype/scalar guards on add + read (not just build)", () => {
    const model = defineModel(
      manifestWith({
        name: "offsets",
        predicate: "http://example.org/offsets",
        kind: "literal",
        datatype: "xsd:duration",
        collection: "set",
        // no maxCount ⇒ a set field
      }),
    );
    const t = thing(model);
    const store = t.build(RES, {});
    const doc = new t.Wrapper(`${RES}#it`, store, DataFactory);
    const set = (doc as unknown as { offsets: Set<string> }).offsets;
    set.add("PT30M"); // valid
    set.add("P1W"); // invalid week-form ⇒ dropped
    expect([...set]).toEqual(["PT30M"]);
    expect(set.size).toBe(1);
    expect(set.has("P1W")).toBe(false);
  });

  it("a live decimal/double/float set rejects a non-number member on add", () => {
    const model = defineModel(
      manifestWith({
        name: "amounts",
        predicate: "http://example.org/amounts",
        kind: "literal",
        datatype: "xsd:decimal",
        collection: "set",
      }),
    );
    const t = thing(model);
    const doc = new t.Wrapper(`${RES}#it`, t.build(RES, {}), DataFactory);
    const set = (doc as unknown as { amounts: Set<unknown> }).amounts;
    set.add(1.5);
    set.add("nope" as unknown as number); // non-number ⇒ dropped
    set.add(Number.NaN); // NaN ⇒ dropped
    expect([...set]).toEqual([1.5]);
  });

  it("a guarded set READ drops a malformed stored member fail-closed (no throw)", () => {
    const model = defineModel(
      manifestWith({
        name: "scores",
        predicate: "http://example.org/scores",
        kind: "literal",
        datatype: "xsd:integer",
        collection: "set",
      }),
    );
    const t = thing(model);
    // a hostile non-numeric literal on a numeric-set predicate would make the mapper
    // throw; the guarded read must DROP it, not abort the whole parse/iteration.
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ;
           <http://example.org/scores> "5"^^<${XSD}integer>, "not-a-number"^^<http://example.org/weird> .`,
      ),
    );
    const parsed = t.parse(RES, store);
    expect(parsed?.scores).toEqual([5]);
    // direct iteration over the live set also does not throw
    const doc = new t.Wrapper(`${RES}#it`, store, DataFactory);
    const set = (doc as unknown as { scores: Set<number> }).scores;
    expect(() => [...set]).not.toThrow();
    expect([...set]).toEqual([5]);
    expect(set.size).toBe(1);
  });

  it("xsd:decimal writes exponent-prone values as PLAIN decimal lexical (round-trips)", () => {
    const model = defineModel(
      manifestWith({
        name: "amt",
        predicate: "http://example.org/amt",
        kind: "literal",
        datatype: "xsd:decimal",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    // 1e-7 / 1e21 stringify to exponent form — the decimal serialiser expands them.
    expect(objectValues(t.build(RES, { amt: 1e-7 }), "http://example.org/amt")).toEqual([
      "0.0000001",
    ]);
    expect(objectValues(t.build(RES, { amt: 1e21 }), "http://example.org/amt")).toEqual([
      "1000000000000000000000",
    ]);
    expect(objectValues(t.build(RES, { amt: 12.5 }), "http://example.org/amt")).toEqual(["12.5"]);
    // a small stored decimal READS back (no longer dropped for its exponent JS form)
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/amt> "0.0000001"^^<${XSD}decimal> .`,
      ),
    );
    expect(t.parse(RES, store)?.amt).toBe(1e-7);
    // NaN / INF are still rejected (not in the decimal value space)
    expect(objectValues(t.build(RES, { amt: Number.NaN }), "http://example.org/amt")).toEqual([]);
  });

  it("a numeric range guard rejects NaN (unordered) fail-closed", () => {
    const model = defineModel(
      manifestWith({
        name: "d",
        predicate: "http://example.org/d",
        kind: "literal",
        datatype: "xsd:double",
        maxCount: 1,
        guards: { minInclusive: 0, maxInclusive: 100 },
      }),
    );
    const t = thing(model);
    expect(objectValues(t.build(RES, { d: Number.NaN }), "http://example.org/d")).toEqual([]);
    expect(objectValues(t.build(RES, { d: 50 }), "http://example.org/d")).toEqual(["50"]);
  });

  it("a guarded numeric set deletes a NON-CANONICAL stored literal (01 == 1)", () => {
    const model = defineModel(
      manifestWith({
        name: "scores",
        predicate: "http://example.org/scores",
        kind: "literal",
        datatype: "xsd:integer",
        collection: "set",
      }),
    );
    const t = thing(model);
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/scores> "01"^^<${XSD}integer> .`,
      ),
    );
    const doc = new t.Wrapper(`${RES}#it`, store, DataFactory);
    const set = (doc as unknown as { scores: Set<number> }).scores;
    expect(set.has(1)).toBe(true); // 01 == 1 (SameValueZero via the mapped value)
    expect(set.delete(1)).toBe(true); // deletes the non-canonical stored quad
    expect([...set]).toEqual([]);
  });

  it("a guarded IRI set deletes a non-canonical stored member by canonical equivalence", () => {
    const model = defineModel(
      manifestWith({
        name: "links",
        predicate: "http://example.org/links",
        kind: "iri",
        collection: "set",
        guards: { iriScheme: "http-https", minLength: 5 },
      }),
    );
    const t = thing(model);
    // seed a NON-canonical IRI (no trailing slash) directly in the store
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/links> <http://x.org> .`,
      ),
    );
    const doc = new t.Wrapper(`${RES}#it`, store, DataFactory);
    const set = (doc as unknown as { links: Set<string> }).links;
    // deleting by the CANONICAL form removes the non-canonical stored member
    expect(set.delete("http://x.org/")).toBe(true);
    expect([...set]).toEqual([]);
  });

  it("a live numeric set drops an out-of-range member on add", () => {
    const model = defineModel(
      manifestWith({
        name: "scores",
        predicate: "http://example.org/scores",
        kind: "literal",
        datatype: "xsd:integer",
        collection: "set",
        guards: { minInclusive: 1, maxInclusive: 5 },
      }),
    );
    const t = thing(model);
    const doc = new t.Wrapper(`${RES}#it`, t.build(RES, {}), DataFactory);
    const set = (doc as unknown as { scores: Set<number> }).scores;
    set.add(3);
    set.add(99); // out of range ⇒ dropped
    expect([...set]).toEqual([3]);
  });

  it("xsd:int rejects an out-of-32-bit-range value (bounded integer subtype)", () => {
    const model = defineModel(
      manifestWith({
        name: "i",
        predicate: "http://example.org/i",
        kind: "literal",
        datatype: "xsd:int",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    expect(objectValues(t.build(RES, { i: 2147483647 }), "http://example.org/i")).toEqual([
      "2147483647",
    ]);
    expect(objectValues(t.build(RES, { i: 2147483648 }), "http://example.org/i")).toEqual([]);
  });

  it("composes iriScheme + a scalar guard on an IRI field (both enforced, read+write)", () => {
    const model = defineModel(
      manifestWith({
        name: "link",
        predicate: "http://example.org/link",
        kind: "iri",
        maxCount: 1,
        guards: { iriScheme: "http-https", minLength: 20 },
      }),
    );
    const t = thing(model);
    // a valid http(s) IRI shorter than minLength 20 is dropped (scalar guard)...
    expect(objectValues(t.build(RES, { link: "http://x/" }), "http://example.org/link")).toEqual(
      [],
    );
    // ...a long-enough valid IRI is kept (canonicalised by the scheme filter)
    const ok = "https://example.org/a-longer-path";
    expect(objectValues(t.build(RES, { link: ok }), "http://example.org/link")).toEqual([ok]);
    // ...and a non-http(s) IRI is still dropped by the scheme filter
    expect(
      objectValues(t.build(RES, { link: "javascript:alert(1)" }), "http://example.org/link"),
    ).toEqual([]);
    // read-side composition: a short IRI in the store does not surface
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/link> <http://x/> .`,
      ),
    );
    expect(t.parse(RES, store)?.link).toBeUndefined();
  });

  it("a PRESENT value that fails a guard reads as undefined — NOT masked by the default", () => {
    const model = defineModel(
      manifestWith({
        name: "offset",
        predicate: "http://example.org/offset",
        kind: "literal",
        datatype: "xsd:duration",
        maxCount: 1,
        default: "PT1H", // a VALID default
      }),
    );
    const t = thing(model);
    // absent ⇒ the default applies
    expect(t.parse(RES, t.build(RES, {}))?.offset).toBe("PT1H");
    // present-but-INVALID ⇒ undefined, NOT the default (no masking of bad pod data)
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/offset> "P1W"^^<${XSD}duration> .`,
      ),
    );
    expect(t.parse(RES, store)?.offset).toBeUndefined();
  });

  it("a present-but-invalid required value still fails closed (requiredFailClosed, no default mask)", () => {
    const model = defineModel(
      manifestWith({
        name: "rating",
        predicate: "http://example.org/rating",
        kind: "literal",
        datatype: "xsd:integer",
        minCount: 1,
        maxCount: 1,
        default: 3,
        guards: { minInclusive: 1, maxInclusive: 5, requiredFailClosed: true },
      }),
    );
    const t = thing(model);
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/rating> "0"^^<${XSD}integer> .`,
      ),
    );
    // 0 is out of range ⇒ the field reads undefined ⇒ requiredFailClosed rejects the whole parse
    expect(t.parse(RES, store)).toBeUndefined();
  });

  it("a present-but-UNREADABLE singleton value is NOT masked by the default (fail-closed)", () => {
    const model = defineModel(
      manifestWith({
        name: "n",
        predicate: "http://example.org/n",
        kind: "literal",
        datatype: "xsd:integer",
        maxCount: 1,
        default: 42,
        guards: { requiredFailClosed: true },
      }),
    );
    const t = thing(model);
    // present but unreadable as an integer (the mapper throws) ⇒ the whole parse fails
    // closed via requiredFailClosed; the default 42 must NOT mask the bad pod data.
    const store = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/n> "oops"^^<http://example.org/weird> .`,
      ),
    );
    expect(t.parse(RES, store)).toBeUndefined();
  });

  it("a guarded xsd:duration set drops a NON-string member on add (fail-closed serializer)", () => {
    const model = defineModel(
      manifestWith({
        name: "offsets",
        predicate: "http://example.org/offsets",
        kind: "literal",
        datatype: "xsd:duration",
        collection: "set",
      }),
    );
    const t = thing(model);
    const doc = new t.Wrapper(`${RES}#it`, t.build(RES, {}), DataFactory);
    const set = (doc as unknown as { offsets: Set<unknown> }).offsets;
    set.add(123 as unknown as string); // non-string ⇒ dropped
    set.add("PT5M");
    expect([...set]).toEqual(["PT5M"]);
  });

  it("guarded set has() uses SameValueZero — has(NaN) is true for a NaN double member", () => {
    const model = defineModel(
      manifestWith({
        name: "vals",
        predicate: "http://example.org/vals",
        kind: "literal",
        datatype: "xsd:double",
        collection: "set",
      }),
    );
    const t = thing(model);
    const doc = new t.Wrapper(`${RES}#it`, t.build(RES, {}), DataFactory);
    const set = (doc as unknown as { vals: Set<number> }).vals;
    set.add(Number.NaN);
    expect(set.has(Number.NaN)).toBe(true);
  });

  it("a guarded IRI set canonicalises BEFORE the length check (no padded bypass)", () => {
    const model = defineModel(
      manifestWith({
        name: "links",
        predicate: "http://example.org/links",
        kind: "iri",
        collection: "set",
        guards: { iriScheme: "http-https", minLength: 15 },
      }),
    );
    const t = thing(model);
    const doc = new t.Wrapper(`${RES}#it`, t.build(RES, {}), DataFactory);
    const set = (doc as unknown as { links: Set<string> }).links;
    // padded to > 15 chars, but canonicalises to "https://x/" (10) < 15 ⇒ dropped
    set.add("   https://x/   ");
    // a genuinely long-enough canonical IRI is kept
    set.add("https://example.org/resource");
    expect([...set]).toEqual(["https://example.org/resource"]);
  });

  it("an IRI-scheme field drops a NON-string write (no URL toString coercion)", () => {
    const model = defineModel(
      manifestWith({
        name: "u",
        predicate: "http://example.org/u",
        kind: "iri",
        maxCount: 1,
        guards: { iriScheme: "http-https" },
      }),
    );
    const t = thing(model);
    // an object with a toString() that would parse as a URL must NOT be coerced
    const hostile = { toString: () => "https://evil.example/" } as unknown as string;
    expect(objectValues(t.build(RES, { u: hostile }), "http://example.org/u")).toEqual([]);
    expect(
      objectValues(t.build(RES, { u: "https://ok.example/" }), "http://example.org/u"),
    ).toEqual(["https://ok.example/"]);
  });

  it("xsd:double read drops a MALFORMED lexical (not surfaced as NaN)", () => {
    const model = defineModel(
      manifestWith({
        name: "d",
        predicate: "http://example.org/d",
        kind: "literal",
        datatype: "xsd:double",
        maxCount: 1,
      }),
    );
    const t = thing(model);
    const bad = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/d> "abc"^^<${XSD}double> .`,
      ),
    );
    expect(t.parse(RES, bad)?.d).toBeUndefined();
    const nan = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/d> "NaN"^^<${XSD}double> .`,
      ),
    );
    expect(Number.isNaN(t.parse(RES, nan)?.d as number)).toBe(true); // a GENUINE NaN survives
    // a special token on a NON-float datatype is rejected
    const badInt = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/d> "INF"^^<${XSD}integer> .`,
      ),
    );
    expect(t.parse(RES, badInt)?.d).toBeUndefined();
    // a finite-looking lexical that overflows to Infinity is rejected
    const overflow = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/d> "1e309"^^<${XSD}double> .`,
      ),
    );
    expect(t.parse(RES, overflow)?.d).toBeUndefined();
    // a NARROWER numeric datatype does not surface through a double field (exact match)
    const narrower = new Store(
      new Parser().parse(
        `<${RES}#it> a <http://example.org/Thing> ; <http://example.org/d> "5"^^<${XSD}integer> .`,
      ),
    );
    expect(t.parse(RES, narrower)?.d).toBeUndefined();
  });

  it("a non-scheme IRI field drops a NON-string write fail-closed (before scalar guards)", () => {
    const model = defineModel(
      manifestWith({
        name: "ref",
        predicate: "http://example.org/ref",
        kind: "iri",
        maxCount: 1,
        guards: { minLength: 3 }, // no iriScheme guard
      }),
    );
    const t = thing(model);
    expect(
      objectValues(t.build(RES, { ref: 42 as unknown as string }), "http://example.org/ref"),
    ).toEqual([]);
    // a valid string IRI long enough is kept
    expect(objectValues(t.build(RES, { ref: "urn:x:y" }), "http://example.org/ref")).toEqual([
      "urn:x:y",
    ]);
  });

  it("minLength counts Unicode code points, not UTF-16 units (astral char is length 1)", () => {
    const model = defineModel(
      manifestWith({
        name: "code",
        predicate: "http://example.org/code",
        kind: "literal",
        datatype: "xsd:string",
        maxCount: 1,
        guards: { minLength: 2 },
      }),
    );
    const t = thing(model);
    // "😀x" is 2 code points but 3 UTF-16 units — must satisfy minLength 2.
    expect(objectValues(t.build(RES, { code: "😀x" }), "http://example.org/code")).toEqual(["😀x"]);
    // a single astral char is 1 code point (2 UTF-16 units) — fails minLength 2.
    expect(objectValues(t.build(RES, { code: "😀" }), "http://example.org/code")).toEqual([]);
  });
});

// --- guard validation (manifest.ts) ---
describe("G3 — manifest guard validation", () => {
  it("accepts the new numeric / length guards", () => {
    expect(() =>
      validateManifest(
        manifestWith({
          name: "r",
          predicate: "http://example.org/r",
          kind: "literal",
          datatype: "xsd:integer",
          maxCount: 1,
          guards: { minInclusive: 0, maxInclusive: 10, minLength: 1, nonBlank: true },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects minInclusive > maxInclusive", () => {
    expect(() =>
      validateManifest(
        manifestWith({
          name: "r",
          predicate: "http://example.org/r",
          kind: "literal",
          datatype: "xsd:integer",
          maxCount: 1,
          guards: { minInclusive: 10, maxInclusive: 1 },
        }),
      ),
    ).toThrow(/minInclusive.*exceeds.*maxInclusive/);
  });
  it("rejects a non-finite minInclusive", () => {
    expect(() =>
      validateManifest(
        manifestWith({
          name: "r",
          predicate: "http://example.org/r",
          kind: "literal",
          datatype: "xsd:integer",
          maxCount: 1,
          guards: { minInclusive: Number.POSITIVE_INFINITY },
        }),
      ),
    ).toThrow(/must be a finite number/);
  });
});
