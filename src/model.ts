// AUTHORED-BY Claude Opus 4.8
/**
 * The interpreter — `defineModel(manifest)` turns a validated shape-manifest into
 * a typed model over `@rdfjs/wrapper`: a `Wrapper` class with per-field accessors,
 * plus `build` / `parse` / `serialize` / `parseDocument`. This is the ONLY code
 * path; a generated `model.js` is a fixed-template shim that inlines a manifest
 * and calls this. Every guard (design §7.3) is applied here, once, so no generated
 * artifact carries any of it.
 *
 * Guard ordering is load-bearing: IRI scheme-filtering + control-char sanitization
 * + fail-closed datatype coercion run at the string→term and term→value
 * boundaries regardless of a value's provenance, so untrusted pod data can never
 * surface an unfiltered term to a caller.
 */

import type { DataFactory, DatasetCore, Term } from "@rdfjs/types";
import {
  type ITermAsValueMapping,
  type ITermFromValueMapping,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import { DataFactory as N3DataFactory, Store, Writer } from "n3";
import { type DatatypeMapper, iriMapper, literalMapper } from "./datatypes.js";
import { httpIriOrUndefined, sanitizeText, tryRead } from "./guards.js";
import {
  type CompositeManifestEntity,
  isCompositeEntity,
  type ManifestEntity,
  type ManifestField,
  type ManifestNode,
  type ModelManifest,
  validateManifest,
} from "./manifest.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/** A plain, serialisable projection of an entity instance (field name → value). */
export type EntityData = Record<string, unknown>;

/** A wrapper instance exposes per-field accessors plus these structural members. */
export interface EntityWrapper extends TermWrapper {
  /** This subject's IRI. */
  readonly id: string;
  /** The `rdf:type` set, as a live set of IRI strings. */
  readonly types: Set<string>;
  /** Whether this subject carries (any of) the entity's type IRI(s). */
  readonly isInstance: boolean;
  /** Stamp this subject with the entity's type IRI(s); returns `this`. */
  mark(): this;
}

export type EntityWrapperConstructor = new (
  term: string | Term,
  dataset: DatasetCore,
  factory: DataFactory,
) => EntityWrapper;

/** The generated operations for a single entity. */
export interface ModelEntity {
  /** The entity name (matches the manifest / generated type). */
  readonly name: string;
  /** The primary `rdf:type` IRI. */
  readonly typeIri: string;
  /** The Wrapper class for direct typed access. */
  readonly Wrapper: EntityWrapperConstructor;
  /** The conventional subject IRI for a document at `resourceUrl`. */
  subject(resourceUrl: string): string;
  /** Build an n3 `Store` from a plain data object (writes through the guards). */
  build(resourceUrl: string, data: EntityData): Store;
  /** Read a data object back from an RDF dataset, or `undefined` if non-conforming. */
  parse(resourceUrl: string, dataset: DatasetCore): EntityData | undefined;
  /** Serialise built RDF to Turtle with the manifest prefixes. */
  serialize(resourceUrl: string, data: EntityData): Promise<string>;
  /** Serialise an existing store to Turtle with the manifest prefixes. */
  storeToTurtle(store: Store): Promise<string>;
  /** Parse a fetched RDF document (any `@jeswr/fetch-rdf` format) into a data object. */
  parseDocument(
    resourceUrl: string,
    body: string,
    contentType?: string | null,
  ): Promise<EntityData | undefined>;
}

/** The interpreted model: one {@link ModelEntity} per manifest entity, by name. */
export interface Model {
  readonly manifest: ModelManifest;
  readonly prefixes: Record<string, string>;
  readonly entities: Record<string, ModelEntity>;
}

export interface DefineModelOptions {
  /** The RDF/JS DataFactory (defaults to n3's). */
  factory?: DataFactory;
}

/** The resolved per-field runtime plan (mapper + subject convention, computed once). */
interface FieldPlan {
  readonly field: ManifestField;
  readonly mapper: DatatypeMapper;
}

function planField(field: ManifestField): FieldPlan {
  const mapper = field.kind === "iri" ? iriMapper() : literalMapper(field.datatype as string);
  return { field, mapper };
}

/** Whether a field is an IRI field carrying the http(s)-only scheme guard. */
function hasIriSchemeGuard(field: ManifestField): boolean {
  return field.kind === "iri" && field.guards?.iriScheme === "http-https";
}

/**
 * SameValueZero equality (native `Set` semantics: NaN matches NaN; +0 matches -0),
 * extended with `Date` VALUE equality: every read mints a fresh `Date` object, so
 * identity comparison would make `delete(date)` on a dateTime set always miss.
 */
function sameValueZero(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return (
    a === b ||
    (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))
  );
}

/**
 * Apply the CLOSED, DATA-ONLY value guards (numeric range + string length /
 * non-blank) fail-closed: a value violating a guard is DROPPED (→ `undefined`),
 * never coerced. Numbers are gated by `minInclusive`/`maxInclusive`; strings by
 * `minLength` and the singleton `nonBlank` (whitespace-only) drop. Applied on every
 * read, write, and set-member boundary regardless of the value's provenance.
 */
