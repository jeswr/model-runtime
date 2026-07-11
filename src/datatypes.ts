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

/** Days in a (1-based) month, honouring leap years (for XSD calendar validity). */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// XSD lexical structure. Year is 4+ digits (optionally negative); month/day/hour/
// minute/second are exactly two digits; fractional seconds optional; timezone is
// `Z` or `±HH:MM`. Semantic (calendar / range) validity is checked separately.
const XSD_DATETIME_RE =
  /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const XSD_DATE_RE = /^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;

/** True for a legal `±HH:MM` / `Z` timezone designator (|offset| ≤ 14:00). */
function timezoneValid(tz: string | undefined): boolean {
  if (tz === undefined || tz === "Z") return true;
  const h = Number(tz.slice(1, 3));
  const m = Number(tz.slice(4, 6));
  if (m > 59) return false;
  return h < 14 || (h === 14 && m === 0);
}

/**
 * True for a lexically-valid `xsd:dateTime` (XSD 1.1), including CALENDAR validity
 * (month 1–12, day within the month, leap years) and the `24:00:00` end-of-day
 * form (hour 24 requires zero minutes/seconds). JS `new Date(...)` alone is NOT a
 * validator: V8 ROLLS OVER an out-of-range day (`2020-02-30` ⇒ Mar 1 — a silently
 * WRONG value) and accepts non-XSD prose like `"January 1 2020"`.
 */
export function isXsdDateTime(value: string): boolean {
  const m = XSD_DATETIME_RE.exec(value);
  if (m === null) return false;
  const [, year, month, day, hour, minute, second, fraction, tz] = m;
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(Number(year), mo)) return false;
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (h === 24) {
    // XSD permits 24:00:00 (the following midnight) with zero minutes/seconds only.
    if (mi !== 0 || s !== 0) return false;
    if (fraction !== undefined && Number(fraction) !== 0) return false;
  } else if (h > 23) return false;
  if (mi > 59 || s > 59) return false; // XSD has no leap seconds
  return timezoneValid(tz);
}

/** True for a lexically-valid `xsd:date` (XSD 1.1) — calendar-checked like dateTime. */
export function isXsdDate(value: string): boolean {
  const m = XSD_DATE_RE.exec(value);
  if (m === null) return false;
  const [, year, month, day, tz] = m;
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > daysInMonth(Number(year), mo)) return false;
  return timezoneValid(tz);
}

/**
 * A datatype-EXACT, lexically-validated reader for `xsd:dateTime` / `xsd:date` —
 * the date counterpart of {@link floatingAs}. The term must be a `Literal` typed
 * EXACTLY the field's declared datatype (an `xsd:date` literal does not surface
 * through a dateTime field, nor a look-alike `xsd:string`), its lexical form must
 * be XSD-valid ({@link isXsdDateTime} / {@link isXsdDate} — so a rolled-over
 * `2020-02-30` or JS-prose `"January 1 2020"` never surfaces a WRONG `Date`), and
 * the parsed `Date` must be time-valid. Any failure THROWS, so the read drops the
 * field fail-closed (`tryRead`) instead of surfacing an `Invalid Date` — aligning
 * malformed dateTime literals with every other malformed-literal drop; the field's
 * `requiredFailClosed` grading then decides admit/reject as usual.
 *
 * A lexically-valid value JS `Date` cannot represent (a negative/far year, or an
 * offset-timezoned `xsd:date`, which V8 refuses to parse) also drops fail-closed:
 * `Date` is the surface type, and a value it cannot faithfully carry must never
 * surface as `Invalid Date`.
 */
function dateAs(datatypeIri: string): (term: TermWrapper) => Date {
  const isDate = datatypeIri === `${XSD}date`;
  const lexicalValid = isDate ? isXsdDate : isXsdDateTime;
  return (term) => {
    const t = term as unknown as { termType: string; value: string; datatype?: { value: string } };
    if (t.termType !== "Literal") throw new Error("date/dateTime: term is not a Literal");
    if (t.datatype?.value !== datatypeIri) {
      throw new Error("date/dateTime: term datatype does not match the field datatype");
    }
    if (!lexicalValid(t.value)) throw new Error("date/dateTime: invalid XSD lexical");
    const d = new Date(t.value);
    if (!Number.isFinite(d.getTime())) {
      throw new Error("date/dateTime: value not representable as a JS Date");
    }
    if (isDate) {
      // V8's lenient parser can MISPARSE (not refuse) a lexically-valid date-only
      // form — `"0000-01-01Z"` ⇒ 2000-01-01 and `"-0001-01-01Z"` ⇒ 2001-01-01 (the
      // two-digit-year rule reached through the `Z` suffix) — a silently WRONG
      // value, the exact failure this reader exists to prevent. Cross-check the
      // parsed Date's UTC calendar date against the lexical's own fields; any
      // disagreement (or a non-UTC offset an engine someday accepts — the UTC
      // fields would not be the lexical's calendar date) drops fail-closed.
      const m = XSD_DATE_RE.exec(t.value);
      const tz = m?.[4];
      if (
        m === null ||
        (tz !== undefined && tz !== "Z") ||
        d.getUTCFullYear() !== Number(m[1]) ||
        d.getUTCMonth() + 1 !== Number(m[2]) ||
        d.getUTCDate() !== Number(m[3])
      ) {
        throw new Error("date: parsed Date does not match the xsd:date lexical");
      }
    }
    return d;
  };
}

