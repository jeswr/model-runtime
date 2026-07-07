// AUTHORED-BY Claude Opus 4.8
import { DataFactory, Parser, Store } from "n3";
import { describe, expect, it } from "vitest";
import { defineModel } from "./model.js";

// A bookmark-shaped manifest, inline — the same shape @jeswr/federation-codegen
// emits from solid-bookmark's SHACL profile. Proves the interpreter reproduces the
// hand-written model's behaviour independently of the generator.
const MANIFEST = {
  manifestVersion: 1,
  runtime: { name: "@jeswr/model-runtime", major: 0 },
  prefixes: {
    book: "https://w3id.org/jeswr/bookmark#",
    schema: "http://schema.org/",
    dct: "http://purl.org/dc/terms/",
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    xsd: "http://www.w3.org/2001/XMLSchema#",
  },
  entities: [
    {
      name: "Bookmark",
      typeIris: ["https://w3id.org/jeswr/bookmark#Bookmark"],
      subject: { convention: "hash-it" },
      fields: [
        {
          name: "url",
          predicate: "http://schema.org/url",
          kind: "iri",
          minCount: 1,
          maxCount: 1,
          guards: { iriScheme: "http-https", requiredFailClosed: true },
        },
        {
          name: "title",
          predicate: "http://purl.org/dc/terms/title",
          kind: "literal",
          datatype: "xsd:string",
          maxCount: 1,
          guards: { emptyStringDrop: true },
        },
        {
          name: "notes",
          predicate: "https://w3id.org/jeswr/bookmark#notes",
          kind: "literal",
          datatype: "xsd:string",
          maxCount: 1,
          guards: { emptyStringDrop: true },
        },
        {
          name: "archived",
          predicate: "https://w3id.org/jeswr/bookmark#archived",
          kind: "literal",
          datatype: "xsd:boolean",
          maxCount: 1,
          default: false,
          materializeDefault: true,
        },
        {
          name: "created",
          predicate: "http://purl.org/dc/terms/created",
          kind: "literal",
          datatype: "xsd:dateTime",
          maxCount: 1,
          defaultNow: true,
        },
        {
          name: "modified",
          predicate: "http://purl.org/dc/terms/modified",
          kind: "literal",
          datatype: "xsd:dateTime",
          maxCount: 1,
        },
        {
          name: "tags",
          predicate: "http://schema.org/keywords",
          kind: "literal",
          datatype: "xsd:string",
          collection: "set",
          guards: { trim: true, dropBlank: true, sortOnRead: true },
        },
      ],
    },
  ],
};

const RES = "http://localhost:3000/alice/bookmarks/x";
const URL_ = "https://example.org/article";
const model = defineModel(MANIFEST);
const bm = model.entities.Bookmark;
if (!bm) throw new Error("Bookmark entity missing");
const SUBJ = bm.subject(RES);

function toStore(ttl: string): Store {
  return new Store(new Parser({ baseIRI: RES }).parse(ttl));
}

describe("subject convention", () => {
  it("hash-it appends #it to the resource URL", () => {
    expect(SUBJ).toBe(`${RES}#it`);
  });
});