function applyScalarGuards(field: ManifestField, value: unknown): unknown {
  const g = field.guards;
  if (g === undefined) return value;
  if (typeof value === "number") {
    const hasRange = g.minInclusive !== undefined || g.maxInclusive !== undefined;
    // NaN is unordered — both comparisons are false, so it would slip a range guard;
    // reject it explicitly when any range bound is declared (fail-closed).
    if (hasRange && Number.isNaN(value)) return undefined;
    if (g.minInclusive !== undefined && value < g.minInclusive) return undefined;
    if (g.maxInclusive !== undefined && value > g.maxInclusive) return undefined;
  }
  if (typeof value === "string") {
    // minLength counts Unicode CODE POINTS (not UTF-16 code units) to match
    // SHACL/XSD character-length semantics for astral characters.
    if (g.minLength !== undefined && [...value].length < g.minLength) return undefined;
    if (g.nonBlank === true && value.trim() === "") return undefined;
  }
  return value;
}

/**
 * Drop a value that does not conform to its datatype's narrowed value space, fail-
 * closed on every read + write + set-member boundary:
 *   - a NUMERIC field requires a `number` — a non-number (e.g. the STRING `"-1"`) is
 *     dropped, so it can never be serialized as a typed numeric literal
 *     (`"-1"^^xsd:positiveInteger`) — then the datatype's value space is enforced by
 *     its `numericValid` (integer subtypes: safe-integer + sign/range; decimal:
 *     finite; float/double: any number, incl. the permitted NaN/INF/-INF);
 *   - a string outside a `lexicalValid` lexical space (e.g. `xsd:duration`) is dropped.
 */
function applyDatatypeValidity(mapper: DatatypeMapper, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (mapper.jsType === "number") {
    if (typeof value !== "number") return undefined;
    if (mapper.numericValid && !mapper.numericValid(value)) return undefined;
    return value;
  }
  if (mapper.jsType === "string") {
    // A string-mapped field requires a string — a non-string (e.g. `set.add(123)` on
    // an xsd:duration set) is dropped fail-closed rather than reaching the serializer.
    if (typeof value !== "string") return undefined;
    if (mapper.lexicalValid && !mapper.lexicalValid(value)) return undefined;
    return value;
  }
  if (mapper.jsType === "date") {
    // A date field requires a TIME-VALID `Date` — a non-Date, or an `Invalid Date`
    // (whose `toISOString()` would throw the write, and which must never surface on
    // read), is dropped fail-closed like every other malformed value.
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return undefined;
    return value;
  }
  return value;
}

/**
 * The raw NamedNode object VALUES of `(doc, predicate, *)`, read straight from the
 * dataset — NOT through a mapper. Non-NamedNode objects (a literal / blank node
 * planted on an IRI predicate by hostile pod data) are SKIPPED, so a malformed
 * term can never throw the read (fail-closed); the @rdfjs/wrapper `NamedNodeAs`
 * mapper would throw on such a term, so the filtered set must not use it for reads.
 */
function rawNamedNodeValues(doc: TermWrapper, predicate: string): string[] {
  const pred = doc.factory.namedNode(predicate);
  const out: string[] = [];
  for (const q of doc.dataset.match(doc as unknown as Term, pred, null, null)) {
    if (q.object.termType === "NamedNode") out.push(q.object.value);
  }
  return out;
}

/**
 * Lazily yield the OBJECT terms of `(subject, predicate, *)` WITHOUT materialising the
 * full match — so a caller can stop early after a bounded number of reads. Prefers n3's
 * lazy `readQuads` generator (which yields on demand and can be abandoned mid-stream);
 * falls back to the RDF/JS `DatasetCore.match` for a non-n3 dataset (correct, if eager).
 * This is the streaming primitive the bounded single-link resolver relies on.
 */
function* matchObjects(dataset: DatasetCore, subject: Term, predicate: Term): Generator<Term> {
  const lazy = (
    dataset as unknown as {
      readQuads?: (s: Term, p: Term, o: Term | null, g: Term | null) => Iterable<{ object: Term }>;
    }
  ).readQuads;
  if (typeof lazy === "function") {
    for (const q of lazy.call(dataset, subject, predicate, null, null)) yield q.object;
    return;
  }
  for (const q of dataset.match(subject, predicate, null, null)) yield q.object;
}

/**
 * A live set of http(s)-canonical IRIs over `(doc, predicate)`. Every boundary is
 * guarded so an IRI field's set can NEVER surface or store a non-http(s) /
 * non-canonical value, regardless of how the underlying RDF was written (design
 * §7.3 — the filter is applied to every IRI field, fail-closed). READS go through
 * {@link rawNamedNodeValues} (no throwing mapper); WRITES go through the vetted
 * `SetFrom` base (`NamedNodeFrom.string`). `add` canonicalises + drops non-http;
 * `delete` removes every backing member whose canonical form matches; iteration /
 * `has` / `size` / `forEach` expose only the canonical http members.
 */
