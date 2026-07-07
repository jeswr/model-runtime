// AUTHORED-BY Claude Opus 4.8
//
// The composite (document-projection) entity kind — a ROOT node + named SUB-NODES
// projected as ONE flat object across several connected RDF nodes of one document.
// Modelled on @jeswr/solid-listening's ScrobbleData (a PlaybackEvent #it → Track
// #track → Artist #artist / Album #album, and a time:Instant #playedAt), with the
// fork's FAIL-CLOSED cross-node MUSTs (a titled Track + a valid Instant MUST be
// reachable, else the whole scrobble is rejected). This is the security-critical
// untrusted-document validation the single-node runtime could not express.
import { DataFactory, Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { ManifestError, validateManifest } from "./manifest.js";
import { defineModel } from "./model.js";

const MEDIA = "https://w3id.org/jeswr/sectors/media#";
const CORE = "https://w3id.org/jeswr/core#";
const TIME = "http://www.w3.org/2006/time#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const DCT = "http://purl.org/dc/terms/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

// A composite Scrobble manifest — root PlaybackEvent + Track/Artist/Album + Instant.
function scrobbleManifest() {
  return {
    manifestVersion: 1,
    runtime: { name: "@jeswr/model-runtime", major: 0 },
    prefixes: {
      media: MEDIA,
      core: CORE,
      time: TIME,
      foaf: FOAF,
      dct: DCT,
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    },
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
                name: "listener",
                predicate: `${CORE}hadParticipant`,
                kind: "iri" as const,
                maxCount: 1,
                guards: { iriScheme: "http-https" as const },
              },
              {
                name: "playedWork",
                predicate: `${MEDIA}playedWork`,
                kind: "nested" as const,
                node: "track",
                guards: { requiredFailClosed: true },
              },
              {
                name: "atTime",
                predicate: `${CORE}atTime`,
                kind: "nested" as const,
                node: "playedAt",
                guards: { requiredFailClosed: true },
              },
            ],
          },
          {
            name: "track",
            typeIris: [`${MEDIA}Track`],
            fragment: "track",
            fields: [
              {
                name: "trackTitle",
                predicate: `${DCT}title`,
                kind: "literal" as const,
                datatype: "xsd:string",
                minCount: 1,
                maxCount: 1,
                guards: { requiredFailClosed: true, nonBlank: true, minLength: 1 },
              },
              {
                name: "performedByArtist",
                predicate: `${MEDIA}performedByArtist`,
                kind: "nested" as const,
                node: "artist",
              },
              {
                name: "inAlbum",
                predicate: `${MEDIA}inAlbum`,
                kind: "nested" as const,
                node: "album",
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
          {
            name: "artist",
            typeIris: [`${MEDIA}Artist`],
            fragment: "artist",
            fields: [
              {
                name: "artistName",
                predicate: `${FOAF}name`,
                kind: "literal" as const,
                datatype: "xsd:string",
                maxCount: 1,
              },
            ],
          },
          {
            name: "album",
            typeIris: [`${MEDIA}Album`],
            fragment: "album",
            fields: [
              {
                name: "albumTitle",
                predicate: `${DCT}title`,
                kind: "literal" as const,
                datatype: "xsd:string",
                maxCount: 1,
              },
            ],
          },
        ],
      },
    ],
  };
}

const RES = "https://alice.pod.example/listening/2020-01-01";
const IT = `${RES}#it`;
const TRACK = `${RES}#track`;
const PLAYED_AT = `${RES}#playedAt`;
const ARTIST = `${RES}#artist`;
const ALBUM = `${RES}#album`;

const model = defineModel(scrobbleManifest());
const Scrobble = model.entities.Scrobble;
if (!Scrobble) throw new Error("expected the generated Scrobble composite entity");

