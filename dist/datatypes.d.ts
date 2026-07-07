/**
 * Datatype → `@rdfjs/wrapper` mapper resolution. The manifest names a field's RDF
 * datatype (or IRI term kind); this module resolves it to the vetted
 * `LiteralAs`/`LiteralFrom` (and `NamedNodeAs`/`NamedNodeFrom`) mapper pair — the
 * only place the runtime binds a datatype to a conversion, so the mapping is
 * reviewed once. No datatype resolves to executable manifest content: the manifest
 * carries the datatype IRI (data), this table maps it to a library function.
 */
import type { DataFactory, Term } from "@rdfjs/types";
import { type TermWrapper } from "@rdfjs/wrapper";
export declare const XSD = "http://www.w3.org/2001/XMLSchema#";
/** The JS surface type a datatype maps to (drives text-only guards like sanitize). */
export type JsType = "string" | "boolean" | "date" | "number";
export interface DatatypeMapper {
    /** Term → JS value (read). */
    readonly as: (term: TermWrapper) => unknown;
    /** JS value → term (write). */
    readonly from: (value: never, factory: DataFactory) => Term;
    /** The JS surface type (for text-only guard gating). */
    readonly jsType: JsType;
    /**
     * Closed LEXICAL validator for a string-mapped datatype whose lexical space is
     * narrower than plain string (e.g. `xsd:duration`). When present, a value whose
     * lexical form fails is DROPPED fail-closed on both read and write, never coerced.
     * A reviewed library predicate keyed by datatype — no executable manifest content.
     */
    readonly lexicalValid?: (value: string) => boolean;
    /**
     * Closed VALUE-SPACE validator for a numeric datatype whose value space is
     * narrower than the JS `number` surface (e.g. `xsd:positiveInteger` ⇒ integer > 0).
     * A number failing it is DROPPED fail-closed on read + write, so a datatype-
     * preserving write can never emit an out-of-value-space literal (e.g.
     * `"-1"^^xsd:positiveInteger`). Keyed by datatype — pure predicate, not manifest data.
     */
    readonly numericValid?: (value: number) => boolean;
}
/**
 * True for a lexically-valid `xsd:duration` (XSD 1.1). The week designator `P…W`
 * is REJECTED (XSD 1.1 duration excludes it, unlike ISO-8601) — this mirrors the
 * hand-written `triggerOffset` check in `@jeswr/solid-scheduling`. Requires at
 * least one component, and a `T` must be followed by at least one time component.
 */
export declare function isXsdDuration(value: string): boolean;
/**
 * Format a finite JS number as a NON-EXPONENT decimal string (a valid `xsd:decimal`
 * lexical). `Number.toString()` emits exponent form for small/large magnitudes
 * (`1e-7`, `1e+21`), which is invalid for `xsd:decimal`; this expands it. Trailing
 * fractional zeros are trimmed. Read acceptance stays lenient (any finite number);
 * only the WRITE lexical is made safe here.
 */
export declare function toPlainDecimalString(value: number): string;
/**
 * Resolve a full datatype IRI (or an `xsd:` shorthand) to a mapper pair for a
 * LITERAL field. Unknown datatypes fall back to the safe string mapping (the
 * value is carried as an opaque string literal) rather than throwing, so an
 * ontology using an exotic-but-string-shaped datatype still round-trips its
 * lexical value; callers that need strictness gate on {@link isKnownDatatype}.
 */
export declare function literalMapper(datatypeIri: string): DatatypeMapper;
/** The mapper pair for an IRI-valued (named node) field. */
export declare function iriMapper(): DatatypeMapper;
/** True for a datatype IRI this runtime has an explicit, non-fallback mapping for. */
export declare function isKnownDatatype(datatypeIri: string): boolean;
/** Expand an `xsd:local` shorthand to a full IRI; pass a full IRI through. */
export declare function expandDatatype(datatype: string): string;
//# sourceMappingURL=datatypes.d.ts.map