function makeIriFilteredSet(doc: TermWrapper, predicate: string, base: Set<unknown>): Set<string> {
  const canonicalMembers = (): Set<string> => {
    const out = new Set<string>();
    for (const raw of rawNamedNodeValues(doc, predicate)) {
      const c = httpIriOrUndefined(raw);
      if (c !== undefined) out.add(c);
    }
    return out;
  };
  const filtered: Set<string> = {
    add(value: string) {
      const c = httpIriOrUndefined(value);
      if (c !== undefined) base.add(c);
      return filtered;
    },
    delete(value: string) {
      const c = httpIriOrUndefined(value);
      if (c === undefined) return false;
      let deleted = false;
      // Remove every backing member whose canonical form matches (a non-canonical
      // equivalent — e.g. `http://x.org` vs `http://x.org/` — is still removed).
      for (const raw of rawNamedNodeValues(doc, predicate)) {
        if (httpIriOrUndefined(raw) === c && base.delete(raw as unknown)) deleted = true;
      }
      return deleted;
    },
    has(value: string) {
      const c = httpIriOrUndefined(value);
      return c !== undefined && canonicalMembers().has(c);
    },
    clear() {
      for (const raw of rawNamedNodeValues(doc, predicate)) base.delete(raw as unknown);
    },
    forEach(callback, thisArg?) {
      for (const v of canonicalMembers()) callback.call(thisArg, v, v, filtered);
    },
    keys() {
      return canonicalMembers().keys();
    },
    values() {
      return canonicalMembers().values();
    },
    entries() {
      return canonicalMembers().entries();
    },
    [Symbol.iterator]() {
      return canonicalMembers()[Symbol.iterator]();
    },
    get size() {
      return canonicalMembers().size;
    },
    [Symbol.toStringTag]: "Set",
  } as Set<string>;
  return filtered;
}

/**
 * Whether a field carries a hard value guard (a datatype lexical / numeric
 * validator, or a numeric-range / string-length guard) that must be enforced on the
 * LIVE set's `add` + reads too — not only in the `build` path. The cosmetic
 * trim/dropBlank/sanitize guards stay build-time (their historical home).
 */
function setNeedsValueGuard(field: ManifestField, mapper: DatatypeMapper): boolean {
  // EVERY numeric field needs the guarded set: applyDatatypeValidity enforces the
  // finite-number / value-space check on the live `add` for ALL numeric datatypes
  // (incl. decimal/double/float, which have no numericValid but still must reject a
  // non-number member), matching the singleton + build-time set write paths. Every
  // DATE field does too: a non-Date / Invalid-Date member must drop on `add` (its
  // toISOString would throw the write), and a malformed stored literal on read.
  if (mapper.jsType === "number" || mapper.jsType === "date") return true;
  if (mapper.lexicalValid !== undefined || mapper.numericValid !== undefined) return true;
  const g = field.guards;
  return (
    g !== undefined &&
    (g.minInclusive !== undefined ||
      g.maxInclusive !== undefined ||
      g.minLength !== undefined ||
      g.nonBlank === true)
  );
}

/**
 * Wrap a live set so every `add` AND every read (iteration / has / size / forEach)
 * passes through the datatype + scalar guards fail-closed — a direct
 * `wrapper.field.add("P1W")` (xsd:duration) or `.add(0)` (minInclusive 1) can no
 * longer land an invalid member, and a pre-existing invalid member in untrusted pod
 * data is not surfaced on read. COMPOSES over any base set: for an IRI field it
 * wraps the http(s)-scheme-filtered set (from {@link makeIriFilteredSet}), so an IRI
 * set carrying both a scheme guard and a scalar guard (e.g. `minLength`) enforces
 * BOTH. For an IRI field `mapper` is `iriMapper` (no lexical/numeric validator), so
 * only the scalar guards apply here — the scheme filter is the wrapped base's job.
 */
