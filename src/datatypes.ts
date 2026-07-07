// AUTHORED-BY Claude Opus 4.8
/**
 * Datatype → `@rdfjs/wrapper` mapper resolution. The manifest names a field's RDF
 * datatype (or IRI term kind); this module resolves it to the vetted
 * `LiteralAs`/`LiteralFrom` (and `NamedNodeAs`/`NamedNodeFrom`) mapper pair — the
 * only place the runtime binds a datatype to a conversion, so the mapping is
 * reviewed once. No datatype resolves to executable manifest content: the manifest
 * carries the datatype IRI (data), this table maps it to a library function.
 */

import type { DataFactory, Term } from "@rdfjs/types";
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  type TermWrapper,
} from "@rdfjs/wrapper";

export const XSD = "http://www.w3.org/2001/XMLSchema#";

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
export function literalMapper(datatypeIri: string): DatatypeMapper {
  const iri = expandDatatype(datatypeIri);
  switch (iri) {
    case `${XSD}string`:
    case `${XSD}normalizedString`:
    case `${XSD}token`:
    case `${XSD}anyURI`:
    case `${XSD}language`:
      return { as: LiteralAs.string, from: LiteralFrom.string, jsType: "string" };
    case `${XSD}boolean`:
      return { as: LiteralAs.boolean, from: LiteralFrom.boolean, jsType: "boolean" };
    case `${XSD}dateTime`:
      return { as: LiteralAs.date, from: LiteralFrom.dateTime, jsType: "date" };
    case `${XSD}date`:
      return { as: LiteralAs.date, from: LiteralFrom.date, jsType: "date" };
    case `${XSD}integer`:
    case `${XSD}int`:
    case `${XSD}long`:
    case `${XSD}nonNegativeInteger`:
    case `${XSD}positiveInteger`:
      return { as: LiteralAs.number, from: LiteralFrom.integer, jsType: "number" };
    case `${XSD}decimal`:
    case `${XSD}double`:
    case `${XSD}float`:
      return { as: LiteralAs.number, from: LiteralFrom.double, jsType: "number" };
    default:
      // Fall back to opaque string — carry the lexical value, never throw.
      return { as: LiteralAs.string, from: LiteralFrom.string, jsType: "string" };
  }
}

/** The mapper pair for an IRI-valued (named node) field. */
export function iriMapper(): DatatypeMapper {
  return { as: NamedNodeAs.string, from: NamedNodeFrom.string, jsType: "string" };
}

/** True for a datatype IRI this runtime has an explicit, non-fallback mapping for. */
export function isKnownDatatype(datatypeIri: string): boolean {
  const iri = expandDatatype(datatypeIri);
  return KNOWN_DATATYPES.has(iri);
}

const KNOWN_DATATYPES = new Set<string>([
  `${XSD}string`,
  `${XSD}normalizedString`,
  `${XSD}token`,
  `${XSD}anyURI`,
  `${XSD}language`,
  `${XSD}boolean`,
  `${XSD}dateTime`,
  `${XSD}date`,
  `${XSD}integer`,
  `${XSD}int`,
  `${XSD}long`,
  `${XSD}nonNegativeInteger`,
  `${XSD}positiveInteger`,
  `${XSD}decimal`,
  `${XSD}double`,
  `${XSD}float`,
]);

/** Expand an `xsd:local` shorthand to a full IRI; pass a full IRI through. */
export function expandDatatype(datatype: string): string {
  return datatype.startsWith("xsd:") ? `${XSD}${datatype.slice(4)}` : datatype;
}
