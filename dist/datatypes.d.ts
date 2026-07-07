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
}
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