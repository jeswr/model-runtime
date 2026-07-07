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
  type ManifestEntity,
  type ManifestField,
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
 * A live set of http(s)-canonical IRIs backed by an @rdfjs/wrapper set. Every
 * boundary is guarded so an IRI field's set can NEVER surface or store a
 * non-http(s) / non-canonical value, regardless of how the underlying RDF was
 * written (design §7.3 — the filter is applied to every IRI field, fail-closed).
 * `add` canonicalises + drops non-http members; iteration / `has` / `size` /
 * `forEach` expose only the canonical http members present in the backing set.
 */
function makeIriFilteredSet(base: Set<unknown>): Set<string> {
  const canonicalMembers = (): Set<string> => {
    const out = new Set<string>();
    for (const m of base) {
      const c = httpIriOrUndefined(m as string | undefined);
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
      const byCanonical = c !== undefined && base.delete(c);
      return byCanonical || base.delete(value as unknown);
    },
    has(value: string) {
      const c = httpIriOrUndefined(value);
      return c !== undefined && canonicalMembers().has(c);
    },
    clear() {
      for (const m of [...base]) base.delete(m);
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

/** Read a single (non-set) field's value, applying read-side guards, fail-closed. */
function readSingle(doc: TermWrapper, plan: FieldPlan): unknown {
  const { field, mapper } = plan;
  const raw = tryRead(() => OptionalFrom.subjectPredicate(doc, field.predicate, mapper.as));
  if (hasIriSchemeGuard(field)) {
    return httpIriOrUndefined(raw as string | undefined);
  }
  if (raw === undefined && field.default !== undefined) return field.default;
  return raw;
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
  if (hasIriSchemeGuard(field)) {
    return makeIriFilteredSet(base as Set<unknown>) as Set<unknown>;
  }
  return base;
}

/** Write a single (non-set) field's value, applying write-side guards, fail-closed. */
function writeSingle(doc: TermWrapper, plan: FieldPlan, value: unknown): void {
  const { field, mapper } = plan;
  let v = value;
  if (field.kind === "iri") {
    if (hasIriSchemeGuard(field)) v = httpIriOrUndefined(v as string | undefined);
    OptionalAs.object(
      doc,
      field.predicate,
      v as never,
      NamedNodeFrom.string as (value: never, f: DataFactory) => Term,
    );
    return;
  }
  // Literal field: sanitize a string value; DROP a non-string value fail-closed
  // (a mistyped value must never be coerced into garbage or throw the write).
  if (v !== undefined && mapper.jsType === "string") {
    v =
      typeof v === "string"
        ? field.guards?.sanitizeText === false
          ? v
          : sanitizeText(v)
        : undefined;
  }
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

function makeEntity(
  entity: ManifestEntity,
  manifest: ModelManifest,
  factory: DataFactory,
): ModelEntity {
  const plans = entity.fields.map(planField);
  const typeIris = entity.typeIris;

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

  // Install per-field accessors from the manifest (data-driven, not per-field code).
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

  const WrapperCtor = Wrapper as unknown as EntityWrapperConstructor;

  function subject(resourceUrl: string): string {
    return subjectIri(entity.subject.convention, resourceUrl);
  }

  function build(resourceUrl: string, data: EntityData): Store {
    const store = new Store();
    const doc = new Wrapper(subject(resourceUrl), store, factory);
    doc.mark();
    for (const plan of plans) {
      const { field, mapper } = plan;
      const raw = data[field.name];
      if (field.collection === "set") {
        const set = fieldSet(doc, plan);
        const members = Array.isArray(raw) ? raw : [];
        for (const member of members) {
          // IRI-set members are canonicalised + filtered by the filtered set's add.
          if (field.kind === "iri") {
            set.add(member);
            continue;
          }
          let m: unknown = member;
          if (field.guards?.trim && typeof m === "string") m = m.trim();
          if (field.guards?.dropBlank && (m === "" || m === undefined || m === null)) continue;
          if (
            mapper.jsType === "string" &&
            typeof m === "string" &&
            field.guards?.sanitizeText !== false
          ) {
            m = sanitizeText(m);
          }
          set.add(m);
        }
        continue;
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
    return store;
  }

  function parse(resourceUrl: string, dataset: DatasetCore): EntityData | undefined {
    const doc = new Wrapper(subject(resourceUrl), dataset, factory);
    if (!doc.isInstance) return undefined;
    const data: EntityData = {};
    for (const plan of plans) {
      const { field } = plan;
      if (field.collection === "set") {
        const members = [...fieldSet(doc, plan)];
        const arr = field.guards?.sortOnRead
          ? members.slice().sort((a, b) => String(a).localeCompare(String(b)))
          : members;
        if (arr.length > 0) data[field.name] = arr;
        continue;
      }
      const value = readSingle(doc, plan);
      if (value === undefined) {
        if (field.guards?.requiredFailClosed) return undefined;
        continue;
      }
      data[field.name] = value;
    }
    return data;
  }

  function storeToTurtle(store: Store): Promise<string> {
    const writer = new Writer({ prefixes: { ...manifest.prefixes } });
    writer.addQuads([...store]);
    return new Promise<string>((resolve, reject) => {
      writer.end((error, result) => (error ? reject(error) : resolve(result)));
    });
  }

  function serialize(resourceUrl: string, data: EntityData): Promise<string> {
    return storeToTurtle(build(resourceUrl, data));
  }

  async function parseDocument(
    resourceUrl: string,
    body: string,
    contentType: string | null = "text/turtle",
  ): Promise<EntityData | undefined> {
    const resolvedContentType = contentType ?? "text/turtle";
    const { parseRdf } = await import("@jeswr/fetch-rdf");
    const dataset = await parseRdf(body, resolvedContentType, { baseIRI: resourceUrl });
    return parse(resourceUrl, dataset);
  }

  return {
    name: entity.name,
    typeIri: typeIris[0] as string,
    Wrapper: WrapperCtor,
    subject,
    build,
    parse,
    serialize,
    storeToTurtle,
    parseDocument,
  };
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
    entities[entity.name] = makeEntity(entity, manifest, factory);
  }
  return { manifest, prefixes: { ...manifest.prefixes }, entities };
}
