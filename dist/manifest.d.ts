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
    /** Numeric lower bound (`sh:minInclusive`) — a number value below it is dropped. */
    minInclusive?: number;
    /** Numeric upper bound (`sh:maxInclusive`) — a number value above it is dropped. */
    maxInclusive?: number;
    /** Minimum string length (`sh:minLength`) — a shorter string value is dropped. */
    minLength?: number;
    /** Singleton non-blank string: a blank (whitespace-only / empty) value is dropped. */
    nonBlank?: boolean;
}
/** A literal scalar a manifest may carry (default value / `sh:in` member). */
export type ManifestScalar = string | number | boolean;
export interface ManifestField {
    /** The JS/TS accessor name (allowlisted charset, reserved-name-checked). */
    name: string;
    /** The full predicate IRI. */
    predicate: string;
    /**
     * The RDF term kind of the value. `iri` / `literal` are FLAT (single-node) fields;
     * `nested` is a COMPOSITE structural link — a single-valued object-property edge from
     * this node to a named sub-node (see {@link ManifestField.node}). A `nested` field
     * carries NO data value in the flat projection; it only drives the graph-walk (build
     * writes the link triple to the sub-node's fragment IRI; parse follows it, enforcing
     * the sub-node's own guards). It may carry only `requiredFailClosed` (the cross-node
     * MUST) — never a datatype / collection / enum / default.
     */
    kind: "iri" | "literal" | "nested";
    /** For a `nested` field: the name of the target sub-node within the composite. */
    node?: string;
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
    /** Discriminator — a FLAT (single-node) entity. Absent is treated as `"flat"`. */
    kind?: "flat";
    /** The `rdf:type` IRI(s) this entity is stamped with / recognised by. */
    typeIris: string[];
    /** Subject convention: `hash-it` ⇒ `${resourceUrl}#it`; `self` ⇒ `resourceUrl`. */
    subject: {
        convention: "hash-it" | "self";
    };
    fields: ManifestField[];
}
/**
 * One node of a COMPOSITE (document-projection) entity — a mini single-node with its
 * own `rdf:type`(s), document fragment, and flat + nested field set. The node's IRI in
 * a document at `resourceUrl` is `${resourceUrl}#${fragment}`. A composite is a TREE of
 * these: the root plus one sub-node per `nested` link (each non-root node has exactly
 * one incoming link; the graph is acyclic and spans every node).
 */
export interface ManifestNode {
    /** The node name — unique within the composite; referenced by `nested` fields. */
    name: string;
    /** The `rdf:type` IRI(s) this node is stamped with / recognised by. */
    typeIris: string[];
    /** The document fragment (e.g. `it`, `track`) — the node IRI is `${resourceUrl}#${fragment}`. */
    fragment: string;
    /** The node's flat (`iri`/`literal`) fields plus its outgoing `nested` link fields. */
    fields: ManifestField[];
}
/**
 * A COMPOSITE (document-projection) entity — a ROOT node plus named SUB-NODES, all
 * written into ONE document at conventional fragment IRIs and projected as ONE flat
 * object (field names are globally unique across the nodes). `build` writes every node
 * and links them; `parse` GRAPH-WALKS from the root, enforcing each sub-node's
 * fail-closed guards — a Violation-graded (`requiredFailClosed`) cross-node link whose
 * target sub-node does not conform rejects the WHOLE composite (the security-critical
 * untrusted-document validation the hand-written multi-node models carry).
 */
export interface CompositeManifestEntity {
    /** The entity name (also the generated Wrapper / TS type base name). */
    name: string;
    /** Discriminator — a composite (multi-node) entity. */
    kind: "composite";
    /** The name of the ROOT node (the build / parse entry point) — must be in `nodes`. */
    root: string;
    /** The nodes of the composite (the root plus its sub-nodes). */
    nodes: ManifestNode[];
}
/** A manifest entity — a flat single-node entity or a composite document projection. */
export type AnyManifestEntity = ManifestEntity | CompositeManifestEntity;
/** Type guard — narrows an entity to the composite (document-projection) variant. */
export declare function isCompositeEntity(entity: AnyManifestEntity): entity is CompositeManifestEntity;
export interface ModelManifest {
    manifestVersion: typeof MANIFEST_VERSION;
    runtime: {
        name: string;
        major: number;
    };
    prefixes: Record<string, string>;
    entities: AnyManifestEntity[];
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