function makeGuardedSet(
  doc: TermWrapper,
  predicate: string,
  base: Set<unknown>,
  field: ManifestField,
  mapper: DatatypeMapper,
): Set<unknown> {
  const iri = hasIriSchemeGuard(field);
  const guard = (value: unknown): unknown => {
    // For an IRI-scheme field, CANONICALISE first (strip padding, normalise) so the
    // scalar guards (e.g. minLength) evaluate the STORED canonical form, not the raw
    // padded input — otherwise a padded IRI could pass minLength then be stored short.
    const v = iri ? httpIriOrUndefined(value) : applyDatatypeValidity(mapper, value);
    return applyScalarGuards(field, v);
  };
  // Read members from the RAW dataset, mapping each object term inside `tryRead` so a
  // malformed member (e.g. a hostile literal on a numeric predicate that would make
  // the @rdfjs/wrapper mapper throw) is DROPPED fail-closed rather than aborting the
  // whole read (iteration / size / parse). Only guard-passing members surface, deduped.
  const validMembers = (): unknown[] => {
    const out: unknown[] = [];
    const seen = new Set<string>();
    const push = (mapped: unknown) => {
      const g = guard(mapped);
      if (g === undefined) return;
      // Dedup by VALUE. `String(date)` drops milliseconds (two distinct instants in
      // the same second would wrongly dedup), so a Date keys by its ISO instant.
      const key = g instanceof Date ? g.toISOString() : String(g);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(g);
    };
    if (iri) {
      for (const raw of rawNamedNodeValues(doc, predicate)) push(raw);
    } else {
      const pred = doc.factory.namedNode(predicate);
      for (const q of doc.dataset.match(doc as unknown as Term, pred, null, null)) {
        push(tryRead(() => mapper.as(new TermWrapper(q.object, doc.dataset, doc.factory))));
      }
    }
    return out;
  };
  const guarded: Set<unknown> = {
    add(value: unknown) {
      const g = guard(value);
      if (g !== undefined) base.add(g);
      return guarded;
    },
    delete(value: unknown) {
      const g = guard(value);
      if (g === undefined) return false;
      // Remove every stored member whose GUARDED (canonical) form matches — a
      // non-canonical equivalent (`<http://x.org>` vs `http://x.org/`, `"01"^^integer`
      // vs `1`, `"0.00000010"^^decimal` vs `1e-7`) is still deleted. `base.delete(g)`
      // would serialise only the CANONICAL literal and miss the stored quad, so the
      // raw dataset quads are scanned + compared by SameValueZero and deleted directly.
      let deleted = false;
      if (iri) {
        for (const raw of rawNamedNodeValues(doc, predicate)) {
          if (httpIriOrUndefined(raw) === g && base.delete(raw)) deleted = true;
        }
        return deleted;
      }
      const pred = doc.factory.namedNode(predicate);
      for (const q of [...doc.dataset.match(doc as unknown as Term, pred, null, null)]) {
        const mapped = tryRead(() =>
          mapper.as(new TermWrapper(q.object, doc.dataset, doc.factory)),
        );
        const gm = guard(mapped);
        if (gm !== undefined && sameValueZero(gm, g)) {
          doc.dataset.delete(q);
          deleted = true;
        }
      }
      return deleted;
    },
    has(value: unknown) {
      const g = guard(value);
      // Membership by the SAME equality `delete` uses ({@link sameValueZero}: a NaN
      // member matches `has(NaN)` like a native `Set`, and a `Date` compares by
      // INSTANT) — every read mints a fresh `Date` object, so `Array.includes`
      // (object identity for Dates) would report `false` for the very member that
      // `delete(sameInstant)` removes, making has/delete inconsistent.
      return g !== undefined && validMembers().some((m) => sameValueZero(m, g));
    },
    clear() {
      base.clear();
    },
    forEach(callback: (v: unknown, v2: unknown, s: Set<unknown>) => void, thisArg?: unknown) {
      for (const v of validMembers()) callback.call(thisArg, v, v, guarded);
    },
    keys() {
      return validMembers()[Symbol.iterator]();
    },
    values() {
      return validMembers()[Symbol.iterator]();
    },
    entries() {
      return validMembers()
        .map((v) => [v, v] as [unknown, unknown])
        [Symbol.iterator]();
    },
    [Symbol.iterator]() {
      return validMembers()[Symbol.iterator]();
    },
    get size() {
      return validMembers().length;
    },
    [Symbol.toStringTag]: "Set",
  } as Set<unknown>;
  return guarded;
}

/** Whether the predicate carries at least one object quad on `doc` (raw presence). */
function predicatePresent(doc: TermWrapper, predicate: string): boolean {
  const pred = doc.factory.namedNode(predicate);
  for (const _q of doc.dataset.match(doc as unknown as Term, pred, null, null)) return true;
  return false;
}

/** Read a single (non-set) field's value, applying read-side guards, fail-closed. */
function readSingle(doc: TermWrapper, plan: FieldPlan): unknown {
  const { field, mapper } = plan;
  const raw = tryRead(() => OptionalFrom.subjectPredicate(doc, field.predicate, mapper.as));
  // Normalise through the field's value filter — the http(s) scheme filter for an
  // IRI field, else the datatype lexical/numeric validity — THEN the scalar guards
  // (numeric range / string length). Both categories apply even to an IRI field
  // that carries a scalar guard (e.g. minLength), fail-closed.
  const normalise = (v: unknown): unknown =>
    hasIriSchemeGuard(field)
      ? applyScalarGuards(field, httpIriOrUndefined(v))
      : applyScalarGuards(field, applyDatatypeValidity(mapper, v));
  // A configured default is applied ONLY when the predicate is genuinely ABSENT. A
  // PRESENT value that is unreadable (the mapper threw ⇒ raw undefined) or fails
  // normalisation reads as undefined (fail-closed) — it is NOT masked by the default,
  // and it still triggers requiredFailClosed. The default itself is normalised too.
  if (!predicatePresent(doc, field.predicate)) {
    return field.default !== undefined ? normalise(field.default) : undefined;
  }
  return normalise(raw);
}