const WHEN = new Date("2020-01-01T12:00:00.000Z");
const FULL = {
  msPlayed: 210000,
  listener: "https://alice.pod.example/profile/card#me",
  trackTitle: "Blue Monday",
  artistName: "New Order",
  albumTitle: "Power, Corruption & Lies",
  playedAt: WHEN,
};

function toStore(ttl: string): Store {
  return new Store(new Parser({ baseIRI: RES }).parse(ttl));
}
const typed = (s: string, t: string) =>
  DataFactory.quad(
    DataFactory.namedNode(s),
    DataFactory.namedNode(RDF_TYPE),
    DataFactory.namedNode(t),
  );

describe("composite subject + build — five nodes at conventional fragments, linked", () => {
  it("subject() is the ROOT node's fragment IRI (#it)", () => {
    expect(Scrobble.subject(RES)).toBe(IT);
  });

  it("build writes each node at its own fragment (no collision) and links them", () => {
    const store = Scrobble.build(RES, FULL);
    // Each node carries its own rdf:type at its own fragment IRI.
    expect(store.getQuads(IT, RDF_TYPE, `${MEDIA}PlaybackEvent`, null)).toHaveLength(1);
    expect(store.getQuads(TRACK, RDF_TYPE, `${MEDIA}Track`, null)).toHaveLength(1);
    expect(store.getQuads(PLAYED_AT, RDF_TYPE, `${TIME}Instant`, null)).toHaveLength(1);
    expect(store.getQuads(ARTIST, RDF_TYPE, `${MEDIA}Artist`, null)).toHaveLength(1);
    expect(store.getQuads(ALBUM, RDF_TYPE, `${MEDIA}Album`, null)).toHaveLength(1);
    // The #it and #track subjects are DISTINCT (the gap the composite closes).
    expect(IT).not.toBe(TRACK);
    // The link triples are written to the sub-node fragment IRIs.
    const pw = store.getQuads(IT, `${MEDIA}playedWork`, null, null);
    expect(pw).toHaveLength(1);
    expect(pw[0]?.object.termType).toBe("NamedNode");
    expect(pw[0]?.object.value).toBe(TRACK);
    expect(store.getQuads(IT, `${CORE}atTime`, PLAYED_AT, null)).toHaveLength(1);
    expect(store.getQuads(TRACK, `${MEDIA}performedByArtist`, ARTIST, null)).toHaveLength(1);
    expect(store.getQuads(TRACK, `${MEDIA}inAlbum`, ALBUM, null)).toHaveLength(1);
  });

  it("writes each node's OWN fields on its OWN subject", () => {
    const store = Scrobble.build(RES, FULL);
    expect(store.getQuads(TRACK, `${DCT}title`, null, null)[0]?.object.value).toBe("Blue Monday");
    expect(store.getQuads(ALBUM, `${DCT}title`, null, null)[0]?.object.value).toBe(
      "Power, Corruption & Lies",
    );
    expect(store.getQuads(ARTIST, `${FOAF}name`, null, null)[0]?.object.value).toBe("New Order");
    // The two dct:title triples live on DIFFERENT subjects (track vs album) — the flat
    // projection's trackTitle/albumTitle keys never collide.
    expect(store.getQuads(null, `${DCT}title`, null, null)).toHaveLength(2);
  });

  it("omits an optional sub-node (and its link) when the data carries none of its fields", () => {
    const store = Scrobble.build(RES, { trackTitle: "Solo", playedAt: WHEN });
    expect(store.getQuads(ARTIST, null, null, null)).toHaveLength(0);
    expect(store.getQuads(ALBUM, null, null, null)).toHaveLength(0);
    expect(store.getQuads(IT, `${MEDIA}performedByArtist`, null, null)).toHaveLength(0);
    // The required sub-nodes are still written.
    expect(store.getQuads(TRACK, RDF_TYPE, `${MEDIA}Track`, null)).toHaveLength(1);
    expect(store.getQuads(PLAYED_AT, RDF_TYPE, `${TIME}Instant`, null)).toHaveLength(1);
  });
});

