// AUTHORED-BY Claude Opus 4.8
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
export const MANIFEST_VERSION = 1;
/** The runtime major the manifest must target (bound 1:1 to the package major). */
export const RUNTIME_MAJOR = 0;
// --- Hard caps (fail-closed): a manifest exceeding any of these is rejected. ---
const CAP = {
    json_bytes: 512 * 1024,
    entities: 64,
    fields_per_entity: 256,
    type_iris_per_entity: 16,
    prefixes: 256,
    string_len: 4096,
    in_values: 1024,
    default_object_depth: 8,
};
/** Thrown when a manifest fails the fail-closed validation. */
export class ManifestError extends Error {
    name = "ManifestError";
}
// Names a field may not take: they would shadow a TermWrapper / Object member or
// enable prototype pollution when keyed onto a returned data object.
const RESERVED_FIELD_NAMES = new Set([
    "__proto__",
    "constructor",
    "prototype",
    "id",
    "types",
    "mark",
    "isInstance",
    "value",
    "termType",
    "datatype",
    "language",
    "direction",
    "equals",
    "dataset",
    "factory",
    "subject",
    "predicate",
    "object",
    "graph",
    "hasOwnProperty",
    "toString",
    "valueOf",
]);
// A valid accessor name: ASCII letter/underscore start, then letters/digits/_.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function fail(message) {
    throw new ManifestError(message);
}
function checkString(value, what) {
    if (typeof value !== "string")
        fail(`${what} must be a string`);
    if (value.length === 0)
        fail(`${what} must be non-empty`);
    if (value.length > CAP.string_len)
        fail(`${what} exceeds the ${CAP.string_len}-char cap`);
    // No control characters anywhere in a manifest string (defence in depth).
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c < 0x20 || (c >= 0x7f && c <= 0x9f))
            fail(`${what} contains a control character`);
    }
    return value;
}
function checkScalar(value, what) {
    if (typeof value === "string")
        return checkString(value, what);
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            fail(`${what} must be a finite number`);
        return value;
    }
    return fail(`${what} must be a string, number, or boolean`);
}
function assertKnownKeys(obj, allowed, what) {
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key))
            fail(`${what} has unknown key "${key}"`);
    }
}
const GUARD_KEYS = new Set([
    "iriScheme",
    "requiredFailClosed",
    "emptyStringDrop",
    "sanitizeText",
    "trim",
    "dropBlank",
    "sortOnRead",
    "minInclusive",
    "maxInclusive",
    "minLength",
    "nonBlank",
]);
const FIELD_KEYS = new Set([
    "name",
    "predicate",
    "kind",
    "collection",
    "datatype",
    "minCount",
    "maxCount",
    "default",
    "defaultNow",
    "materializeDefault",
    "in",
    "guards",
]);
const ENTITY_KEYS = new Set(["name", "typeIris", "subject", "fields"]);
const ROOT_KEYS = new Set(["manifestVersion", "runtime", "prefixes", "entities"]);
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function checkBoolean(v, what) {
    if (typeof v !== "boolean")
        fail(`${what} must be a boolean`);
    return v;
}
function checkCount(v, what) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        fail(`${what} must be a non-negative integer`);
    }
    return v;
}
function checkFiniteNumber(v, what) {
    if (typeof v !== "number" || !Number.isFinite(v))
        fail(`${what} must be a finite number`);
    return v;
}
function validateGuards(raw) {
    if (raw === undefined)
        return {};
    if (!isObject(raw))
        fail("field.guards must be an object");
    assertKnownKeys(raw, GUARD_KEYS, "field.guards");
    const g = {};
    if (raw.iriScheme !== undefined) {
        if (raw.iriScheme !== "http-https")
            fail('field.guards.iriScheme must be "http-https"');
        g.iriScheme = "http-https";
    }
    if (raw.requiredFailClosed !== undefined)
        g.requiredFailClosed = checkBoolean(raw.requiredFailClosed, "field.guards.requiredFailClosed");
    if (raw.emptyStringDrop !== undefined)
        g.emptyStringDrop = checkBoolean(raw.emptyStringDrop, "field.guards.emptyStringDrop");
    if (raw.sanitizeText !== undefined)
        g.sanitizeText = checkBoolean(raw.sanitizeText, "field.guards.sanitizeText");
    if (raw.trim !== undefined)
        g.trim = checkBoolean(raw.trim, "field.guards.trim");
    if (raw.dropBlank !== undefined)
        g.dropBlank = checkBoolean(raw.dropBlank, "field.guards.dropBlank");
    if (raw.sortOnRead !== undefined)
        g.sortOnRead = checkBoolean(raw.sortOnRead, "field.guards.sortOnRead");
    if (raw.minInclusive !== undefined)
        g.minInclusive = checkFiniteNumber(raw.minInclusive, "field.guards.minInclusive");
    if (raw.maxInclusive !== undefined)
        g.maxInclusive = checkFiniteNumber(raw.maxInclusive, "field.guards.maxInclusive");
    if (g.minInclusive !== undefined &&
        g.maxInclusive !== undefined &&
        g.minInclusive > g.maxInclusive) {
        fail(`field.guards.minInclusive (${g.minInclusive}) exceeds field.guards.maxInclusive (${g.maxInclusive})`);
    }
    if (raw.minLength !== undefined)
        g.minLength = checkCount(raw.minLength, "field.guards.minLength");
    if (raw.nonBlank !== undefined)
        g.nonBlank = checkBoolean(raw.nonBlank, "field.guards.nonBlank");
    return g;
}
function validateField(raw, seenNames) {
    if (!isObject(raw))
        fail("field must be an object");
    assertKnownKeys(raw, FIELD_KEYS, "field");
    const name = checkString(raw.name, "field.name");
    if (!NAME_RE.test(name))
        fail(`field.name "${name}" is not a valid accessor name`);
    if (RESERVED_FIELD_NAMES.has(name))
        fail(`field.name "${name}" is reserved`);
    if (seenNames.has(name))
        fail(`duplicate field.name "${name}"`);
    seenNames.add(name);
    const predicate = checkString(raw.predicate, "field.predicate");
    if (raw.kind !== "iri" && raw.kind !== "literal")
        fail('field.kind must be "iri" or "literal"');
    const kind = raw.kind;
    let collection;
    if (raw.collection !== undefined) {
        if (raw.collection !== "set")
            fail('field.collection must be "set" when present');
        collection = "set";
    }
    let datatype;
    if (kind === "literal") {
        datatype = checkString(raw.datatype, "field.datatype (required for a literal field)");
    }
    else if (raw.datatype !== undefined) {
        fail("field.datatype is not allowed on an IRI field");
    }
    const field = { name, predicate, kind };
    if (collection)
        field.collection = collection;
    if (datatype)
        field.datatype = datatype;
    if (raw.minCount !== undefined)
        field.minCount = checkCount(raw.minCount, "field.minCount");
    if (raw.maxCount !== undefined)
        field.maxCount = checkCount(raw.maxCount, "field.maxCount");
    if (field.minCount !== undefined &&
        field.maxCount !== undefined &&
        field.minCount > field.maxCount) {
        fail(`field.minCount (${field.minCount}) exceeds field.maxCount (${field.maxCount})`);
    }
    if (raw.default !== undefined)
        field.default = checkScalar(raw.default, "field.default");
    if (raw.defaultNow !== undefined)
        field.defaultNow = checkBoolean(raw.defaultNow, "field.defaultNow");
    if (raw.materializeDefault !== undefined)
        field.materializeDefault = checkBoolean(raw.materializeDefault, "field.materializeDefault");
    if (field.materializeDefault && field.default === undefined && !field.defaultNow) {
        fail("field.materializeDefault requires a default (or defaultNow)");
    }
    if (raw.in !== undefined) {
        if (!Array.isArray(raw.in))
            fail("field.in must be an array");
        if (raw.in.length > CAP.in_values)
            fail(`field.in exceeds the ${CAP.in_values}-value cap`);
        field.in = raw.in.map((v, i) => checkScalar(v, `field.in[${i}]`));
    }
    field.guards = validateGuards(raw.guards);
    return field;
}
function validateEntity(raw) {
    if (!isObject(raw))
        fail("entity must be an object");
    assertKnownKeys(raw, ENTITY_KEYS, "entity");
    const name = checkString(raw.name, "entity.name");
    if (!Array.isArray(raw.typeIris) || raw.typeIris.length === 0) {
        fail("entity.typeIris must be a non-empty array");
    }
    if (raw.typeIris.length > CAP.type_iris_per_entity) {
        fail(`entity.typeIris exceeds the ${CAP.type_iris_per_entity} cap`);
    }
    const typeIris = raw.typeIris.map((t, i) => checkString(t, `entity.typeIris[${i}]`));
    if (!isObject(raw.subject))
        fail("entity.subject must be an object");
    assertKnownKeys(raw.subject, new Set(["convention"]), "entity.subject");
    if (raw.subject.convention !== "hash-it" && raw.subject.convention !== "self") {
        fail('entity.subject.convention must be "hash-it" or "self"');
    }
    const convention = raw.subject.convention;
    if (!Array.isArray(raw.fields))
        fail("entity.fields must be an array");
    if (raw.fields.length > CAP.fields_per_entity) {
        fail(`entity.fields exceeds the ${CAP.fields_per_entity} cap`);
    }
    const seenNames = new Set();
    const fields = raw.fields.map((f) => validateField(f, seenNames));
    return { name, typeIris, subject: { convention }, fields };
}
/**
 * Parse + validate an untrusted value into a {@link ModelManifest}, FAIL-CLOSED.
 * Every failure throws {@link ManifestError}; nothing is coerced. Call this before
 * {@link defineModel} interprets a manifest (defineModel calls it internally).
 */
