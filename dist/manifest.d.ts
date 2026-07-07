/**
 * The compiled shape-manifest — the runtime's ONLY input schema, and the
 * data-not-code boundary (design §7.1/§7.2). A manifest is pure data: flag / enum
 * / IRI / literal-list values, NEVER executable, regex-source, template, or
 * path-expression content. {@link validateManifest} enforces that boundary
 * FAIL-CLOSED before any interpretation runs — unknown keys are rejected, every
 * field is bounded by a hard cap, and field names are checked against a
 * reserved-name denylist so a hostile name can never shadow a prototype member.
 *
 * The schema is versioned and bound to the runtime MAJOR: a manifest built for a
 * different runtime major is rejected rather than mis-interpreted.
 */
/** The manifest schema version this runtime interprets. */
export declare const MANIFEST_VERSION: 1;
/** The runtime major the manifest must target (bound 1:1 to the package major). */
export declare const RUNTIME_MAJOR: 0;
/** Per-field guard flags — all pure data (enums / booleans), no computation. */
export interface ManifestFieldGuards {
    /** Filter + canonicalise IRI values through the http(s)-only lexical filter. */
    iriScheme?: "http-https";
    /** `parse` fails closed (returns undefined) when this field is absent. */
    requiredFailClosed?: boolean;
    /** `build` drops an empty-string value (the historical `|| undefined`). */
    emptyStringDrop?: boolean;
    /** Strip C0/C1 control chars from text writes (default ON for string fields). */
    sanitizeText?: boolean;
    /** Set member: trim surrounding whitespace before adding. */
    trim?: boolean;
    /** Set member: skip a blank (empty-after-trim) member. */
    dropBlank?: boolean;
    /** `parse` returns a set field's members sorted (stable projection). */
    sortOnRead?: boolean;
}
/** A literal scalar a manifest may carry (default value / `sh:in` member). */
export type ManifestScalar = string | number | boolean;
export interface ManifestField {
    /** The JS/TS accessor name (allowlisted charset, reserved-name-checked). */
    name: string;
    /** The full predicate IRI. */
    predicate: string;
    /** The RDF term kind of the value. */
    kind: "iri" | "literal";
    /** Present ⇒ the field is a live set; absent ⇒ a single value. */
    collection?: "set";
    /** Datatype IRI (or `xsd:` shorthand) — required for a literal field. */
    datatype?: string;
    minCount?: number;
    maxCount?: number;
    /** A literal default value applied on read/build (data, never computed). */
    default?: ManifestScalar;
    /** dateTime field: `build` defaults an absent value to the current instant. */
    defaultNow?: boolean;
    /** `build` always materialises `default` when the value is absent. */
    materializeDefault?: boolean;
    /** Closed enumeration (`sh:in`) — carried for typed unions; validated for caps. */
    in?: ManifestScalar[];
    guards?: ManifestFieldGuards;
}
export interface ManifestEntity {
    /** The entity name (also the generated Wrapper / TS type base name). */
    name: string;
    /** The `rdf:type` IRI(s) this entity is stamped with / recognised by. */
    typeIris: string[];
    /** Subject convention: `hash-it` ⇒ `${resourceUrl}#it`; `self` ⇒ `resourceUrl`. */
    subject: {
        convention: "hash-it" | "self";
    };
    fields: ManifestField[];
}
export interface ModelManifest {
    manifestVersion: typeof MANIFEST_VERSION;
    runtime: {
        name: string;
        major: number;
    };
    prefixes: Record<string, string>;
    entities: ManifestEntity[];
}
/** Thrown when a manifest fails the fail-closed validation. */
export declare class ManifestError extends Error {
    readonly name = "ManifestError";
}
/**
 * Parse + validate an untrusted value into a {@link ModelManifest}, FAIL-CLOSED.
 * Every failure throws {@link ManifestError}; nothing is coerced. Call this before
 * {@link defineModel} interprets a manifest (defineModel calls it internally).
 */
export declare function validateManifest(input: unknown): ModelManifest;
//# sourceMappingURL=manifest.d.ts.map