describe("composite parse — graph-walk projects the flat object across the nodes", () => {
  it("round-trips build → parse to the same flat object", () => {
    const parsed = Scrobble.parse(RES, Scrobble.build(RES, FULL));
    expect(parsed).toEqual(FULL);
  });

  it("round-trips through serialize → parseDocument (Turtle)", async () => {
    const ttl = await Scrobble.serialize(RES, FULL);
    const parsed = await Scrobble.parseDocument(RES, ttl, "text/turtle");
    expect(parsed).toEqual(FULL);
  });

  it("admits with the optional sub-nodes absent (Warning/Info links drop, MUSTs met)", () => {
    const parsed = Scrobble.parse(RES, Scrobble.build(RES, { trackTitle: "Solo", playedAt: WHEN }));
    expect(parsed).toEqual({ trackTitle: "Solo", playedAt: WHEN });
  });

  it("carries fields from DIFFERENT nodes (trackTitle + playedAt) in ONE object", () => {
    const parsed = Scrobble.parse(RES, Scrobble.build(RES, FULL));
    expect(parsed?.trackTitle).toBe("Blue Monday"); // from #track
    expect(parsed?.playedAt).toEqual(WHEN); // from #playedAt
  });
});

describe("composite parse — FAIL-CLOSED cross-node MUSTs (untrusted document)", () => {
  it("rejects the WHOLE composite when the linked Track has no title (Violation MUST)", () => {
    const store = Scrobble.build(RES, FULL);
    // Strip the linked Track's REQUIRED title — the fork's parseScrobble rejects this.
    store.removeQuads(store.getQuads(TRACK, `${DCT}title`, null, null));
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("rejects when the linked Track's title is whitespace-only (nonBlank MUST)", () => {
    const store = Scrobble.build(RES, FULL);
    store.removeQuads(store.getQuads(TRACK, `${DCT}title`, null, null));
    store.addQuad(
      DataFactory.namedNode(TRACK),
      DataFactory.namedNode(`${DCT}title`),
      DataFactory.literal("   "),
    );
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("rejects when the played-at Instant has no dateTime (Violation MUST)", () => {
    const store = Scrobble.build(RES, FULL);
    store.removeQuads(store.getQuads(PLAYED_AT, `${TIME}inXSDDateTime`, null, null));
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("rejects when the linked Track subject is not typed media:Track (fail-closed type)", () => {
    const store = Scrobble.build(RES, FULL);
    store.removeQuads(store.getQuads(TRACK, RDF_TYPE, `${MEDIA}Track`, null));
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("rejects when the required playedWork link is absent entirely", () => {
    const store = Scrobble.build(RES, FULL);
    store.removeQuads(store.getQuads(IT, `${MEDIA}playedWork`, null, null));
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("rejects when the root subject is not typed media:PlaybackEvent", () => {
    const store = Scrobble.build(RES, FULL);
    store.removeQuads(store.getQuads(IT, RDF_TYPE, `${MEDIA}PlaybackEvent`, null));
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });
});

describe("composite build — a sub-node whose fields are wholly DEFAULTED is materialised", () => {
  const Ev = "https://ex.org/ev#";
  const Dctns = "http://purl.org/dc/terms/";
  const Xsd = "http://www.w3.org/2001/XMLSchema#";
  const defaultsManifest = {
    manifestVersion: 1,
    runtime: { name: "@jeswr/model-runtime", major: 0 },
    prefixes: { ev: Ev, dct: Dctns, rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", xsd: Xsd },
    entities: [
      {
        name: "Event",
        kind: "composite" as const,
        root: "root",
        nodes: [
          {
            name: "root",
            typeIris: [`${Ev}Event`],
            fragment: "it",
            fields: [
              {
                name: "label",
                predicate: `${Ev}label`,
                kind: "literal" as const,
                datatype: "xsd:string",
                maxCount: 1,
              },
              {
                name: "stampLink",
                predicate: `${Ev}stamp`,
                kind: "nested" as const,
                node: "stamp",
                guards: { requiredFailClosed: true },
              },
              {
                name: "metaLink",
                predicate: `${Ev}meta`,
                kind: "nested" as const,
                node: "meta",
              },
            ],
          },
          {
            name: "stamp",
            typeIris: [`${Ev}Stamp`],
            fragment: "stamp",
            // ONLY a defaultNow field — writeFlatField materialises it even when absent.
            fields: [
              {
                name: "createdAt",
                predicate: `${Dctns}created`,
                kind: "literal" as const,
                datatype: "xsd:dateTime",
                maxCount: 1,
                defaultNow: true,
              },
            ],
          },
          {
            name: "meta",
            typeIris: [`${Ev}Meta`],
            fragment: "meta",
            // ONLY a materializeDefault field.
            fields: [
              {
                name: "version",
                predicate: `${Ev}version`,
                kind: "literal" as const,
                datatype: "xsd:integer",
                maxCount: 1,
                default: 1,
                materializeDefault: true,
              },
            ],
          },
        ],
      },
    ],
  };
  const Event = defineModel(defaultsManifest).entities.Event;
  if (!Event) throw new Error("expected the Event composite");
  const R = "https://ex.org/e/1";

  it("materialises a REQUIRED defaulted sub-node even when the caller supplies no data for it", () => {
    // Regression: build data carries ONLY the root's label — the required `stamp`
    // sub-node's sole field is defaultNow, so it MUST still be written (was omitted when
    // subtreeHasData ignored defaults, which then made parse reject the whole composite).
    const store = Event.build(R, { label: "x" });
    expect(store.getQuads(`${R}#stamp`, RDF_TYPE, `${Ev}Stamp`, null)).toHaveLength(1);
    expect(store.getQuads(`${R}#stamp`, `${Dctns}created`, null, null)).toHaveLength(1);
    expect(store.getQuads(`${R}#it`, `${Ev}stamp`, `${R}#stamp`, null)).toHaveLength(1);
    // …and the whole composite round-trips (the required MUST is met by the default).
    const parsed = Event.parse(R, store);
    expect(parsed?.label).toBe("x");
    expect(parsed?.createdAt).toBeInstanceOf(Date);
  });

  it("materialises an OPTIONAL sub-node whose only field is a materializeDefault (matches flat build)", () => {
    const store = Event.build(R, { label: "x" });
    expect(store.getQuads(`${R}#meta`, RDF_TYPE, `${Ev}Meta`, null)).toHaveLength(1);
    expect(store.getQuads(`${R}#meta`, `${Ev}version`, null, null)[0]?.object.value).toBe("1");
    expect(Event.parse(R, store)?.version).toBe(1);
  });
});

describe("composite parse — GRAPH-WALK follows the actual link, not the fragment", () => {
  it("follows playedWork to a Track at an ARBITRARY IRI (not #track)", () => {
    const other = "https://alice.pod.example/tracks/xyz#it";
    const ttl = `
      @prefix media: <${MEDIA}> . @prefix core: <${CORE}> .
      @prefix time: <${TIME}> . @prefix dct: <${DCT}> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${IT}> a media:PlaybackEvent ; media:playedWork <${other}> ; core:atTime <${PLAYED_AT}> .
      <${other}> a media:Track ; dct:title "Elsewhere" .
      <${PLAYED_AT}> a time:Instant ; time:inXSDDateTime "2020-01-01T12:00:00.000Z"^^xsd:dateTime .
    `;
    const parsed = Scrobble.parse(RES, toStore(ttl));
    expect(parsed?.trackTitle).toBe("Elsewhere");
  });

  it("drops a non-http(s) link target (never dereferences a pseudo-scheme) → required MUST unmet", () => {
    const store = new Store();
    store.addQuad(typed(IT, `${MEDIA}PlaybackEvent`));
    store.addQuad(
      DataFactory.namedNode(IT),
      DataFactory.namedNode(`${MEDIA}playedWork`),
      DataFactory.namedNode("urn:evil:track"),
    );
    store.addQuad(typed(PLAYED_AT, `${TIME}Instant`));
    store.addQuad(
      DataFactory.namedNode(PLAYED_AT),
      DataFactory.namedNode(`${TIME}inXSDDateTime`),
      DataFactory.literal(
        "2020-01-01T12:00:00.000Z",
        DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#dateTime"),
      ),
    );
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("skips a hostile LITERAL planted on the link predicate (never a NamedNode) → MUST unmet", () => {
    const store = new Store();
    store.addQuad(typed(IT, `${MEDIA}PlaybackEvent`));
    store.addQuad(
      DataFactory.namedNode(IT),
      DataFactory.namedNode(`${MEDIA}playedWork`),
      DataFactory.literal("not-an-iri"),
    );
    store.addQuad(typed(PLAYED_AT, `${TIME}Instant`));
    store.addQuad(
      DataFactory.namedNode(PLAYED_AT),
      DataFactory.namedNode(`${TIME}inXSDDateTime`),
      DataFactory.literal(
        "2020-01-01T12:00:00.000Z",
        DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#dateTime"),
      ),
    );
    expect(Scrobble.parse(RES, store)).toBeUndefined();
  });

  it("stays bounded + fail-closed against a hostile fan-out of link targets (ambiguity reject)", () => {
    // A hostile document planting MANY distinct targets on the single-valued required
    // link: the parse rejects the whole composite up-front (>1 distinct target ⇒
    // ambiguous) and stays fast — it never backtracks across the fan-out.
    const store = new Store();
    store.addQuad(typed(IT, `${MEDIA}PlaybackEvent`));
    store.addQuad(typed(PLAYED_AT, `${TIME}Instant`));
    store.addQuad(
      DataFactory.namedNode(PLAYED_AT),
      DataFactory.namedNode(`${TIME}inXSDDateTime`),
      DataFactory.literal(
        "2020-01-01T12:00:00.000Z",
        DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#dateTime"),
      ),
    );
    for (let i = 0; i < 500; i++) {
      const target = `https://alice.pod.example/tracks/${i}#it`;
      store.addQuad(
        DataFactory.namedNode(IT),
        DataFactory.namedNode(`${MEDIA}playedWork`),
        DataFactory.namedNode(target),
      );
      store.addQuad(typed(target, `${MEDIA}Track`));
    }
    const start = Date.now();
    expect(Scrobble.parse(RES, store)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("bounds the reads on a NON-http fan-out (no ambiguity trigger) via the read budget", () => {
    // A hostile document plants a huge fan-out of NON-http objects on the required link:
    // none is a valid target, so the ambiguity check never fires — only the per-link READ
    // BUDGET stops the scan. The composite is rejected fail-closed WITHOUT scanning the
    // whole fan-out (the resolver streams and abandons after the budget). Uses a Store spy
    // to assert the object reads stay bounded (never the full 100000).
    const store = new Store();
    store.addQuad(typed(IT, `${MEDIA}PlaybackEvent`));
    store.addQuad(typed(PLAYED_AT, `${TIME}Instant`));
    store.addQuad(
      DataFactory.namedNode(PLAYED_AT),
      DataFactory.namedNode(`${TIME}inXSDDateTime`),
      DataFactory.literal(
        "2020-01-01T12:00:00.000Z",
        DataFactory.namedNode("http://www.w3.org/2001/XMLSchema#dateTime"),
      ),
    );
    const Fanout = 100000;
    for (let i = 0; i < Fanout; i++) {
      store.addQuad(
        DataFactory.namedNode(IT),
        DataFactory.namedNode(`${MEDIA}playedWork`),
        DataFactory.namedNode(`urn:evil:${i}`), // NON-http ⇒ skipped, never a target
      );
    }
    // Spy on the lazy read path: count how many objects the resolver actually pulls.
    const s = store as unknown as {
      readQuads: (...a: unknown[]) => Iterable<unknown>;
    };
    const realReadQuads = s.readQuads.bind(store);
    let objectsRead = 0;
    s.readQuads = function* spy(...args: unknown[]) {
      for (const q of realReadQuads(...args)) {
        objectsRead++;
        yield q;
      }
    } as never;
    try {
      expect(Scrobble.parse(RES, store)).toBeUndefined();
    } finally {
      s.readQuads = realReadQuads as never;
    }
    // The resolver stopped after the read budget (a small constant), NOT the full fan-out.
    expect(objectsRead).toBeLessThan(1000);
  });

  it("REJECTS an ambiguous single-valued link (>1 distinct target) fail-closed", () => {
    // Two distinct playedWork targets — even though one is a perfectly good titled Track,
    // the extra target violates the maxCount-1 nested link, so the WHOLE composite is
    // rejected (an untrusted document must not smuggle a second link target). Set-valued
    // nested links are a documented future feature.
    const bad = "https://alice.pod.example/tracks/bad#it";
    const good = "https://alice.pod.example/tracks/good#it";
    const ttl = `
      @prefix media: <${MEDIA}> . @prefix core: <${CORE}> .
      @prefix time: <${TIME}> . @prefix dct: <${DCT}> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${IT}> a media:PlaybackEvent ; media:playedWork <${bad}>, <${good}> ; core:atTime <${PLAYED_AT}> .
      <${bad}> a media:Track .
      <${good}> a media:Track ; dct:title "Good" .
      <${PLAYED_AT}> a time:Instant ; time:inXSDDateTime "2020-01-01T12:00:00.000Z"^^xsd:dateTime .
    `;
    expect(Scrobble.parse(RES, toStore(ttl))).toBeUndefined();
  });

  it("admits two lexical forms of the SAME canonical link target (not ambiguous)", () => {
    // The link is written twice with distinct lexical IRIs that CANONICALISE to the same
    // http(s) target (an explicit :443 is stripped for https), so there is only ONE
    // distinct canonical target — not ambiguous — and the scrobble round-trips.
    const alt = "https://alice.pod.example:443/listening/2020-01-01#track";
    const ttl = `
      @prefix media: <${MEDIA}> . @prefix core: <${CORE}> .
      @prefix time: <${TIME}> . @prefix dct: <${DCT}> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <${IT}> a media:PlaybackEvent ; media:playedWork <${TRACK}>, <${alt}> ; core:atTime <${PLAYED_AT}> .
      <${TRACK}> a media:Track ; dct:title "Once" .
      <${PLAYED_AT}> a time:Instant ; time:inXSDDateTime "2020-01-01T12:00:00.000Z"^^xsd:dateTime .
    `;
    expect(Scrobble.parse(RES, toStore(ttl))?.trackTitle).toBe("Once");
  });
});

// Loose views of the composite fixture so a mutation test can index nodes/fields
// without a per-line non-null dance (noUncheckedIndexedAccess). The casts assert the
// KNOWN fixture shape; validateManifest re-checks everything fail-closed regardless.
type LooseField = Record<string, unknown>;
interface LooseNode {
  name: string;
  fragment: string;
  fields: LooseField[];
}
function nodesOf(m: ReturnType<typeof scrobbleManifest>): LooseNode[] {
  return (m.entities[0] as unknown as { nodes: LooseNode[] }).nodes;
}
function nodeOf(m: ReturnType<typeof scrobbleManifest>, i: number): LooseNode {
  const node = nodesOf(m)[i];
  if (!node) throw new Error(`fixture node ${i} missing`);
  return node;
}
function fieldOf(m: ReturnType<typeof scrobbleManifest>, ni: number, fi: number): LooseField {
  const field = nodeOf(m, ni).fields[fi];
  if (!field) throw new Error(`fixture field ${ni}.${fi} missing`);
  return field;
}

describe("composite manifest validation — FAIL-CLOSED on a malformed composite", () => {
  const bad: Array<[string, (m: ReturnType<typeof scrobbleManifest>) => void]> = [
    [
      "root not a declared node",
      (m) => {
        (m.entities[0] as { root: string }).root = "ghost";
      },
    ],
    [
      "nested field targeting an unknown node",
      (m) => {
        fieldOf(m, 0, 2).node = "ghost";
      },
    ],
    [
      "nested link into the root",
      (m) => {
        fieldOf(m, 1, 1).node = "event";
      },
    ],
    [
      "a node with two incoming links (not a tree)",
      (m) => {
        // Make the album ALSO a target of the event → album has two parents.
        nodeOf(m, 0).fields.push({
          name: "extraAlbum",
          predicate: `${MEDIA}extra`,
          kind: "nested",
          node: "album",
        });
      },
    ],
    [
      "an orphan node (no incoming link, not root)",
      (m) => {
        // Drop track's inAlbum link → album unreachable.
        nodeOf(m, 1).fields.splice(2, 1);
      },
    ],
    [
      "duplicate node fragment",
      (m) => {
        nodeOf(m, 3).fragment = "track";
      },
    ],
    [
      "duplicate field name across nodes",
      (m) => {
        fieldOf(m, 4, 0).name = "trackTitle";
      },
    ],
    [
      "a nested field carrying a datatype (data key on a structural link)",
      (m) => {
        fieldOf(m, 0, 2).datatype = "xsd:string";
      },
    ],
    [
      "a nested field with a non-requiredFailClosed guard",
      (m) => {
        fieldOf(m, 0, 2).guards = { iriScheme: "http-https" };
      },
    ],
    [
      "a nested field missing its node target",
      (m) => {
        fieldOf(m, 0, 2).node = undefined;
      },
    ],
  ];
  for (const [label, mutate] of bad) {
    it(`rejects ${label}`, () => {
      const m = scrobbleManifest();
      mutate(m);
      expect(() => validateManifest(m)).toThrow(ManifestError);
    });
  }

  it("rejects a nested field inside a FLAT entity", () => {
    const flat = {
      manifestVersion: 1,
      runtime: { name: "@jeswr/model-runtime", major: 0 },
      prefixes: { media: MEDIA },
      entities: [
        {
          name: "Flat",
          typeIris: [`${MEDIA}PlaybackEvent`],
          subject: { convention: "hash-it" },
          fields: [{ name: "x", predicate: `${MEDIA}playedWork`, kind: "nested", node: "y" }],
        },
      ],
    };
    expect(() => validateManifest(flat)).toThrow(ManifestError);
  });

  it("accepts the well-formed scrobble composite", () => {
    expect(() => validateManifest(scrobbleManifest())).not.toThrow();
  });
});

describe("flat and composite entities coexist in one model", () => {
  it("interprets both kinds from one manifest", () => {
    const m = scrobbleManifest();
    m.entities.push({
      name: "Artist",
      // a plain flat entity alongside the composite (no `kind` key)
      typeIris: [`${MEDIA}Artist`],
      subject: { convention: "hash-it" },
      fields: [
        {
          name: "name",
          predicate: `${FOAF}name`,
          kind: "literal",
          datatype: "xsd:string",
          maxCount: 1,
        },
      ],
    } as never);
    const built = defineModel(m);
    expect(built.entities.Scrobble).toBeDefined();
    expect(built.entities.Artist).toBeDefined();
    const store = built.entities.Artist?.build(RES, { name: "Solo" });
    expect(store?.getQuads(IT, `${FOAF}name`, null, null)[0]?.object.value).toBe("Solo");
  });
});