describe("build", () => {
  it("stamps rdf:type on the #it subject", () => {
    const store = bm.build(RES, { url: URL_ });
    expect(
      store.getQuads(
        SUBJ,
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
        "https://w3id.org/jeswr/bookmark#Bookmark",
        null,
      ).length,
    ).toBe(1);
  });

  it("writes url as an IRI (NamedNode), not a literal", () => {
    const store = bm.build(RES, { url: URL_ });
    const q = store.getQuads(SUBJ, "http://schema.org/url", null, null);
    expect(q).toHaveLength(1);
    expect(q[0]?.object.termType).toBe("NamedNode");
    expect(q[0]?.object.value).toBe(URL_);
  });

  it("DROPS a non-http(s) url (untrusted-input filter)", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "nota url",
    ]) {
      const store = bm.build(RES, { url: bad });
      expect(store.getQuads(SUBJ, "http://schema.org/url", null, null)).toHaveLength(0);
    }
  });

  it("writes archived as xsd:boolean defaulting to false", () => {
    const store = bm.build(RES, { url: URL_ });
    const q = store.getQuads(SUBJ, "https://w3id.org/jeswr/bookmark#archived", null, null);
    expect(q).toHaveLength(1);
    expect(q[0]?.object.value).toBe("false");
    expect(q[0]?.object.termType).toBe("Literal");
  });

  it("writes each tag as a schema:keywords string literal, skipping blanks", () => {
    const store = bm.build(RES, { url: URL_, tags: ["rust", "  ", "solid", ""] });
    const tags = store
      .getQuads(SUBJ, "http://schema.org/keywords", null, null)
      .map((q) => q.object.value);
    expect(tags.sort()).toEqual(["rust", "solid"]);
  });

  it("empty-string title is dropped (emptyStringDrop)", () => {
    const store = bm.build(RES, { url: URL_, title: "" });
    expect(store.getQuads(SUBJ, "http://purl.org/dc/terms/title", null, null)).toHaveLength(0);
  });
});

describe("round-trip", () => {
  it("a fully-populated bookmark round-trips through Turtle", async () => {
    const data = {
      url: URL_,
      title: "Great article",
      notes: "My **notes**.",
      archived: true,
      tags: ["solid", "rdf"],
      created: new Date("2026-06-09T10:00:00.000Z"),
      modified: new Date("2026-06-10T11:00:00.000Z"),
    };
    const ttl = await bm.serialize(RES, data);
    expect(ttl).toContain("book:");
    expect(ttl).toContain("schema:url");
    const back = bm.parse(RES, toStore(ttl));
    expect(back).toEqual({
      url: URL_,
      title: "Great article",
      notes: "My **notes**.",
      archived: true,
      tags: ["rdf", "solid"],
      created: new Date("2026-06-09T10:00:00.000Z"),
      modified: new Date("2026-06-10T11:00:00.000Z"),
    });
  });

  it("a minimal bookmark round-trips; archived defaults false, created auto-set", async () => {
    const ttl = await bm.serialize(RES, { url: URL_ });
    const back = bm.parse(RES, toStore(ttl));
    expect(back?.url).toBe(URL_);
    expect(back?.archived).toBe(false);
    expect(back?.created).toBeInstanceOf(Date);
    expect(back?.title).toBeUndefined();
    expect(back?.tags).toBeUndefined();
  });

  it("parse returns undefined for a non-instance subject", () => {
    const store = toStore(`<${SUBJ}> <http://schema.org/url> <${URL_}> .`);
    expect(bm.parse(RES, store)).toBeUndefined();
  });

  it("parse REJECTS a hostile non-http(s) url (read filter, fail-closed required)", () => {
    for (const bad of [
      "javascript:alert(document.cookie)",
      "data:text/html,x",
      "file:///etc/passwd",
    ]) {
      const store = toStore(`
        @prefix book:   <https://w3id.org/jeswr/bookmark#> .
        @prefix schema: <http://schema.org/> .
        <${SUBJ}> a book:Bookmark ; schema:url <${bad}> .
      `);
      expect(bm.parse(RES, store)).toBeUndefined();
    }
  });

  it("parse returns undefined for an instance with NO url", () => {
    const store = toStore(`
      @prefix book: <https://w3id.org/jeswr/bookmark#> .
      @prefix dct:  <http://purl.org/dc/terms/> .
      <${SUBJ}> a book:Bookmark ; dct:title "No url" .
    `);
    expect(bm.parse(RES, store)).toBeUndefined();
  });

  it("parseDocument dispatches via @jeswr/fetch-rdf and rejects hostile urls", async () => {
    const ok = await bm.serialize(RES, { url: URL_, title: "Via fetch-rdf" });
    expect((await bm.parseDocument(RES, ok, "text/turtle"))?.title).toBe("Via fetch-rdf");
    // null content-type coalesces to text/turtle
    expect((await bm.parseDocument(RES, ok, null))?.title).toBe("Via fetch-rdf");
    const hostile = `
      @prefix book:   <https://w3id.org/jeswr/bookmark#> .
      @prefix schema: <http://schema.org/> .
      <${SUBJ}> a book:Bookmark ; schema:url <javascript:alert(1)> .
    `;
    expect(await bm.parseDocument(RES, hostile, "text/turtle")).toBeUndefined();
  });
});

