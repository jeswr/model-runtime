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
import { TermWrapper } from "@rdfjs/wrapper";
import { Store } from "n3";
import { type ModelManifest } from "./manifest.js";
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
export type EntityWrapperConstructor = new (term: string | Term, dataset: DatasetCore, factory: DataFactory) => EntityWrapper;
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
    parseDocument(resourceUrl: string, body: string, contentType?: string | null): Promise<EntityData | undefined>;
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
/**
 * Interpret a shape-manifest into a typed {@link Model}. The manifest is validated
 * FAIL-CLOSED first ({@link validateManifest}); an invalid manifest throws before
 * any accessor is installed.
 */
export declare function defineModel(input: unknown, options?: DefineModelOptions): Model;
//# sourceMappingURL=model.d.ts.map