/**
 * The UTC calendar-date fields of a time-valid `Date` as an XSD-form lexical
 * (`year-MM-DD`): the year is `-`-signed and padded to four digits (a wider year
 * carries its digits unpadded — XSD prohibits both a `+` sign and leading zeros
 * beyond four digits). `toISOString()` is NOT usable here: for an expanded or
 * negative year it emits the ECMAScript `±YYYYYY` form (`+275759-…`/`-000001-…`),
 * which is outside XSD's lexical space.
 */
function utcDateLexical(value: Date): string {
  const y = value.getUTCFullYear();
  const year = `${y < 0 ? "-" : ""}${String(Math.abs(y)).padStart(4, "0")}`;
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * A datatype-preserving `from` for `xsd:date`: writes the UTC calendar date
 * (`YYYY-MM-DDZ`) — a VALID `xsd:date` lexical for EVERY time-valid `Date`,
 * including expanded (`100000-01-01Z`) and negative (`-0001-01-01Z`) years, which
 * a naive `toISOString().slice(0, 10)` truncates into a MALFORMED `+275759-06Z`.
 * (`LiteralFrom.date` writes the full `toISOString()` dateTime lexical tagged
 * `xsd:date`, which is not in `xsd:date`'s lexical space and would (correctly)
 * fail the strict read-back.) Time-of-day is dropped — inherent to `xsd:date`'s
 * value space. A year-0 / negative-year lexical is written VALID but V8 cannot
 * faithfully re-parse it — the strict reader drops it fail-closed (see
 * {@link dateAs}) rather than surfacing a wrong value.
 */
function dateFrom(value: Date, factory: DataFactory): Term {
  return factory.literal(`${utcDateLexical(value)}Z`, factory.namedNode(`${XSD}date`));
}

/**
 * A datatype-preserving `from` for `xsd:dateTime`: writes the UTC instant
 * (`year-MM-DDTHH:MM:SS.mmmZ`, the year in XSD form via {@link utcDateLexical}) — a
 * VALID `xsd:dateTime` lexical for EVERY time-valid `Date`. `LiteralFrom.dateTime`
 * (a bare `toISOString()`) emits the ECMAScript expanded-year form for a wide or
 * negative year: `+275760-09-13T00:00:00.000Z` (`+`-signed — outside XSD's lexical
 * space, so the strict read-back rejected a value the write itself produced) and
 * `-000001-…` (a six-digit zero-padded year — XSD prohibits leading zeros beyond
 * four digits; it round-tripped only by riding V8's own leniency, and a conforming
 * XSD consumer rejects it). Years 0–9999 serialize byte-identically to
 * `toISOString()`. As with `xsd:date`, an expanded/negative-year lexical is written
 * VALID but V8 cannot faithfully re-parse the XSD dateTime form (it REFUSES —
 * `new Date("100000-01-01T…Z")` is an `Invalid Date`, never a misparse) — the
 * strict reader drops it fail-closed (see {@link dateAs}) rather than surfacing a
 * wrong value; an old-form `-000001-…` literal already in a store still reads.
 */
function dateTimeFrom(value: Date, factory: DataFactory): Term {
  const hours = String(value.getUTCHours()).padStart(2, "0");
  const minutes = String(value.getUTCMinutes()).padStart(2, "0");
  const seconds = String(value.getUTCSeconds()).padStart(2, "0");
  const millis = String(value.getUTCMilliseconds()).padStart(3, "0");
  return factory.literal(
    `${utcDateLexical(value)}T${hours}:${minutes}:${seconds}.${millis}Z`,
    factory.namedNode(`${XSD}dateTime`),
  );
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
      // Datatype-CHECKED + XSD-lexically-validated read (a malformed literal DROPS
      // fail-closed via tryRead — never an `Invalid Date`); the write emits a valid
      // xsd:dateTime lexical for EVERY time-valid Date (LiteralFrom.dateTime's bare
      // toISOString emits the malformed `+`-signed ECMAScript expanded-year form).
      return {
        as: dateAs(iri),
        from: dateTimeFrom as DatatypeMapper["from"],
        jsType: "date",
      };
    case `${XSD}date`:
      // Same strict read; the write emits a valid `YYYY-MM-DDZ` xsd:date lexical
      // (LiteralFrom.date would emit a full dateTime lexical, outside xsd:date's
      // lexical space).
      return {
        as: dateAs(iri),
        from: dateFrom as DatatypeMapper["from"],
        jsType: "date",
      };
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
