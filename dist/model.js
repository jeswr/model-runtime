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
/** Read a single (non-set) field's value, applying read-side guards, fail-closed. */
function readSingle(doc, plan) {
    const { field, mapper } = plan;
    const raw = tryRead(() => OptionalFrom.subjectPredicate(doc, field.predicate, mapper.as));
    if (hasIriSchemeGuard(field)) {
        return httpIriOrUndefined(raw);
    }
    if (raw === undefined && field.default !== undefined)
        return field.default;
    return raw;
}
/** Live set for a set field (mutations write through @rdfjs/wrapper's SetFrom). */
function fieldSet(doc, plan) {
    const { field, mapper } = plan;
    const base = SetFrom.subjectPredicate(doc, field.predicate, mapper.as, mapper.from);
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
        if (hasIriSchemeGuard(field))
            v = httpIriOrUndefined(v);
        OptionalAs.object(doc, field.predicate, v, NamedNodeFrom.string);
        return;
    }
    // Literal field: sanitize a string value; DROP a non-string value fail-closed
    // (a mistyped value must never be coerced into garbage or throw the write).
    if (v !== undefined && mapper.jsType === "string") {
        v =
            typeof v === "string"
                ? field.guards?.sanitizeText === false
                    ? v
                    : sanitizeText(v)
                : undefined;
    }
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
                        field.guards?.sanitizeText !== false) {
                        m = sanitizeText(m);
                    }
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