describe("typed accessor (Wrapper)", () => {
  it("archived setter clears on undefined and toggles", () => {
    const store = new Store();
    const doc = new bm.Wrapper(SUBJ, store, DataFactory).mark();
    (doc as unknown as { archived: boolean | undefined }).archived = true;
    expect((doc as unknown as { archived: boolean }).archived).toBe(true);
    (doc as unknown as { archived: boolean | undefined }).archived = false;
    expect((doc as unknown as { archived: boolean }).archived).toBe(false);
    expect(
      store.getQuads(SUBJ, "https://w3id.org/jeswr/bookmark#archived", null, null),
    ).toHaveLength(1);
    (doc as unknown as { archived: boolean | undefined }).archived = undefined;
    expect(
      store.getQuads(SUBJ, "https://w3id.org/jeswr/bookmark#archived", null, null),
    ).toHaveLength(0);
    expect((doc as unknown as { archived: boolean }).archived).toBe(false);
  });

  it("tags is a live set", () => {
    const store = new Store();
    const doc = new bm.Wrapper(SUBJ, store, DataFactory).mark();
    const tags = (doc as unknown as { tags: Set<string> }).tags;
    tags.add("a");
    tags.add("b");
    expect([...(doc as unknown as { tags: Set<string> }).tags].sort()).toEqual(["a", "b"]);
    tags.delete("a");
    expect([...(doc as unknown as { tags: Set<string> }).tags]).toEqual(["b"]);
  });

  it("malformed literal drops the field fail-closed (tryRead)", () => {
    // archived stored as a non-boolean lexical value must not throw the parse.
    const store = toStore(`
      @prefix book:   <https://w3id.org/jeswr/bookmark#> .
      @prefix schema: <http://schema.org/> .
      @prefix xsd:    <http://www.w3.org/2001/XMLSchema#> .
      <${SUBJ}> a book:Bookmark ;
        schema:url <${URL_}> ;
        book:archived "not-a-bool"^^xsd:boolean .
    `);
    const back = bm.parse(RES, store);
    expect(back?.url).toBe(URL_);
    // archived reads back as its default false (malformed value dropped).
    expect(back?.archived).toBe(false);
  });

  it("a non-string value on a string field is dropped, not coerced or thrown (fail-closed)", () => {
    // A caller mistyping title as a number must not throw sanitizeText / write garbage.
    const store = bm.build(RES, { url: URL_, title: 123 as unknown as string });
    expect(store.getQuads(SUBJ, "http://purl.org/dc/terms/title", null, null)).toHaveLength(0);
  });
});

// The iri-scheme guard must apply to SET fields too (roborev Medium, model.ts:225):
// an `iri` field with `collection: "set"` and iriScheme filters every member.
const IRI_SET_MANIFEST = {
  manifestVersion: 1,
  runtime: { name: "@jeswr/model-runtime", major: 0 },
  prefixes: { ex: "http://ex.org/" },
  entities: [
    {
      name: "Doc",
      typeIris: ["http://ex.org/Doc"],
      subject: { convention: "hash-it" },
      fields: [
        {
          name: "self",
          predicate: "http://ex.org/self",
          kind: "iri",
          minCount: 1,
          guards: { iriScheme: "http-https", requiredFailClosed: true },
        },
        {
          name: "links",
          predicate: "http://ex.org/link",
          kind: "iri",
          collection: "set",
          guards: { iriScheme: "http-https" },
        },
      ],
    },
  ],
};

