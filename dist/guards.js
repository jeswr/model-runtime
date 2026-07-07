// AUTHORED-BY Claude Opus 4.8
/**
 * The guard inventory — the single audited home for the untrusted-input filters
 * that the six hand-written `@jeswr` data-model packages each duplicated. Every
 * generated model interprets a manifest through these; no generated artifact
 * carries any of this logic itself (the data-not-code invariant, design §7.1).
 *
 * **Pure core, no platform.** This module depends only on the WHATWG `URL`
 * global (available in both Node and the browser) — no `node:*`, no DOM, no RDF
 * machinery — so it is client-safe and reads as a small spec.
 *
 * The `httpIriOrUndefined` / `isHttpIri` pair is the **injection-safe LEXICAL**
 * IRI filter (matching `@jeswr/rdf-serialize` and the solid-vc c77v decision): it
 * canonicalises via `URL.href` so no whitespace/control character can ride into
 * an emitted `NamedNode`, and it is carried verbatim from the reviewed reference
 * (`@jeswr/solid-bookmark`'s `src/iri.ts`) so behaviour is identical across the
 * suite.
 */
/**
 * The **canonical** absolute http(s) IRI for `value`, else `undefined` — the
 * recurring untrusted-input filter for an object-property value (drop a
 * non-http(s) value rather than coerce it into a malformed `NamedNode`). This is
 * the single canonicalization primitive; {@link isHttpIri} is defined in terms of
 * it so the boolean guard and the value filter can never disagree.
 *
 * Returns the parsed `URL.href`, NOT the raw input. This matters because WHATWG
 * `new URL()` TOLERATES (and strips) leading/trailing C0-control + space
 * characters and some tab/newline noise — so `"  https://x.org/a  "` and
 * `"https://x.org/a\n"` parse "OK" but the RAW string contains whitespace illegal
 * inside an RDF IRI. Returning `u.href` writes only the normalized, well-formed
 * IRI, so a hostile / sloppy input can never land an invalid `NamedNode` with
 * embedded whitespace on the wire.
 */
export function httpIriOrUndefined(value) {
    if (!value)
        return undefined;
    try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * True for an absolute `http(s)` URL that is ALREADY in its canonical form —
 * i.e. {@link httpIriOrUndefined}`(value) === value`. A narrowing type guard so
 * callers can use it in a `?:` without a cast.
 *
 * **Canonical-consistent (not just "parseable").** A value that WHATWG `URL`
 * normalizes — e.g. one with leading/trailing whitespace or control characters,
 * or `http://x.org` (no trailing slash) which `URL` rewrites to `http://x.org/`
 * — returns `false` here, because the RAW string is NOT a well-formed RDF IRI
 * that should be written verbatim. This keeps the boolean guard and the
 * value-returning {@link httpIriOrUndefined} in lock-step: `isHttpIri(v)` is true
 * exactly when `v` may be written through unchanged. Pod data is untrusted input
 * (a `javascript:`/`data:` URL is a stored-XSS / open surface); when you need the
 * usable, normalized value, prefer {@link httpIriOrUndefined}.
 */
export function isHttpIri(value) {
    return value !== undefined && httpIriOrUndefined(value) === value;
}
// C0/C1 control characters, EXCEPT the legal literal whitespace tab (0x09),
// line feed (0x0A) and carriage return (0x0D) which are preserved.
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matching C0/C1 controls to strip them.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/**
 * Strip C0/C1 control characters from an untrusted text literal that is about to
 * be written to RDF — a stored-XSS / log-injection / Turtle-noise guard applied
 * to every text write by default. `\t` (0x09), `\n` (0x0A) and `\r` (0x0D) are
 * PRESERVED (they are legal, meaningful whitespace inside a literal — markdown
 * notes, multi-line descriptions); every other C0 char (0x00–0x1F) and every C1
 * char (0x7F–0x9F) is removed. Returns the value unchanged when it is already
 * clean, so a well-formed literal round-trips byte-for-byte.
 */
export function sanitizeText(value) {
    return value.replace(CONTROL_CHARS, "");
}
/**
 * Run a term→value read and fail CLOSED: if the read throws (a malformed literal
 * in untrusted pod data — e.g. an `xsd:boolean` typed accessor over a literal
 * whose lexical value is not a boolean), the field is DROPPED (returns
 * `undefined`) rather than aborting the whole parse. This is the per-predicate
 * `tryRead` isolation the hand-written packages each re-implemented.
 */
export function tryRead(read) {
    try {
        return read();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=guards.js.map