/** Live set for a set field (mutations write through @rdfjs/wrapper's SetFrom). */
function fieldSet(doc: TermWrapper, plan: FieldPlan): Set<unknown> {
  const { field, mapper } = plan;
  const base = SetFrom.subjectPredicate(
    doc,
    field.predicate,
    mapper.as as ITermAsValueMapping<unknown>,
    mapper.from as unknown as ITermFromValueMapping<unknown>,
  );
  // A field carrying a hard value guard (numeric/lexical datatype validity, numeric
  // range, string length, or — for an IRI field — a scalar guard on top of the scheme
  // filter) gets the guarded set, which enforces canonicalisation + those guards on
  // both `add` and reads. A plain IRI-scheme set (no scalar guard) keeps the lighter
  // iri-filtered set; everything else is the raw base.
  if (setNeedsValueGuard(field, mapper)) {
    return makeGuardedSet(doc, field.predicate, base as Set<unknown>, field, mapper);
  }
  if (hasIriSchemeGuard(field)) {
    return makeIriFilteredSet(doc, field.predicate, base as Set<unknown>) as Set<unknown>;
  }
  return base;
}

/** Write a single (non-set) field's value, applying write-side guards, fail-closed. */
function writeSingle(doc: TermWrapper, plan: FieldPlan, value: unknown): void {
  const { field, mapper } = plan;
  let v = value;
  if (field.kind === "iri") {
    // An IRI value must be a string; the scheme filter (when present) also
    // canonicalises. A non-string is dropped fail-closed BEFORE the scalar guards, so
    // it can never reach NamedNodeFrom.string or slip a minLength/nonBlank guard.
    if (hasIriSchemeGuard(field)) v = httpIriOrUndefined(v);
    else if (typeof v !== "string") v = undefined;
    v = applyScalarGuards(field, v); // scalar guards (e.g. minLength) apply to IRI writes too
    OptionalAs.object(
      doc,
      field.predicate,
      v as never,
      NamedNodeFrom.string as (value: never, f: DataFactory) => Term,
    );
    return;
  }
  // Literal field: sanitize a string value; DROP a non-string value fail-closed
  // (a mistyped value must never be coerced into garbage or throw the write). A
  // NARROWED-lexical datatype (e.g. xsd:duration) is NOT sanitized — sanitising first
  // would silently REPAIR an invalid value (`"PT30M\u0000"` → `"PT30M"`); it is
  // validated RAW by applyDatatypeValidity below, so an invalid input drops fail-closed.
  if (v !== undefined && mapper.jsType === "string") {
    v =
      typeof v === "string"
        ? mapper.lexicalValid !== undefined || field.guards?.sanitizeText === false
          ? v
          : sanitizeText(v)
        : undefined;
  }
  // Lexical validity (e.g. xsd:duration) + numeric-range / string-length guards.
  v = applyDatatypeValidity(mapper, v);
  v = applyScalarGuards(field, v);
  OptionalAs.object(
    doc,
    field.predicate,
    v as never,
    mapper.from as unknown as (value: never, f: DataFactory) => Term,
  );
}

function subjectIri(convention: "hash-it" | "self", resourceUrl: string): string {
  return convention === "hash-it" ? `${resourceUrl}#it` : resourceUrl;
}

/**
 * Build a Wrapper class that stamps `typeIris` (via `mark`) and installs a per-field
 * accessor for each plan (a live set for a set field; a guarded getter/setter for a
 * single field). Shared by the flat entity and by every composite node — so a node's
 * flat fields go through the exact same audited read/write path as a flat entity's.
 */
