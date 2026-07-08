# @jeswr/model-runtime

> The **one audited generic runtime** for the [`@jeswr/federation-codegen`](https://github.com/jeswr/federation-codegen)
> pipeline. It interprets a JSON **shape-manifest** to parse / validate / read / write RDF over
> [`@rdfjs/wrapper`](https://github.com/rdfjs/wrapper), carrying the full **guard inventory** that the
> six hand-written `@jeswr` data-model packages (`solid-bookmark`, `solid-task-model`, `solid-drawing`,
> `solid-chat-interop`, `solid-memory`, `solid-health-diary`) each duplicated.

**Status:** alpha — P0 of the federation-codegen design (rev 3). `securityCritical`.

## Why this exists

The hand-written data-model packages re-prove the same ~13-idiom guard inventory through multiple
rounds of adversarial review, and diverge (two different http(s)-IRI filters, one Turtle-injection
unsafe). This package **concentrates that discipline into one place audited once**. A generated model
(`model.d.ts` + `model.json` + `model.js`) is a fixed-template shim that inlines a pure-data manifest
and calls `defineModel` here — **generated artifacts contain no executable logic** (the data-not-code
invariant, design §7.1).

## The guard inventory (design §7.3)

Every read/write goes through, in the load-bearing order:

- **http(s)-only, injection-safe LEXICAL IRI filter** (`httpIriOrUndefined` / `isHttpIri`) — canonicalises
  via `URL.href` so no whitespace/control char can ride into an emitted `NamedNode`; carried verbatim
  from the reviewed `@jeswr/solid-bookmark` reference. Applied to every IRI field with `iriScheme:
  "http-https"`, fail-closed (drops a non-http(s) value on both read and write).
- **`tryRead` fail-closed field drops** — a malformed literal in untrusted pod data drops the field
  rather than aborting the parse.
- **Singleton / default semantics** — `default`, `materializeDefault`, `defaultNow`, `emptyStringDrop`.
- **Control-char sanitization** on every untrusted text write (C0/C1 stripped; tab/newline/cr preserved).
- **Fail-closed manifest validation** — unknown keys rejected, hard caps on bytes / field count /
  `sh:in` length / nesting depth, reserved field-name denylist (`__proto__`, prototype members …),
  schema version bound to the runtime major. **No manifest field may ever carry executable, regex-source,
  template, or path-expression content.**

## API

```ts
import { defineModel } from "@jeswr/model-runtime";

const model = defineModel(manifest);            // validates fail-closed, then interprets
const bookmark = model.entities.Bookmark;       // one ModelEntity per manifest entity

bookmark.subject(resourceUrl);                  // conventional subject IRI (e.g. `${url}#it`)
bookmark.build(resourceUrl, data);              // -> n3 Store (writes through the guards)
bookmark.parse(resourceUrl, dataset);           // -> data object | undefined (fail-closed)
await bookmark.serialize(resourceUrl, data);    // -> Turtle
await bookmark.parseDocument(resourceUrl, body, contentType); // via @jeswr/fetch-rdf

new bookmark.Wrapper(subjectIri, store, factory); // direct typed accessor (extends TermWrapper)
```

The manifest schema (`ModelManifest`) and `validateManifest` are exported for the generator and for
tooling. The IRI filters (`httpIriOrUndefined`, `isHttpIri`, `sanitizeText`, `tryRead`) are exported so
consumers migrating off a hand-written package keep the exact filter behaviour.

## Composite (document-projection) entities

A `kind: "composite"` entity models ONE flat object projected across SEVERAL connected RDF nodes of
one document — the shape the hand-written multi-node models (e.g. `@jeswr/solid-listening`'s
`ScrobbleData`, five nodes: a `media:PlaybackEvent #it` → a `media:Track #track` → `#artist`/`#album`,
plus a `time:Instant #playedAt`) carry. A composite is a **tree** of nodes: a `root` plus one sub-node
per `nested` link field. Each node has its own `rdf:type`(s), document `fragment`, and flat field set;
field names are **globally unique** across the composite (the projection is one object).

```jsonc
{
  "name": "Scrobble", "kind": "composite", "root": "event",
  "nodes": [
    { "name": "event", "typeIris": ["…#PlaybackEvent"], "fragment": "it", "fields": [
      { "name": "msPlayed", "predicate": "…#msPlayed", "kind": "literal", "datatype": "xsd:integer" },
      { "name": "playedWork", "predicate": "…#playedWork", "kind": "nested", "node": "track",
        "guards": { "requiredFailClosed": true } }        // a Violation-graded cross-node MUST
    ]},
    { "name": "track", "typeIris": ["…#Track"], "fragment": "track", "fields": [
      { "name": "trackTitle", "predicate": "dct:title", "kind": "literal", "datatype": "xsd:string",
        "guards": { "requiredFailClosed": true, "nonBlank": true } } ]}
  ]
}
```

- **`build`** writes every node at `${resourceUrl}#${fragment}` and links them (an optional sub-node
  is materialised only when its subtree carries data — no bare typed shells).
- **`parse`** GRAPH-WALKS from the root: it follows the ACTUAL link triple (never assumes the fragment
  — an untrusted document may link anywhere), canonicalising each target IRI through the http(s) filter
  and bounding the candidate scan. A sub-node must carry its `rdf:type` (fail-closed). Link-resolution
  failure — an absent or non-conforming target, an AMBIGUOUS link (>1 distinct canonical target), or an
  over-budget fan-out — is graded by the link: a `requiredFailClosed` cross-node link **rejects the
  WHOLE composite** (a titled `Track` + a valid `Instant` MUST be reachable); a Warning/Info (optional)
  link simply drops its sub-node's fields and admits (an otherwise-usable document is never rejected
  over an unresolvable optional link). Field names being globally unique, the sub-nodes' fields merge
  into one flat object.

The composite manifest is validated **fail-closed** (the tree invariant — one root, every non-root node
exactly one incoming link, acyclic + spanning; a `nested` field carries no data-shape key and only the
`requiredFailClosed` guard; composite documents are http(s)-scoped, matching the suite IRI discipline).

## Install (GitHub, no build step)

`dist/` is committed, so the package installs and imports under `ignore-scripts=true` with no build:

```bash
npm install github:jeswr/model-runtime#main
```

Its runtime deps (`@jeswr/fetch-rdf`, `@rdfjs/wrapper`, `n3`) are all published on npm — nothing is
bundled. npm publish of this package is a deferred migration.

## Development

```bash
npm run gate    # lint (biome) + typecheck (tsc) + test (vitest) + build (tsc) + check:dist
```

`check:dist` fails if the committed `dist/` drifts from a fresh build — rebuild + commit `dist/`
alongside any `src/` change.

## Licence

MIT © Jesse Wright
