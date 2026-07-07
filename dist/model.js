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
import { NamedNodeAs, NamedNodeFrom, OptionalAs, OptionalFrom, SetFrom, TermWrapper, } from "@rdfjs/wrapper";
import { DataFactory as N3DataFactory, Store, Writer } from "n3";
import { iriMapper, literalMapper } from "./datatypes.js";
import { httpIriOrUndefined, sanitizeText, tryRead } from "./guards.js";
import { validateManifest, } from "./manifest.js";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
function planField(field) {
    const mapper = field.kind === "iri" ? iriMapper() : literalMapper(field.datatype);
    return { field, mapper };
}
/** Whether a field is an IRI field carrying the http(s)-only scheme guard. */
function hasIriSchemeGuard(field) {
    return field.kind === "iri" && field.guards?.iriScheme === "http-https";
}
/** SameValueZero equality (native `Set` semantics: NaN matches NaN; +0 matches -0). */
function sameValueZero(a, b) {
    return (a === b ||
        (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)));
}
/**
 * Apply the CLOSED, DATA-ONLY value guards (numeric range + string length /
 * non-blank) fail-closed: a value violating a guard is DROPPED (→ `undefined`),
 * never coerced. Numbers are gated by `minInclusive`/`maxInclusive`; strings by
 * `minLength` and the singleton `nonBlank` (whitespace-only) drop. Applied on every
 * read, write, and set-member boundary regardless of the value's provenance.
 */
function applyScalarGuards(field, value) {
    const g = field.guards;
    if (g === undefined)
        return value;
    if (typeof value === "number") {
        const hasRange = g.minInclusive !== undefined || g.maxInclusive !== undefined;
        // NaN is unordered — both comparisons are false, so it would slip a range guard;
        // reject it explicitly when any range bound is declared (fail-closed).
        if (hasRange && Number.isNaN(value))
            return undefined;
        if (g.minInclusive !== undefined && value < g.minInclusive)
            return undefined;
        if (g.maxInclusive !== undefined && value > g.maxInclusive)
            return undefined;
    }
    if (typeof value === "string") {
        // minLength counts Unicode CODE POINTS (not UTF-16 code units) to match
        // SHACL/XSD character-length semantics for astral characters.
        if (g.minLength !== undefined && [...value].length < g.minLength)
            return undefined;
        if (g.nonBlank === true && value.trim() === "")
            return undefined;
    }
    return value;
}
/**
 * Drop a value that does not conform to its datatype's narrowed value space, fail-
 * closed on every read + write + set-member boundary:
 *   - a NUMERIC field requires a `number` — a non-number (e.g. the STRING `"-1"`) is
 *     dropped, so it can never be serialized as a typed numeric literal
 *     (`"-1"^^xsd:positiveInteger`) — then the datatype's value space is enforced by
 *     its `numericValid` (integer subtypes: safe-integer + sign/range; decimal:
 *     finite; float/double: any number, incl. the permitted NaN/INF/-INF);
 *   - a string outside a `lexicalValid` lexical space (e.g. `xsd:duration`) is dropped.
 */
function applyDatatypeValidity(mapper, value) {
    if (value === undefined)
        return undefined;
    if (mapper.jsType === "number") {
        if (typeof value !== "number")
            return undefined;
        if (mapper.numericValid && !mapper.numericValid(value))
            return undefined;
        return value;
    }
    if (mapper.jsType === "string") {
        // A string-mapped field requires a string — a non-string (e.g. `set.add(123)` on
        // an xsd:duration set) is dropped fail-closed rather than reaching the serializer.
        if (typeof value !== "string")
            return undefined;
        if (mapper.lexicalValid && !mapper.lexicalValid(value))
            return undefined;
        return value;
    }
    return value;
}
/**
 * The raw NamedNode object VALUES of `(doc, predicate, *)`, read straight from the
 * dataset — NOT through a mapper. Non-NamedNode objects (a literal / blank node
 * planted on an IRI predicate by hostile pod data) are SKIPPED, so a malformed
 * term can never throw the read (fail-closed); the @rdfjs/wrapper `NamedNodeAs`
 * mapper would throw on such a term, so the filtered set must not use it for reads.
 */