describe("iri set field — scheme guard applies to set members", () => {
  const docModel = defineModel(IRI_SET_MANIFEST).entities.Doc;
  if (!docModel) throw new Error("Doc entity missing");
  const Dres = "http://ex.org/d";
  const Dsubj = docModel.subject(Dres);

  it("build drops hostile / non-http members, keeps http ones", () => {
    const store = docModel.build(Dres, {
      self: "https://a.org/self",
      links: ["https://a.org/x", "javascript:alert(1)", "http://b.org/y", "data:text/html,x"],
    });
    const links = store
      .getQuads(Dsubj, "http://ex.org/link", null, null)
      .map((q) => q.object.value);
    expect(links.sort()).toEqual(["http://b.org/y", "https://a.org/x"]);
    // Every stored link is a NamedNode.
    for (const q of store.getQuads(Dsubj, "http://ex.org/link", null, null)) {
      expect(q.object.termType).toBe("NamedNode");
    }
  });

  it("parse drops a hostile link stored by another route (read filter)", () => {
    const store = new Store(
      new Parser({ baseIRI: Dres }).parse(`
        @prefix ex: <http://ex.org/> .
        <${Dsubj}> a ex:Doc ; ex:self <https://a.org/self> ;
          ex:link <https://ok.org/1> , <javascript:alert(1)> .
      `),
    );
    const back = docModel.parse(Dres, store) as { links?: string[] } | undefined;
    expect(back?.links).toEqual(["https://ok.org/1"]);
  });

  it("the live set accessor filters add / has / iterate", () => {
    const store = new Store();
    const doc = new docModel.Wrapper(Dsubj, store, DataFactory).mark();
    const links = (doc as unknown as { links: Set<string> }).links;
    links.add("https://ok.org/a");
    links.add("javascript:alert(1)"); // dropped
    expect([...(doc as unknown as { links: Set<string> }).links]).toEqual(["https://ok.org/a"]);
    expect((doc as unknown as { links: Set<string> }).links.has("javascript:alert(1)")).toBe(false);
    expect((doc as unknown as { links: Set<string> }).links.has("https://ok.org/a")).toBe(true);
  });

  it("a malformed LITERAL planted on an IRI-set predicate does not throw the read (fail-closed)", () => {
    // NamedNodeAs.string would throw on a literal; the raw-quad reader must skip it.
    const store = new Store(
      new Parser({ baseIRI: Dres }).parse(`
        @prefix ex: <http://ex.org/> .
        <${Dsubj}> a ex:Doc ; ex:self <https://a.org/self> ;
          ex:link <https://ok.org/1> , "not-an-iri" .
      `),
    );
    const doc = new docModel.Wrapper(Dsubj, store, DataFactory);
    expect([...(doc as unknown as { links: Set<string> }).links]).toEqual(["https://ok.org/1"]);
    const back = docModel.parse(Dres, store) as { links?: string[] } | undefined;
    expect(back?.links).toEqual(["https://ok.org/1"]);
  });

  it("delete removes a member stored in a NON-canonical form", () => {
    // Store `http://x.org` (no trailing slash); its canonical view is `http://x.org/`.
    const store = new Store(
      new Parser({ baseIRI: Dres }).parse(`
        @prefix ex: <http://ex.org/> .
        <${Dsubj}> a ex:Doc ; ex:self <https://a.org/self> ; ex:link <http://x.org> .
      `),
    );
    const doc = new docModel.Wrapper(Dsubj, store, DataFactory);
    const links = (doc as unknown as { links: Set<string> }).links;
    expect([...links]).toEqual(["http://x.org/"]);
    expect(links.delete("http://x.org/")).toBe(true);
    expect([...(doc as unknown as { links: Set<string> }).links]).toEqual([]);
  });
});