export function validateManifest(input) {
    // Byte-size cap (defence against a pathological manifest).
    const asJson = JSON.stringify(input);
    if (asJson === undefined)
        fail("manifest is not JSON-serialisable");
    if (asJson.length > CAP.json_bytes)
        fail(`manifest exceeds the ${CAP.json_bytes}-byte cap`);
    if (jsonDepth(input) > CAP.default_object_depth)
        fail("manifest nesting is too deep");
    if (!isObject(input))
        fail("manifest must be an object");
    assertKnownKeys(input, ROOT_KEYS, "manifest");
    if (input.manifestVersion !== MANIFEST_VERSION) {
        fail(`manifest.manifestVersion must be ${MANIFEST_VERSION}`);
    }
    if (!isObject(input.runtime))
        fail("manifest.runtime must be an object");
    assertKnownKeys(input.runtime, new Set(["name", "major"]), "manifest.runtime");
    const runtimeName = checkString(input.runtime.name, "manifest.runtime.name");
    if (input.runtime.major !== RUNTIME_MAJOR) {
        fail(`manifest.runtime.major must be ${RUNTIME_MAJOR} (this runtime's major)`);
    }
    if (!isObject(input.prefixes))
        fail("manifest.prefixes must be an object");
    const prefixKeys = Object.keys(input.prefixes);
    if (prefixKeys.length > CAP.prefixes)
        fail(`manifest.prefixes exceeds the ${CAP.prefixes} cap`);
    const prefixes = {};
    for (const key of prefixKeys) {
        if (key === "__proto__")
            fail('manifest.prefixes may not use the key "__proto__"');
        prefixes[key] = checkString(input.prefixes[key], `manifest.prefixes["${key}"]`);
    }
    if (!Array.isArray(input.entities) || input.entities.length === 0) {
        fail("manifest.entities must be a non-empty array");
    }
    if (input.entities.length > CAP.entities)
        fail(`manifest.entities exceeds the ${CAP.entities} cap`);
    const seenEntityNames = new Set();
    const entities = input.entities.map((e) => {
        const entity = validateEntity(e);
        if (seenEntityNames.has(entity.name))
            fail(`duplicate entity.name "${entity.name}"`);
        seenEntityNames.add(entity.name);
        return entity;
    });
    return {
        manifestVersion: MANIFEST_VERSION,
        runtime: { name: runtimeName, major: RUNTIME_MAJOR },
        prefixes,
        entities,
    };
}
/** Depth of nested plain objects / arrays (cheap recursion bomb guard). */
function jsonDepth(value, depth = 0) {
    if (depth > CAP.default_object_depth + 1)
        return depth;
    if (Array.isArray(value)) {
        let max = depth;
        for (const v of value)
            max = Math.max(max, jsonDepth(v, depth + 1));
        return max;
    }
    if (isObject(value)) {
        let max = depth;
        for (const v of Object.values(value))
            max = Math.max(max, jsonDepth(v, depth + 1));
        return max;
    }
    return depth;
}
//# sourceMappingURL=manifest.js.map