function rawNamedNodeValues(doc, predicate) {
    const pred = doc.factory.namedNode(predicate);
    const out = [];
    for (const q of doc.dataset.match(doc, pred, null, null)) {
        if (q.object.termType === "NamedNode")
            out.push(q.object.value);
    }
    return out;
}
/**
 * A live set of http(s)-canonical IRIs over `(doc, predicate)`. Every boundary is
 * guarded so an IRI field's set can NEVER surface or store a non-http(s) /
 * non-canonical value, regardless of how the underlying RDF was written (design
 * §7.3 — the filter is applied to every IRI field, fail-closed). READS go through
 * {@link rawNamedNodeValues} (no throwing mapper); WRITES go through the vetted
 * `SetFrom` base (`NamedNodeFrom.string`). `add` canonicalises + drops non-http;
 * `delete` removes every backing member whose canonical form matches; iteration /
 * `has` / `size` / `forEach` expose only the canonical http members.
 */
function makeIriFilteredSet(doc, predicate, base) {
    const canonicalMembers = () => {
        const out = new Set();
        for (const raw of rawNamedNodeValues(doc, predicate)) {
            const c = httpIriOrUndefined(raw);
            if (c !== undefined)
                out.add(c);
        }
        return out;
    };
    const filtered = {
        add(value) {
            const c = httpIriOrUndefined(value);
            if (c !== undefined)
                base.add(c);
            return filtered;
        },
        delete(value) {
            const c = httpIriOrUndefined(value);
            if (c === undefined)
                return false;
            let deleted = false;
            // Remove every backing member whose canonical form matches (a non-canonical
            // equivalent — e.g. `http://x.org` vs `http://x.org/` — is still removed).
            for (const raw of rawNamedNodeValues(doc, predicate)) {
                if (httpIriOrUndefined(raw) === c && base.delete(raw))
                    deleted = true;
            }
            return deleted;
        },
        has(value) {
            const c = httpIriOrUndefined(value);
            return c !== undefined && canonicalMembers().has(c);
        },
        clear() {
            for (const raw of rawNamedNodeValues(doc, predicate))
                base.delete(raw);
        },
        forEach(callback, thisArg) {
            for (const v of canonicalMembers())
                callback.call(thisArg, v, v, filtered);
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
    };
    return filtered;
}
/**
 * Whether a field carries a hard value guard (a datatype lexical / numeric
 * validator, or a numeric-range / string-length guard) that must be enforced on the
 * LIVE set's `add` + reads too — not only in the `build` path. The cosmetic
 * trim/dropBlank/sanitize guards stay build-time (their historical home).
 */
function setNeedsValueGuard(field, mapper) {
    // EVERY numeric field needs the guarded set: applyDatatypeValidity enforces the
    // finite-number / value-space check on the live `add` for ALL numeric datatypes
    // (incl. decimal/double/float, which have no numericValid but still must reject a
    // non-number member), matching the singleton + build-time set write paths.
    if (mapper.jsType === "number")
        return true;
    if (mapper.lexicalValid !== undefined || mapper.numericValid !== undefined)
        return true;
    const g = field.guards;
    return (g !== undefined &&
        (g.minInclusive !== undefined ||
            g.maxInclusive !== undefined ||
            g.minLength !== undefined ||
            g.nonBlank === true));
}
/**
 * Wrap a live set so every `add` AND every read (iteration / has / size / forEach)
 * passes through the datatype + scalar guards fail-closed — a direct
 * `wrapper.field.add("P1W")` (xsd:duration) or `.add(0)` (minInclusive 1) can no
 * longer land an invalid member, and a pre-existing invalid member in untrusted pod
 * data is not surfaced on read. COMPOSES over any base set: for an IRI field it
 * wraps the http(s)-scheme-filtered set (from {@link makeIriFilteredSet}), so an IRI
 * set carrying both a scheme guard and a scalar guard (e.g. `minLength`) enforces
 * BOTH. For an IRI field `mapper` is `iriMapper` (no lexical/numeric validator), so
 * only the scalar guards apply here — the scheme filter is the wrapped base's job.
 */
function makeGuardedSet(doc, predicate, base, field, mapper) {
    const iri = hasIriSchemeGuard(field);
    const guard = (value) => {
        // For an IRI-scheme field, CANONICALISE first (strip padding, normalise) so the
        // scalar guards (e.g. minLength) evaluate the STORED canonical form, not the raw
        // padded input — otherwise a padded IRI could pass minLength then be stored short.
        const v = iri ? httpIriOrUndefined(value) : applyDatatypeValidity(mapper, value);
        return applyScalarGuards(field, v);
    };
    // Read members from the RAW dataset, mapping each object term inside `tryRead` so a
    // malformed member (e.g. a hostile literal on a numeric predicate that would make
    // the @rdfjs/wrapper mapper throw) is DROPPED fail-closed rather than aborting the
    // whole read (iteration / size / parse). Only guard-passing members surface, deduped.
    const validMembers = () => {
        const out = [];
        const seen = new Set();
        const push = (mapped) => {
            const g = guard(mapped);
            if (g === undefined)
                return;
            const key = String(g);
            if (seen.has(key))
                return;
            seen.add(key);
            out.push(g);
        };
        if (iri) {
            for (const raw of rawNamedNodeValues(doc, predicate))
                push(raw);
        }
        else {
            const pred = doc.factory.namedNode(predicate);
            for (const q of doc.dataset.match(doc, pred, null, null)) {
                push(tryRead(() => mapper.as(new TermWrapper(q.object, doc.dataset, doc.factory))));
            }
        }
        return out;
    };
    const guarded = {
        add(value) {
            const g = guard(value);
            if (g !== undefined)
                base.add(g);
            return guarded;
        },
        delete(value) {
            const g = guard(value);
            if (g === undefined)
                return false;
            // Remove every stored member whose GUARDED (canonical) form matches — a
            // non-canonical equivalent (`<http://x.org>` vs `http://x.org/`, `"01"^^integer`
            // vs `1`, `"0.00000010"^^decimal` vs `1e-7`) is still deleted. `base.delete(g)`
            // would serialise only the CANONICAL literal and miss the stored quad, so the
            // raw dataset quads are scanned + compared by SameValueZero and deleted directly.
            let deleted = false;
            if (iri) {
                for (const raw of rawNamedNodeValues(doc, predicate)) {
                    if (httpIriOrUndefined(raw) === g && base.delete(raw))
                        deleted = true;
                }
                return deleted;
            }
            const pred = doc.factory.namedNode(predicate);
            for (const q of [...doc.dataset.match(doc, pred, null, null)]) {
                const mapped = tryRead(() => mapper.as(new TermWrapper(q.object, doc.dataset, doc.factory)));
                const gm = guard(mapped);
                if (gm !== undefined && sameValueZero(gm, g)) {
                    doc.dataset.delete(q);
                    deleted = true;
                }
            }
            return deleted;
        },
        has(value) {
            const g = guard(value);
            // `Array.includes` uses SameValueZero, so a NaN member (valid for xsd:double)
            // matches `has(NaN)`, mirroring native `Set` semantics (unlike `===`).
            return g !== undefined && validMembers().includes(g);
        },
        clear() {
            base.clear();
        },
        forEach(callback, thisArg) {
            for (const v of validMembers())
                callback.call(thisArg, v, v, guarded);
        },
        keys() {
            return validMembers()[Symbol.iterator]();
        },
        values() {
            return validMembers()[Symbol.iterator]();
        },
        entries() {
            return validMembers()
                .map((v) => [v, v])[Symbol.iterator]();
        },
        [Symbol.iterator]() {
            return validMembers()[Symbol.iterator]();
        },
        get size() {
            return validMembers().length;
        },
        [Symbol.toStringTag]: "Set",
    };
    return guarded;
}
/** Whether the predicate carries at least one object quad on `doc` (raw presence). */
function predicatePresent(doc, predicate) {
    const pred = doc.factory.namedNode(predicate);
    for (const _q of doc.dataset.match(doc, pred, null, null))
        return true;
    return false;
}
/** Read a single (non-set) field's value, applying read-side guards, fail-closed. */
function readSingle(doc, plan) {
    const { field, mapper } = plan;
    const raw = tryRead(() => OptionalFrom.subjectPredicate(doc, field.predicate, mapper.as));
    // Normalise through the field's value filter — the http(s) scheme filter for an
    // IRI field, else the datatype lexical/numeric validity — THEN the scalar guards
    // (numeric range / string length). Both categories apply even to an IRI field
    // that carries a scalar guard (e.g. minLength), fail-closed.
    const normalise = (v) => hasIriSchemeGuard(field)
        ? applyScalarGuards(field, httpIriOrUndefined(v))
        : applyScalarGuards(field, applyDatatypeValidity(mapper, v));
    // A configured default is applied ONLY when the predicate is genuinely ABSENT. A
    // PRESENT value that is unreadable (the mapper threw ⇒ raw undefined) or fails
    // normalisation reads as undefined (fail-closed) — it is NOT masked by the default,
    // and it still triggers requiredFailClosed. The default itself is normalised too.
    if (!predicatePresent(doc, field.predicate)) {
        return field.default !== undefined ? normalise(field.default) : undefined;
    }
    return normalise(raw);
}
/** Live set for a set field (mutations write through @rdfjs/wrapper's SetFrom). */
function fieldSet(doc, plan) {
    const { field, mapper } = plan;
    const base = SetFrom.subjectPredicate(doc, field.predicate, mapper.as, mapper.from);
    // A field carrying a hard value guard (numeric/lexical datatype validity, numeric
    // range, string length, or — for an IRI field — a scalar guard on top of the scheme
    // filter) gets the guarded set, which enforces canonicalisation + those guards on
    // both `add` and reads. A plain IRI-scheme set (no scalar guard) keeps the lighter
    // iri-filtered set; everything else is the raw base.
    if (setNeedsValueGuard(field, mapper)) {
        return makeGuardedSet(doc, field.predicate, base, field, mapper);
    }
    if (hasIriSchemeGuard(field)) {
        return makeIriFilteredSet(doc, field.predicate, base);
    }
    return base;
}
/** Write a single (non-set) field's value, applying write-side guards, fail-closed. */
function writeSingle(doc, plan, value) {
    const { field, mapper } = plan;
    let v = value;
    if (field.kind === "iri") {
        // An IRI value must be a string; the scheme filter (when present) also
        // canonicalises. A non-string is dropped fail-closed BEFORE the scalar guards, so
        // it can never reach NamedNodeFrom.string or slip a minLength/nonBlank guard.
        if (hasIriSchemeGuard(field))
            v = httpIriOrUndefined(v);
        else if (typeof v !== "string")
            v = undefined;
        v = applyScalarGuards(field, v); // scalar guards (e.g. minLength) apply to IRI writes too
        OptionalAs.object(doc, field.predicate, v, NamedNodeFrom.string);
        return;
    }
    // Literal field: sanitize a string value; DROP a non-string value fail-closed
    // (a mistyped value must never be coerced into garbage or throw the write). A
    // NARROWED-lexical datatype (e.g. xsd:duration) is NOT sanitized — sanitising first
    // would silently REPAIR an invalid value (`"PT30M\u0000"` → `"PT30M"`); it is
    // validated RAW by applyDatatypeValidity below, so an invalid input drops fail-closed.
    if (v !== undefined && mapper.jsType === "string") {
        v =
            typeof v === "string"
                ? mapper.lexicalValid !== undefined || field.guards?.sanitizeText === false
                    ? v
                    : sanitizeText(v)
                : undefined;
    }
    // Lexical validity (e.g. xsd:duration) + numeric-range / string-length guards.
    v = applyDatatypeValidity(mapper, v);
    v = applyScalarGuards(field, v);
    OptionalAs.object(doc, field.predicate, v, mapper.from);
}
function subjectIri(convention, resourceUrl) {
    return convention === "hash-it" ? `${resourceUrl}#it` : resourceUrl;
}
function makeEntity(entity, manifest, factory) {
    const plans = entity.fields.map(planField);
    const typeIris = entity.typeIris;
    class Wrapper extends TermWrapper {
        get id() {
            return this.value;
        }
        get types() {
            return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
        }
        get isInstance() {
            const types = this.types;
            return typeIris.some((t) => types.has(t));
        }
        mark() {
            const types = this.types;
            for (const t of typeIris)
                types.add(t);
            return this;
        }
    }
    // Install per-field accessors from the manifest (data-driven, not per-field code).
    for (const plan of plans) {
        const { field } = plan;
        if (field.collection === "set") {
            Object.defineProperty(Wrapper.prototype, field.name, {
                get() {
                    return fieldSet(this, plan);
                },
                enumerable: true,
                configurable: true,
            });
        }
        else {
            Object.defineProperty(Wrapper.prototype, field.name, {
                get() {
                    return readSingle(this, plan);
                },
                set(value) {
                    writeSingle(this, plan, value);
                },
                enumerable: true,
                configurable: true,
            });
        }
    }
    const WrapperCtor = Wrapper;
    function subject(resourceUrl) {
        return subjectIri(entity.subject.convention, resourceUrl);
    }
    function build(resourceUrl, data) {
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
                    let m = member;
                    if (field.guards?.trim && typeof m === "string")
                        m = m.trim();
                    if (field.guards?.dropBlank && (m === "" || m === undefined || m === null))
                        continue;
                    // Sanitize LITERAL text members only; IRI members are canonicalised +
                    // scheme-filtered by the filtered set's add (never sanitized as text).
                    if (field.kind === "literal" &&
                        mapper.jsType === "string" &&
                        typeof m === "string" &&
                        field.guards?.sanitizeText !== false &&
                        mapper.lexicalValid === undefined // a narrowed-lexical member is validated RAW
                    ) {
                        m = sanitizeText(m);
                    }
                    // Datatype validity + numeric-range / string-length guards + IRI
                    // canonicalisation are ALL applied by the guarded set's `add` (in the
                    // correct order), so a raw member is handed straight to it — no premature
                    // pre-canonicalisation check here (which could wrongly drop an IRI whose
                    // canonical form would satisfy the guard).
                    set.add(m);
                }
                continue;
            }
            let v = raw;
            // emptyStringDrop drops ONLY an empty string (not a valid falsy 0 / false).
            if (field.kind === "literal" && field.guards?.emptyStringDrop && v === "")
                v = undefined;
            if (v === undefined && field.defaultNow)
                v = new Date();
            if (v === undefined && field.materializeDefault && field.default !== undefined) {
                v = field.default;
            }
            writeSingle(doc, plan, v);
        }
        return store;
    }
    function parse(resourceUrl, dataset) {
        const doc = new Wrapper(subject(resourceUrl), dataset, factory);
        if (!doc.isInstance)
            return undefined;
        const data = {};
        for (const plan of plans) {
            const { field } = plan;
            if (field.collection === "set") {
                const members = [...fieldSet(doc, plan)];
                const arr = field.guards?.sortOnRead
                    ? members.slice().sort((a, b) => String(a).localeCompare(String(b)))
                    : members;
                if (arr.length > 0)
                    data[field.name] = arr;
                continue;
            }
            const value = readSingle(doc, plan);
            if (value === undefined) {
                if (field.guards?.requiredFailClosed)
                    return undefined;
                continue;
            }
            data[field.name] = value;
        }
        return data;
    }
    function storeToTurtle(store) {
        const writer = new Writer({ prefixes: { ...manifest.prefixes } });
        writer.addQuads([...store]);
        return new Promise((resolve, reject) => {
            writer.end((error, result) => (error ? reject(error) : resolve(result)));
        });
    }
    function serialize(resourceUrl, data) {
        return storeToTurtle(build(resourceUrl, data));
    }
    async function parseDocument(resourceUrl, body, contentType = "text/turtle") {
        const resolvedContentType = contentType ?? "text/turtle";
        const { parseRdf } = await import("@jeswr/fetch-rdf");
        const dataset = await parseRdf(body, resolvedContentType, { baseIRI: resourceUrl });
        return parse(resourceUrl, dataset);
    }
    return {
        name: entity.name,
        typeIri: typeIris[0],
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
export function defineModel(input, options = {}) {
    const manifest = validateManifest(input);
    const factory = options.factory ?? N3DataFactory;
    const entities = {};
    for (const entity of manifest.entities) {
        entities[entity.name] = makeEntity(entity, manifest, factory);
    }
    return { manifest, prefixes: { ...manifest.prefixes }, entities };
}
//# sourceMappingURL=model.js.map