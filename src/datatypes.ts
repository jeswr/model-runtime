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
 * The value-space predicate for an integer subtype: integer-ness plus the sign
 * constraint the subtype names (`xsd:positiveInteger` > 0, `xsd:nonNegativeInteger`
 * ≥ 0, …). Plain `xsd:integer`/`int`/`long` require only integer-ness.
 */
// Bounded integer subtype ranges (local name → [min, max]). Unbounded subtypes
// (integer, long, unsignedLong, and the sign-only ones) are handled by sign checks
// + the safe-integer cap, not a fixed range.
const INT_SUBTYPE_RANGE: Record<string, [number, number]> = {
  int: [-2147483648, 2147483647],
  short: [-32768, 32767],
  byte: [-128, 127],
  unsignedInt: [0, 4294967295],
  unsignedShort: [0, 65535],
  unsignedByte: [0, 255],
};

function localOf(datatypeIri: string): string {
  return datatypeIri.startsWith(XSD) ? datatypeIri.slice(XSD.length) : datatypeIri;
}

function integerSubtypeValid(datatypeIri: string): (value: number) => boolean {
  const local = localOf(datatypeIri);
  return (value) => {
    // Reject non-integers AND anything outside JS's safe-integer range: an unsafe
    // integer would both lose precision and serialise in exponent form
    // (`String(1e21)` ⇒ "1e+21"), which is not a valid integer lexical.
    if (!Number.isSafeInteger(value)) return false;
    const range = INT_SUBTYPE_RANGE[local];
    if (range) return value >= range[0] && value <= range[1];
    switch (local) {
      case "positiveInteger":
        return value > 0;
      case "nonNegativeInteger":
      case "unsignedLong":
        return value >= 0;
      case "negativeInteger":
        return value < 0;
      case "nonPositiveInteger":
        return value <= 0;
      default:
        // xsd:integer / xsd:long — integer-ness + safe-range (already checked).
        return true;
    }
  };
}

/**
 * A datatype-CHECKED reader for `xsd:duration`: the term must be a `Literal` typed
 * `xsd:duration` (not a plain `xsd:string` that merely LOOKS like a duration) — else
 * it throws, so the read drops it fail-closed. Enforces the declared RDF datatype on
 * read the way `LiteralAs.number`/`boolean`/`date` do (which `LiteralAs.string`
 * does not), closing the type-confusion where a `"PT30M"^^xsd:string` surfaces.
 */
function durationAs(term: TermWrapper): string {
  const t = term as unknown as { termType: string; value: string; datatype?: { value: string } };
  if (t.termType !== "Literal") throw new Error("xsd:duration: term is not a Literal");
  if (t.datatype?.value !== `${XSD}duration`) {
    throw new Error("xsd:duration: term datatype is not xsd:duration");
  }
  return t.value;
}

/**
 * True for a lexically-valid `xsd:duration` (XSD 1.1). The week designator `P…W`
 * is REJECTED (XSD 1.1 duration excludes it, unlike ISO-8601) — this mirrors the
 * hand-written `triggerOffset` check in `@jeswr/solid-scheduling`. Requires at
 * least one component, and a `T` must be followed by at least one time component.
 */
export function isXsdDuration(value: string): boolean {
  // Only the SECONDS component is a decimal (xsd:decimal lexical) — it permits
  // `1.5`, `1.`, and `.5`; Y/M/D/H/M are unsigned integers.
  const m =
    /^-?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d*)?|\.\d+)S)?)?$/.exec(
      value,
    );
  if (m === null) return false;
  const hasDate = Boolean(m[1] || m[2] || m[3]);
  const hasTime = Boolean(m[4] || m[5] || m[6]);
  if (!hasDate && !hasTime) return false; // bare "P" / "-P"
  if (value.includes("T") && !hasTime) return false; // "PT" with no time component
  return true;
}

/**
 * A DATATYPE-PRESERVING `from` for an integer subtype: writes the number's lexical
 * form tagged with the field's DECLARED datatype IRI (e.g. `xsd:positiveInteger`),
 * NOT the generic `xsd:integer` that `LiteralFrom.integer` hard-codes. For plain
 * `xsd:integer` this is byte-identical to `LiteralFrom.integer`.
 */
function integerFrom(datatypeIri: string): (value: number, factory: DataFactory) => Term {
  return (value, factory) => factory.literal(String(value), factory.namedNode(datatypeIri));
}

/** A `from` that writes a string tagged with a specific datatype (e.g. duration). */
function typedStringFrom(datatypeIri: string): (value: string, factory: DataFactory) => Term {
  return (value, factory) => factory.literal(value, factory.namedNode(datatypeIri));
}

/**
 * Format a finite JS number as a NON-EXPONENT decimal string (a valid `xsd:decimal`
 * lexical). `Number.toString()` emits exponent form for small/large magnitudes
 * (`1e-7`, `1e+21`), which is invalid for `xsd:decimal`; this expands it. Trailing
 * fractional zeros are trimmed. Read acceptance stays lenient (any finite number);
 * only the WRITE lexical is made safe here.
 */
export function toPlainDecimalString(value: number): string {
  const s = value.toString();
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (m === null) return s; // already plain
  const sign = m[1] ?? "";
  const digits = (m[2] ?? "") + (m[3] ?? "");
  const pointPos = (m[2] ?? "").length + Number.parseInt(m[4] ?? "0", 10);
  let out: string;
  if (pointPos <= 0) out = `0.${"0".repeat(-pointPos)}${digits}`;
  else if (pointPos >= digits.length) out = digits + "0".repeat(pointPos - digits.length);
  else out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return sign + out;
}