function makeWrapperClass(typeIris: string[], plans: FieldPlan[]): EntityWrapperConstructor {
  class Wrapper extends TermWrapper {
    get id(): string {
      return this.value;
    }
    get types(): Set<string> {
      return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
    }
    get isInstance(): boolean {
      const types = this.types;
      return typeIris.some((t) => types.has(t));
    }
    mark(): this {
      const types = this.types;
      for (const t of typeIris) types.add(t);
      return this;
    }
  }

  for (const plan of plans) {
    const { field } = plan;
    if (field.collection === "set") {
      Object.defineProperty(Wrapper.prototype, field.name, {
        get(this: TermWrapper) {
          return fieldSet(this, plan);
        },
        enumerable: true,
        configurable: true,
      });
    } else {
      Object.defineProperty(Wrapper.prototype, field.name, {
        get(this: TermWrapper) {
          return readSingle(this, plan);
        },
        set(this: TermWrapper, value: unknown) {
          writeSingle(this, plan, value);
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  return Wrapper as unknown as EntityWrapperConstructor;
}

/**
 * Write one flat field's value from `data` onto `doc` (the build per-field logic: set
 * members through the guarded set; a single value through {@link writeSingle}, applying
 * emptyStringDrop / defaultNow / materializeDefault). Shared by the flat + composite paths.
 */
function writeFlatField(doc: TermWrapper, plan: FieldPlan, data: EntityData): void {
  const { field, mapper } = plan;
  const raw = data[field.name];
  if (field.collection === "set") {
    const set = fieldSet(doc, plan);
    const members = Array.isArray(raw) ? raw : [];
    for (const member of members) {
      let m: unknown = member;
      if (field.guards?.trim && typeof m === "string") m = m.trim();
      if (field.guards?.dropBlank && (m === "" || m === undefined || m === null)) continue;
      // Sanitize LITERAL text members only; IRI members are canonicalised +
      // scheme-filtered by the filtered set's add (never sanitized as text).
      if (
        field.kind === "literal" &&
        mapper.jsType === "string" &&
        typeof m === "string" &&
        field.guards?.sanitizeText !== false &&
        mapper.lexicalValid === undefined // a narrowed-lexical member is validated RAW
      ) {
        m = sanitizeText(m);
      }
      // Datatype validity + numeric-range / string-length guards + IRI canonicalisation
      // are ALL applied by the guarded set's `add` (in the correct order), so a raw
      // member is handed straight to it.
      set.add(m);
    }
    return;
  }
  let v = raw;
  // emptyStringDrop drops ONLY an empty string (not a valid falsy 0 / false).
  if (field.kind === "literal" && field.guards?.emptyStringDrop && v === "") v = undefined;
  if (v === undefined && field.defaultNow) v = new Date();
  if (v === undefined && field.materializeDefault && field.default !== undefined) {
    v = field.default;
  }
  writeSingle(doc, plan, v);
}

/**
 * Read one flat field from `doc` into `data` (the parse per-field logic). Returns
 * `"reject"` when a `requiredFailClosed` single field is absent/unreadable (so the
 * caller fails the whole parse closed); `"ok"` otherwise. Shared by the flat + composite
 * paths, so a composite sub-node enforces its own MUSTs identically to a flat entity.
 */
function readFlatFieldInto(doc: TermWrapper, plan: FieldPlan, data: EntityData): "ok" | "reject" {
  const { field } = plan;
  if (field.collection === "set") {
    const members = [...fieldSet(doc, plan)];
    const arr = field.guards?.sortOnRead
      ? members.slice().sort((a, b) => String(a).localeCompare(String(b)))
      : members;
    if (arr.length > 0) data[field.name] = arr;
    return "ok";
  }
  const value = readSingle(doc, plan);
  if (value === undefined) {
    if (field.guards?.requiredFailClosed) return "reject";
    return "ok";
  }
  data[field.name] = value;
  return "ok";
}

/** The single write-IRI-link primitive — routes through @rdfjs/wrapper (never a hand-built triple). */
function writeIriLink(doc: TermWrapper, predicate: string, targetIri: string): void {
  OptionalAs.object(
    doc,
    predicate,
    targetIri as never,
    NamedNodeFrom.string as (value: never, f: DataFactory) => Term,
  );
}

/** Assemble the shared serialize / storeToTurtle / parseDocument members over build + parse. */
function assembleEntity(
  core: {
    name: string;
    typeIri: string;
    Wrapper: EntityWrapperConstructor;
    subject: (resourceUrl: string) => string;
    build: (resourceUrl: string, data: EntityData) => Store;
    parse: (resourceUrl: string, dataset: DatasetCore) => EntityData | undefined;
  },
  prefixes: Record<string, string>,
): ModelEntity {
  const storeToTurtle = (store: Store): Promise<string> => {
    const writer = new Writer({ prefixes: { ...prefixes } });
    writer.addQuads([...store]);
    return new Promise<string>((resolve, reject) => {
      writer.end((error, result) => (error ? reject(error) : resolve(result)));
    });
  };
  const serialize = (resourceUrl: string, data: EntityData): Promise<string> =>
    storeToTurtle(core.build(resourceUrl, data));
  const parseDocument = async (
    resourceUrl: string,
    body: string,
    contentType: string | null = "text/turtle",
  ): Promise<EntityData | undefined> => {
    const resolvedContentType = contentType ?? "text/turtle";
    const { parseRdf } = await import("@jeswr/fetch-rdf");
    const dataset = await parseRdf(body, resolvedContentType, { baseIRI: resourceUrl });
    return core.parse(resourceUrl, dataset);
  };
  return { ...core, serialize, storeToTurtle, parseDocument };
}

function makeEntity(
  entity: ManifestEntity,
  manifest: ModelManifest,
  factory: DataFactory,
): ModelEntity {
  const plans = entity.fields.map(planField);
  const Wrapper = makeWrapperClass(entity.typeIris, plans);

  const subject = (resourceUrl: string): string =>
    subjectIri(entity.subject.convention, resourceUrl);

  const build = (resourceUrl: string, data: EntityData): Store => {
    const store = new Store();
    const doc = new Wrapper(subject(resourceUrl), store, factory);
    doc.mark();
    for (const plan of plans) writeFlatField(doc, plan, data);
    return store;
  };

  const parse = (resourceUrl: string, dataset: DatasetCore): EntityData | undefined => {
    const doc = new Wrapper(subject(resourceUrl), dataset, factory);
    if (!doc.isInstance) return undefined;
    const data: EntityData = {};
    for (const plan of plans) {
      if (readFlatFieldInto(doc, plan, data) === "reject") return undefined;
    }
    return data;
  };

  return assembleEntity(
    { name: entity.name, typeIri: entity.typeIris[0] as string, Wrapper, subject, build, parse },
    manifest.prefixes,
  );
}

/** The resolved per-node runtime of a composite entity (mirrors a flat entity's plan). */
interface NodeRuntime {
  readonly node: ManifestNode;
  readonly Wrapper: EntityWrapperConstructor;
  /** Plans for the node's FLAT (non-nested) fields. */
  readonly plans: FieldPlan[];
  /** The node's outgoing `nested` link fields. */
  readonly nested: ManifestField[];
}

/**
 * A global fail-closed budget on sub-node parse ATTEMPTS per composite parse — a defensive
 * backstop against a pathological manifest tree. A single-valued nested link resolves to
 * at most one target (ambiguity is rejected up-front), so the graph-walk is linear in the
 * tree; a legitimate document visits O(nodes) sub-nodes. This ceiling is far above any real
 * composite, and exceeding it fails the parse closed (returns undefined) rather than looping.
 */
const MAX_NODE_VISITS = 10000;

/**
 * A per-link READ budget — the number of raw object terms the single-link resolver will
 * examine on one predicate before failing closed. A legitimate maxCount-1 link has one
 * object; this bound stops a hostile document from forcing a large scan/allocation with a
 * fan-out of duplicate / non-http / distinct objects on one predicate (the streaming
 * resolver stops at the second distinct target or this many reads, whichever comes first).
 */
const MAX_LINK_READS = 32;

interface NestedTargetResolution {
  /**
   * The link failed to resolve — ambiguous (>1 distinct target) or over the read budget.
   * The DISPOSITION is graded at the call site (SHACL G1 grading): a Violation-graded
   * (`requiredFailClosed`) link rejects the whole composite; an optional (Warning/Info)
   * link drops its field and admits.
   */
  readonly reject: boolean;
  /** The single canonical http(s) target, when resolved and unambiguous (else undefined). */
  readonly target?: string;
}

/**
 * Resolve the SINGLE target of a `nested` (maxCount-1) link FAIL-CLOSED, streaming the raw
 * object terms with EARLY exit — never materialising the full candidate list. A non-http(s)
 * / non-NamedNode object is skipped (never a link target); the instant a SECOND distinct
 * canonical http(s) target is seen the link is rejected as AMBIGUOUS; and if the raw object
 * reads exceed {@link MAX_LINK_READS} before resolving, the link is rejected (a hostile
 * fan-out on one predicate must not force unbounded work). Two lexical forms of the SAME
 * canonical target are NOT ambiguous (they resolve to one target). How a rejected link
 * affects the composite is decided by the CALLER per the link's grade (see
 * {@link NestedTargetResolution.reject}) — the resolver only reports the link failure.
 */
function resolveNestedTarget(doc: TermWrapper, predicate: string): NestedTargetResolution {
  const pred = doc.factory.namedNode(predicate);
  let target: string | undefined;
  let reads = 0;
  for (const object of matchObjects(doc.dataset, doc as unknown as Term, pred)) {
    if (++reads > MAX_LINK_READS) return { reject: true };
    if (object.termType !== "NamedNode") continue;
    const canon = httpIriOrUndefined(object.value);
    if (canon === undefined) continue;
    if (target === undefined) target = canon;
    else if (canon !== target) return { reject: true };
  }
  return { reject: false, target };
}

function makeCompositeEntity(
  entity: CompositeManifestEntity,
  manifest: ModelManifest,
  factory: DataFactory,
): ModelEntity {
  const runtimes = new Map<string, NodeRuntime>();
  for (const node of entity.nodes) {
    const plans = node.fields.filter((f) => f.kind !== "nested").map(planField);
    const nested = node.fields.filter((f) => f.kind === "nested");
    runtimes.set(node.name, {
      node,
      Wrapper: makeWrapperClass(node.typeIris, plans),
      plans,
      nested,
    });
  }
  const rootRt = runtimes.get(entity.root);
  // The validator guarantees the root resolves; this is a defence-in-depth assertion.
  if (!rootRt) throw new Error(`composite root "${entity.root}" has no node runtime`);

  const nodeIri = (rt: NodeRuntime, resourceUrl: string): string =>
    `${resourceUrl}#${rt.node.fragment}`;

  const subject = (resourceUrl: string): string => nodeIri(rootRt, resourceUrl);

  // Whether a node's subtree carries CONTENT on build — either supplied `data` OR a
  // build-time default that `writeFlatField` materialises even when the value is absent
  // (`defaultNow`, `materializeDefault` with a default). A node is materialised only when
  // its subtree has content, so an absent OPTIONAL sub-node leaves no bare typed shell —
  // but a node whose fields are wholly DEFAULTED still materialises (matching the flat
  // build path, so a required defaulted sub-node is never silently omitted).
  const subtreeHasData = (rt: NodeRuntime, data: EntityData): boolean => {
    for (const plan of rt.plans) {
      const { field } = plan;
      const v = data[field.name];
      if (v !== undefined && !(Array.isArray(v) && v.length === 0)) return true;
      if (field.defaultNow) return true;
      if (field.materializeDefault && field.default !== undefined) return true;
    }
    for (const nf of rt.nested) {
      const child = runtimes.get(nf.node as string);
      if (child && subtreeHasData(child, data)) return true;
    }
    return false;
  };

  const build = (resourceUrl: string, data: EntityData): Store => {
    const store = new Store();
    const buildNode = (rt: NodeRuntime, force: boolean): string | undefined => {
      if (!force && !subtreeHasData(rt, data)) return undefined;
      const iri = nodeIri(rt, resourceUrl);
      const doc = new rt.Wrapper(iri, store, factory);
      doc.mark();
      for (const plan of rt.plans) writeFlatField(doc, plan, data);
      for (const nf of rt.nested) {
        const child = runtimes.get(nf.node as string);
        if (!child) continue;
        const childIri = buildNode(child, false);
        if (childIri !== undefined) writeIriLink(doc, nf.predicate, childIri);
      }
      return iri;
    };
    buildNode(rootRt, true);
    return store;
  };

  const parse = (resourceUrl: string, dataset: DatasetCore): EntityData | undefined => {
    // Fail-closed budget on total sub-node parse attempts (bounds the graph-walk's
    // backtracking against a hostile document — see MAX_NODE_VISITS).
    let visits = 0;
    const parseNode = (rt: NodeRuntime, iri: string): EntityData | undefined => {
      if (++visits > MAX_NODE_VISITS) return undefined;
      const doc = new rt.Wrapper(iri, dataset, factory);
      // A node MUST carry its rdf:type — an untyped subject at a fragment is not a
      // conforming node (fail-closed cross-node type check).
      if (!doc.isInstance) return undefined;
      const data: EntityData = {};
      for (const plan of rt.plans) {
        if (readFlatFieldInto(doc, plan, data) === "reject") return undefined;
      }
      for (const nf of rt.nested) {
        const child = runtimes.get(nf.node as string);
        if (!child) continue;
        const required = nf.guards?.requiredFailClosed === true;
        // GRAPH-WALK: follow the ACTUAL link triple to the target subject (never assume
        // the fragment convention — an untrusted document may link anywhere). A nested
        // link is SINGLE-VALUED (maxCount 1 by construction — set-valued links are a
        // documented future feature); the bounded resolver streams the objects and FAILS
        // the LINK on ambiguity (>1 distinct target) OR an over-budget fan-out, without
        // materialising the full candidate list.
        //
        // DISPOSITION of any link-resolution failure is graded by the link's SHACL G1
        // grade: a Violation-graded (requiredFailClosed) link rejects the WHOLE
        // composite; a Warning/Info (optional) link DEGRADES — its field is dropped and
        // the composite admitted (an otherwise-usable document is never rejected over an
        // unresolvable optional link). The resolver's bounds themselves are unchanged.
        const link = resolveNestedTarget(doc, nf.predicate);
        if (link.reject) {
          if (required) return undefined;
          continue;
        }
        const childData = link.target !== undefined ? parseNode(child, link.target) : undefined;
        if (childData === undefined) {
          // Same grading: a Violation-graded cross-node MUST whose single target is
          // absent or non-conforming (fails its own guards / type check) rejects the
          // WHOLE composite. A Warning/Info link drops its sub-node's fields and admits.
          if (required) return undefined;
          continue;
        }
        // Merge the sub-node's flat fields into the composite projection. Field names are
        // globally unique across the composite (validator-enforced), so no clobber.
        Object.assign(data, childData);
      }
      return data;
    };
    return parseNode(rootRt, subject(resourceUrl));
  };

  return assembleEntity(
    {
      name: entity.name,
      typeIri: rootRt.node.typeIris[0] as string,
      Wrapper: rootRt.Wrapper,
      subject,
      build,
      parse,
    },
    manifest.prefixes,
  );
}

/**
 * Interpret a shape-manifest into a typed {@link Model}. The manifest is validated
 * FAIL-CLOSED first ({@link validateManifest}); an invalid manifest throws before
 * any accessor is installed.
 */
export function defineModel(input: unknown, options: DefineModelOptions = {}): Model {
  const manifest = validateManifest(input);
  const factory = options.factory ?? (N3DataFactory as unknown as DataFactory);
  const entities: Record<string, ModelEntity> = {};
  for (const entity of manifest.entities) {
    entities[entity.name] = isCompositeEntity(entity)
      ? makeCompositeEntity(entity, manifest, factory)
      : makeEntity(entity, manifest, factory);
  }
  return { manifest, prefixes: { ...manifest.prefixes }, entities };
}
