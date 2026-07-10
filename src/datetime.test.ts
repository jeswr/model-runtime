// AUTHORED-BY Claude Fable 5
//
// Fail-closed xsd:dateTime / xsd:date handling — a MALFORMED date literal DROPS
// the field (the tryRead convention), never surfaces an `Invalid Date`, and the
// field's `requiredFailClosed` grading then decides admit/reject exactly like
// every other malformed-literal drop. (Previously `LiteralAs.date`'s bare
// `new Date(lexical)` surfaced `Invalid Date` for a malformed-but-typed literal —
// solid-listening's facade had to compensate for `playedAt`.)
import { DataFactory, Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { isXsdDate, isXsdDateTime } from "./datatypes.js";
import { defineModel } from "./model.js";

const EX = "http://ex.org/";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// One entity, both grades side by side: `when` is a Violation-graded MUST
// (requiredFailClosed), `seen` is optional (Warning/Info — drop and admit).
const FLAT_MANIFEST = {
  manifestVersion: 1,
  runtime: { name: "@jeswr/model-runtime", major: 0 },
  prefixes: { ex: EX, xsd: XSD },
  entities: [
    {
      name: "Event",
      typeIris: [`${EX}Event`],
      subject: { convention: "hash-it" as const },
      fields: [
        {
          name: "when",
          predicate: `${EX}when`,
          kind: "literal" as const,
          datatype: "xsd:dateTime",
          minCount: 1,
          maxCount: 1,
          guards: { requiredFailClosed: true },
        },
        {
          name: "seen",
          predicate: `${EX}seen`,
          kind: "literal" as const,
          datatype: "xsd:dateTime",
          maxCount: 1,
        },
        {
          name: "day",
          predicate: `${EX}day`,
          kind: "literal" as const,
          datatype: "xsd:date",
          maxCount: 1,
        },
        {
          name: "occurrences",
          predicate: `${EX}occurrence`,
          kind: "literal" as const,
          datatype: "xsd:dateTime",
          collection: "set" as const,
        },
      ],
    },
  ],
};

const RES = `${EX}events/1`;
const model = defineModel(FLAT_MANIFEST);
const Event_ = model.entities.Event;
if (!Event_) throw new Error("Event entity missing");
const SUBJ = Event_.subject(RES);
const WHEN = new Date("2020-01-01T12:00:00.000Z");

function storeWith(objects: { predicate: string; lexical: string; datatype?: string }[]): Store {
  const store = new Store();
  store.addQuad(
    DataFactory.namedNode(SUBJ),
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(`${EX}Event`),
  );
  for (const { predicate, lexical, datatype } of objects) {
    store.addQuad(
      DataFactory.namedNode(SUBJ),
      DataFactory.namedNode(predicate),
      DataFactory.literal(lexical, DataFactory.namedNode(datatype ?? `${XSD}dateTime`)),
    );
  }
  return store;
}

const MALFORMED_DATETIMES = [
  "not-a-date", // arbitrary garbage — previously an Invalid Date
  "January 1 2020", // JS-Date-parseable prose, NOT an XSD lexical
  "2020-02-30T00:00:00Z", // V8 ROLLS OVER to Mar 1 — a silently wrong value
  "2020-13-01T00:00:00Z", // month out of range
  "2020-01-01T25:00:00Z", // hour out of range
  "2020-01-01T24:30:00Z", // 24: requires zero minutes/seconds
  "2020-01-01T12:60:00Z", // minute out of range
  "2020-01-01T12:00:61Z", // second out of range (no leap seconds in XSD)
  "2020-01-01", // a date lexical is not a dateTime lexical
  "2020-01-01T12:00:00+15:00", // timezone offset beyond ±14:00
];

describe("malformed xsd:dateTime — Violation grade (requiredFailClosed) rejects", () => {
  for (const bad of MALFORMED_DATETIMES) {
    it(`rejects the whole parse for required "${bad}"`, () => {
      const store = storeWith([{ predicate: `${EX}when`, lexical: bad }]);
      expect(Event_.parse(RES, store)).toBeUndefined();
    });
  }

  it("a malformed required value is NOT masked by an absent-field default path", () => {
    // The predicate IS present (with garbage) — that is a reject, not "absent".
    const store = storeWith([{ predicate: `${EX}when`, lexical: "garbage" }]);
    expect(Event_.parse(RES, store)).toBeUndefined();
  });

  it("a wrong-datatype look-alike (xsd:string) drops → required rejects", () => {
    const store = storeWith([
      { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z", datatype: `${XSD}string` },
    ]);
    expect(Event_.parse(RES, store)).toBeUndefined();
  });
});

describe("malformed xsd:dateTime — Warning/Info grade (optional) drops the field, admits", () => {
  for (const bad of MALFORMED_DATETIMES) {
    it(`drops optional "${bad}" and admits the entity`, () => {
      const store = storeWith([
        { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00.000Z" },
        { predicate: `${EX}seen`, lexical: bad },
      ]);
      const parsed = Event_.parse(RES, store);
      expect(parsed).toBeDefined();
      expect(parsed?.when).toEqual(WHEN);
      expect(parsed?.seen).toBeUndefined(); // dropped, never an Invalid Date
    });
  }

  it("never surfaces an Invalid Date through the typed accessor either", () => {
    const store = storeWith([{ predicate: `${EX}seen`, lexical: "not-a-date" }]);
    const doc = new Event_.Wrapper(SUBJ, store, DataFactory);
    expect((doc as unknown as { seen?: Date }).seen).toBeUndefined();
  });
});

describe("valid xsd:dateTime lexicals still read", () => {
  const validCases: [string, string][] = [
    ["2020-01-01T12:00:00.000Z", "2020-01-01T12:00:00.000Z"],
    ["2020-01-01T12:00:00Z", "2020-01-01T12:00:00.000Z"],
    ["2020-01-01T12:00:00+14:00", "2019-12-31T22:00:00.000Z"], // max legal offset
    ["2020-02-29T00:00:00Z", "2020-02-29T00:00:00.000Z"], // leap day
    ["2020-01-01T24:00:00Z", "2020-01-02T00:00:00.000Z"], // XSD end-of-day form
  ];
  for (const [lexical, instant] of validCases) {
    it(`reads "${lexical}"`, () => {
      const store = storeWith([{ predicate: `${EX}when`, lexical }]);
      expect(Event_.parse(RES, store)?.when).toEqual(new Date(instant));
    });
  }

  it("round-trips build → parse", () => {
    const parsed = Event_.parse(RES, Event_.build(RES, { when: WHEN }));
    expect(parsed).toEqual({ when: WHEN });
  });
});

describe("xsd:date — strict lexical + valid write lexical", () => {
  it("reads a plain calendar date", () => {
    const store = storeWith([
      { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z" },
      { predicate: `${EX}day`, lexical: "2020-06-09", datatype: `${XSD}date` },
    ]);
    expect(Event_.parse(RES, store)?.day).toEqual(new Date("2020-06-09T00:00:00.000Z"));
  });

  it("drops a rolled-over calendar date (2019-02-29 — not a leap year)", () => {
    const store = storeWith([
      { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z" },
      { predicate: `${EX}day`, lexical: "2019-02-29", datatype: `${XSD}date` },
    ]);
    expect(Event_.parse(RES, store)?.day).toBeUndefined();
  });

  it("drops an offset-timezoned xsd:date fail-closed (JS Date cannot parse it)", () => {
    // Valid XSD, but V8 refuses `2020-01-01+05:00`; previously ⇒ Invalid Date.
    const store = storeWith([
      { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z" },
      { predicate: `${EX}day`, lexical: "2020-01-01+05:00", datatype: `${XSD}date` },
    ]);
    expect(Event_.parse(RES, store)?.day).toBeUndefined();
  });

  it("build writes a VALID xsd:date lexical (YYYY-MM-DDZ, not a dateTime lexical)", () => {
    const store = Event_.build(RES, { when: WHEN, day: new Date("2020-06-09T15:30:00Z") });
    const q = store.getQuads(SUBJ, `${EX}day`, null, null);
    expect(q).toHaveLength(1);
    expect(q[0]?.object.value).toBe("2020-06-09Z");
    // And it round-trips through the strict reader.
    expect(Event_.parse(RES, store)?.day).toEqual(new Date("2020-06-09T00:00:00.000Z"));
  });
});

describe("write path — an Invalid Date drops fail-closed (never throws toISOString)", () => {
  it("build with an Invalid Date omits the field", () => {
    const store = Event_.build(RES, { when: WHEN, seen: new Date("garbage") });
    expect(store.getQuads(SUBJ, `${EX}seen`, null, null)).toHaveLength(0);
    expect(store.getQuads(SUBJ, `${EX}when`, null, null)).toHaveLength(1);
  });

  it("build with a non-Date on a date field omits the field", () => {
    const store = Event_.build(RES, { when: WHEN, seen: "2020-01-01T12:00:00Z" });
    expect(store.getQuads(SUBJ, `${EX}seen`, null, null)).toHaveLength(0);
  });

  it("typed-accessor write drops an Invalid Date", () => {
    const store = new Store();
    const doc = new Event_.Wrapper(SUBJ, store, DataFactory).mark();
    (doc as unknown as { seen?: Date }).seen = new Date("garbage");
    expect(store.getQuads(SUBJ, `${EX}seen`, null, null)).toHaveLength(0);
  });
});

describe("dateTime SET field — malformed members drop; valid members round-trip", () => {
  it("parse keeps valid members, drops malformed ones (never Invalid Date)", () => {
    const store = storeWith([
      { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z" },
      { predicate: `${EX}occurrence`, lexical: "2021-05-05T05:05:05.000Z" },
      { predicate: `${EX}occurrence`, lexical: "not-a-date" },
      { predicate: `${EX}occurrence`, lexical: "2020-02-30T00:00:00Z" },
    ]);
    const parsed = Event_.parse(RES, store) as { occurrences?: Date[] } | undefined;
    expect(parsed?.occurrences).toEqual([new Date("2021-05-05T05:05:05.000Z")]);
  });

  it("live set add drops an Invalid Date; delete matches by VALUE", () => {
    const store = new Store();
    const doc = new Event_.Wrapper(SUBJ, store, DataFactory).mark();
    const set = (doc as unknown as { occurrences: Set<Date> }).occurrences;
    set.add(new Date("2021-05-05T05:05:05.000Z"));
    set.add(new Date("garbage")); // dropped
    expect([...set]).toEqual([new Date("2021-05-05T05:05:05.000Z")]);
    // A fresh Date object with the same instant deletes the stored member.
    expect(set.delete(new Date("2021-05-05T05:05:05.000Z"))).toBe(true);
    expect([...(doc as unknown as { occurrences: Set<Date> }).occurrences]).toEqual([]);
  });

  it("two distinct instants within the same second do NOT dedup", () => {
    const store = new Store();
    const doc = new Event_.Wrapper(SUBJ, store, DataFactory).mark();
    const set = (doc as unknown as { occurrences: Set<Date> }).occurrences;
    set.add(new Date("2021-05-05T05:05:05.100Z"));
    set.add(new Date("2021-05-05T05:05:05.200Z"));
    expect((doc as unknown as { occurrences: Set<Date> }).occurrences.size).toBe(2);
  });
});

describe("dateTime SET — has()/delete() agree by VALUE (never object identity)", () => {
  const freshSet = (): Set<Date> => {
    const store = new Store();
    const doc = new Event_.Wrapper(SUBJ, store, DataFactory).mark();
    return (doc as unknown as { occurrences: Set<Date> }).occurrences;
  };

  it("has() matches an equal-but-different Date instance, consistently with delete()", () => {
    const set = freshSet();
    set.add(new Date("2021-05-05T05:05:05.000Z"));
    // An EQUAL instant in a DIFFERENT object: `Array.includes` (object identity)
    // reported false here while `delete` of the same value succeeded.
    const probe = new Date("2021-05-05T05:05:05.000Z");
    expect(set.has(probe)).toBe(true);
    expect(set.delete(probe)).toBe(true);
    expect(set.has(probe)).toBe(false);
    expect(set.size).toBe(0);
  });

  it("has() and delete() give the SAME verdict for any probe (hit and miss)", () => {
    const set = freshSet();
    set.add(new Date("2021-05-05T05:05:05.100Z"));
    for (const lexical of ["2021-05-05T05:05:05.100Z", "2021-05-05T05:05:05.200Z"]) {
      const seen = set.has(new Date(lexical));
      const removed = set.delete(new Date(lexical));
      expect(removed).toBe(seen); // never has=false while delete=true (or vice versa)
    }
  });

  it("has() still distinguishes instants a millisecond apart", () => {
    const set = freshSet();
    set.add(new Date("2021-05-05T05:05:05.100Z"));
    expect(set.has(new Date("2021-05-05T05:05:05.200Z"))).toBe(false);
    expect(set.has(new Date("2021-05-05T05:05:05.100Z"))).toBe(true);
  });
});

/** A Date pinned to a UTC calendar date, safe for years JS `Date.UTC` mis-maps (0–99). */
function utcDate(year: number, month1: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month1 - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

describe("xsd:date write — expanded/negative-year Dates emit a VALID lexical", () => {
  const dayLexical = (store: Store) =>
    store.getQuads(SUBJ, `${EX}day`, null, null)[0]?.object.value;

  it("year 100000 writes '100000-01-01Z' and round-trips exactly", () => {
    const far = utcDate(100000, 1, 1);
    const store = Event_.build(RES, { when: WHEN, day: far });
    expect(dayLexical(store)).toBe("100000-01-01Z");
    expect(isXsdDate("100000-01-01Z")).toBe(true);
    expect(Event_.parse(RES, store)?.day).toEqual(far);
  });

  it("year 275759 (near the Date range max) writes valid — never '+275759-06Z'", () => {
    const d = utcDate(275759, 6, 5);
    const store = Event_.build(RES, { when: WHEN, day: d });
    expect(dayLexical(store)).toBe("275759-06-05Z");
    expect(isXsdDate("275759-06-05Z")).toBe(true);
    expect(Event_.parse(RES, store)?.day).toEqual(d);
  });

  it("year -1 writes '-0001-01-01Z' (valid XSD); the strict read drops it fail-closed", () => {
    const store = Event_.build(RES, { when: WHEN, day: utcDate(-1, 1, 1) });
    expect(dayLexical(store)).toBe("-0001-01-01Z");
    expect(isXsdDate("-0001-01-01Z")).toBe(true);
    // V8 re-parses "-0001-01-01Z" as 2001-01-01 (the two-digit-year rule) — the
    // reader must DROP the unfaithful carry, never surface the wrong Date.
    expect(Event_.parse(RES, store)?.day).toBeUndefined();
  });

  it("year 0 writes '0000-01-01Z' (valid XSD 1.1); the strict read drops it fail-closed", () => {
    const store = Event_.build(RES, { when: WHEN, day: utcDate(0, 1, 1) });
    expect(dayLexical(store)).toBe("0000-01-01Z");
    expect(isXsdDate("0000-01-01Z")).toBe(true);
    expect(Event_.parse(RES, store)?.day).toBeUndefined(); // V8 ⇒ 2000-01-01, dropped
  });
});

describe("xsd:date read — a V8-MISPARSED valid lexical drops fail-closed (never a wrong Date)", () => {
  for (const [lexical, misparse] of [
    ["0000-01-01Z", "2000-01-01"],
    ["-0001-01-01Z", "2001-01-01"],
  ] as const) {
    it(`"${lexical}" (V8 silently misparses it to ${misparse}) drops`, () => {
      const store = storeWith([
        { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z" },
        { predicate: `${EX}day`, lexical, datatype: `${XSD}date` },
      ]);
      expect(Event_.parse(RES, store)?.day).toBeUndefined();
    });
  }

  it('"100000-01-01Z" (V8 parses it faithfully) reads the expanded-year date', () => {
    const store = storeWith([
      { predicate: `${EX}when`, lexical: "2020-01-01T12:00:00Z" },
      { predicate: `${EX}day`, lexical: "100000-01-01Z", datatype: `${XSD}date` },
    ]);
    expect(Event_.parse(RES, store)?.day).toEqual(utcDate(100000, 1, 1));
  });
});

// ——— Composite grading: the solid-listening playedAt shape ———

const TIME = "http://www.w3.org/2006/time#";
const MEDIA = "https://w3id.org/jeswr/sectors/media#";
const CORE = "https://w3id.org/jeswr/core#";

// requiredLink=true ⇒ the played-at Instant is a Violation-graded cross-node MUST
// (solid-listening's shape); false ⇒ an optional (Warning/Info) link that degrades.
function compositeManifest(requiredLink: boolean) {
  return {
    manifestVersion: 1,
    runtime: { name: "@jeswr/model-runtime", major: 0 },
    prefixes: { media: MEDIA, core: CORE, time: TIME, xsd: XSD },
    entities: [
      {
        name: "Scrobble",
        kind: "composite" as const,
        root: "event",
        nodes: [
          {
            name: "event",
            typeIris: [`${MEDIA}PlaybackEvent`],
            fragment: "it",
            fields: [
              {
                name: "msPlayed",
                predicate: `${MEDIA}msPlayed`,
                kind: "literal" as const,
                datatype: "xsd:integer",
                maxCount: 1,
              },
              {
                name: "atTime",
                predicate: `${CORE}atTime`,
                kind: "nested" as const,
                node: "playedAt",
                ...(requiredLink ? { guards: { requiredFailClosed: true } } : {}),
              },
            ],
          },
          {
            name: "playedAt",
            typeIris: [`${TIME}Instant`],
            fragment: "playedAt",
            fields: [
              {
                name: "playedAt",
                predicate: `${TIME}inXSDDateTime`,
                kind: "literal" as const,
                datatype: "xsd:dateTime",
                minCount: 1,
                maxCount: 1,
                guards: { requiredFailClosed: true },
              },
            ],
          },
        ],
      },
    ],
  };
}

const CRES = "https://alice.pod.example/listening/2020-01-01";

function compositeStore(playedAtLexical: string): Store {
  return new Store(
    new Parser({ baseIRI: CRES }).parse(`
      @prefix media: <${MEDIA}> .
      @prefix core: <${CORE}> .
      @prefix time: <${TIME}> .
      @prefix xsd: <${XSD}> .
      <${CRES}#it> a media:PlaybackEvent ;
        media:msPlayed "210000"^^xsd:integer ;
        core:atTime <${CRES}#playedAt> .
      <${CRES}#playedAt> a time:Instant ;
        time:inXSDDateTime "${playedAtLexical}"^^xsd:dateTime .
    `),
  );
}

describe("composite — malformed sub-node dateTime graded like any other MUST failure", () => {
  it("Violation grade: a malformed playedAt REJECTS the whole composite", () => {
    const scrobble = defineModel(compositeManifest(true)).entities.Scrobble;
    if (!scrobble) throw new Error("Scrobble missing");
    expect(scrobble.parse(CRES, compositeStore("not-a-date"))).toBeUndefined();
    expect(scrobble.parse(CRES, compositeStore("2020-02-30T00:00:00Z"))).toBeUndefined();
  });

  it("Violation grade: a valid playedAt still admits", () => {
    const scrobble = defineModel(compositeManifest(true)).entities.Scrobble;
    if (!scrobble) throw new Error("Scrobble missing");
    expect(scrobble.parse(CRES, compositeStore("2020-01-01T12:00:00.000Z"))).toEqual({
      msPlayed: 210000,
      playedAt: WHEN,
    });
  });

  it("Warning/Info grade: a malformed playedAt DROPS the sub-node's field, admits", () => {
    const scrobble = defineModel(compositeManifest(false)).entities.Scrobble;
    if (!scrobble) throw new Error("Scrobble missing");
    const parsed = scrobble.parse(CRES, compositeStore("not-a-date"));
    expect(parsed).toEqual({ msPlayed: 210000 });
    expect(parsed?.playedAt).toBeUndefined(); // dropped, never an Invalid Date
  });
});

describe("isXsdDateTime / isXsdDate lexical validators", () => {
  it("accepts valid dateTimes", () => {
    for (const ok of [
      "2020-01-01T12:00:00Z",
      "2020-01-01T12:00:00.5+05:30",
      "2020-02-29T23:59:59-14:00",
      "2020-01-01T24:00:00Z",
      "2020-01-01T24:00:00.000Z",
      "-0500-01-01T00:00:00Z", // negative years are lexically valid XSD
      "2020-01-01T12:00:00",
    ]) {
      expect(isXsdDateTime(ok), ok).toBe(true);
    }
  });

  it("rejects malformed dateTimes", () => {
    for (const bad of MALFORMED_DATETIMES) expect(isXsdDateTime(bad), bad).toBe(false);
  });

  it("accepts valid dates and rejects malformed ones", () => {
    for (const ok of ["2020-06-09", "2020-06-09Z", "2020-06-09+05:00", "2020-02-29"]) {
      expect(isXsdDate(ok), ok).toBe(true);
    }
    for (const bad of ["2019-02-29", "2020-13-01", "2020-01-32", "2020-01-01T00:00:00Z", "x"]) {
      expect(isXsdDate(bad), bad).toBe(false);
    }
  });
});