/** A datatype-preserving `from` for `xsd:decimal` — always a non-exponent lexical. */
function decimalFrom(datatypeIri: string): (value: number, factory: DataFactory) => Term {
  return (value, factory) =>
    factory.literal(toPlainDecimalString(value), factory.namedNode(datatypeIri));
}

/**
 * A datatype-EXACT, lexically-validated reader for `xsd:double`/`xsd:float`. The term
 * must be a `Literal` typed with EXACTLY `datatypeIri` (so a narrower/other numeric
 * literal like `"1.5"^^xsd:integer` or `"-1"^^xsd:unsignedInt` does not surface
 * through a float/double field), and its lexical form must be a legal value or
 * `INF`/`-INF`/`NaN`. An invalid lexical (`"abc"`) or an overflowing one (`1e309`)
 * THROWS so the read drops it fail-closed instead of surfacing `NaN`/`Infinity`.
 */
function floatingAs(datatypeIri: string): (term: TermWrapper) => number {
  return (term) => {
    const t = term as unknown as { termType: string; value: string; datatype?: { value: string } };
    if (t.termType !== "Literal") throw new Error("float/double: term is not a Literal");
    if (t.datatype?.value !== datatypeIri) {
      throw new Error("float/double: term datatype does not match the field datatype");
    }
    const lex = t.value;
    if (lex === "INF") return Number.POSITIVE_INFINITY;
    if (lex === "-INF") return Number.NEGATIVE_INFINITY;
    if (lex === "NaN") return Number.NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(lex)) {
      throw new Error("float/double: invalid numeric lexical");
    }
    const n = Number(lex);
    // A finite-LOOKING lexical whose value overflows to ±Infinity (e.g. `1e309`) is
    // rejected fail-closed rather than surfacing as Infinity.
    if (!Number.isFinite(n)) throw new Error("float/double: lexical overflows to Infinity");
    return n;
  };
}

/** The largest finite magnitude representable as an IEEE-754 single (`xsd:float`). */
const XSD_FLOAT_MAX = 3.4028234663852886e38;

/** `xsd:float` value space: NaN / ±INF, or a finite value within the float32 range. */
function isXsdFloatValue(value: number): boolean {
  return !Number.isFinite(value) || Math.abs(value) <= XSD_FLOAT_MAX;
}

/** A datatype-preserving `from` for `xsd:double`/`xsd:float` (permits NaN/INF/-INF). */
function floatingFrom(datatypeIri: string): (value: number, factory: DataFactory) => Term {
  return (value, factory) => {
    let lexical: string;
    if (Number.isNaN(value)) lexical = "NaN";
    else if (value === Number.POSITIVE_INFINITY) lexical = "INF";
    else if (value === Number.NEGATIVE_INFINITY) lexical = "-INF";
    else lexical = String(value);
    return factory.literal(lexical, factory.namedNode(datatypeIri));
  };
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
    case `${XSD}short`:
    case `${XSD}byte`:
    case `${XSD}nonNegativeInteger`:
    case `${XSD}positiveInteger`:
    case `${XSD}nonPositiveInteger`:
    case `${XSD}negativeInteger`:
    case `${XSD}unsignedLong`:
    case `${XSD}unsignedInt`:
    case `${XSD}unsignedShort`:
    case `${XSD}unsignedByte`:
      // Datatype-PRESERVING: serialize with the DECLARED integer subtype IRI, and
      // enforce the subtype's value space so an invalid value is dropped (not tagged).
      return {
        as: LiteralAs.number,
        from: integerFrom(iri) as DatatypeMapper["from"],
        jsType: "number",
        numericValid: integerSubtypeValid(iri),
      };
    case `${XSD}decimal`:
      // xsd:decimal has NO infinities/NaN (numericValid rejects them). Its lexical
      // space forbids EXPONENT notation, so the write serialiser (`decimalFrom`)
      // expands to plain decimal — a small/large finite decimal round-trips validly.
      return {
        as: LiteralAs.number,
        from: decimalFrom(iri) as DatatypeMapper["from"],
        jsType: "number",
        numericValid: Number.isFinite,
      };
    case `${XSD}double`:
      // xsd:double PERMITS NaN/INF/-INF and covers the full JS number range. Reads use
      // a lexically-validated mapper so a malformed lexical drops instead of ⇒ NaN.
      return {
        as: floatingAs(iri),
        from: floatingFrom(iri) as DatatypeMapper["from"],
        jsType: "number",
      };
    case `${XSD}float`:
      // xsd:float is 32-bit — permits NaN/INF/-INF, but a finite value outside the
      // float32 magnitude range (e.g. 1e308) is invalid and dropped fail-closed.
      return {
        as: floatingAs(iri),
        from: floatingFrom(iri) as DatatypeMapper["from"],
        jsType: "number",
        numericValid: isXsdFloatValue,
      };
    case `${XSD}duration`:
      // Datatype-CHECKED read + CLOSED lexical validator (rejects the P…W week form).
      return {
        as: durationAs,
        from: typedStringFrom(iri) as DatatypeMapper["from"],
        jsType: "string",
        lexicalValid: isXsdDuration,
      };
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
  `${XSD}short`,
  `${XSD}byte`,
  `${XSD}nonNegativeInteger`,
  `${XSD}positiveInteger`,
  `${XSD}nonPositiveInteger`,
  `${XSD}negativeInteger`,
  `${XSD}unsignedLong`,
  `${XSD}unsignedInt`,
  `${XSD}unsignedShort`,
  `${XSD}unsignedByte`,
  `${XSD}decimal`,
  `${XSD}double`,
  `${XSD}float`,
  `${XSD}duration`,
]);

/** Expand an `xsd:local` shorthand to a full IRI; pass a full IRI through. */
export function expandDatatype(datatype: string): string {
  return datatype.startsWith("xsd:") ? `${XSD}${datatype.slice(4)}` : datatype;
}
