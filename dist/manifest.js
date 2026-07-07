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
    // A composite manifest nests two levels deeper than a flat one
    // (entities → nodes → fields → guards → value), so this bounds that shape with
    // headroom while staying a small recursion-bomb guard.
    default_object_depth: 10,
    /** Nodes per composite entity (root + sub-nodes). */
    nodes_per_composite: 64,
};
/** Type guard — narrows an entity to the composite (document-projection) variant. */
export function isCompositeEntity(entity) {
    return entity.kind === "composite";
}
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
    "node",
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
const ENTITY_KEYS = new Set(["name", "kind", "typeIris", "subject", "fields"]);
const COMPOSITE_ENTITY_KEYS = new Set(["name", "kind", "root", "nodes"]);
const NODE_KEYS = new Set(["name", "typeIris", "fragment", "fields"]);
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
/**
 * A `nested` field is a COMPOSITE structural link — pure structure, never data. It
 * carries a target sub-node reference (`node`) and a predicate, and MAY carry only the
 * `requiredFailClosed` guard (the cross-node MUST). It must NOT carry any data-shape key
 * (datatype / collection / minCount / maxCount / default / defaultNow /
 * materializeDefault / in) nor any guard other than `requiredFailClosed` — those would
 * be silently ignored, so they fail closed here.
 */
function validateNestedField(raw, name, predicate) {
    const node = checkString(raw.node, "field.node (required for a nested field)");
    if (!NAME_RE.test(node))
        fail(`field.node "${node}" is not a valid node name`);
    for (const forbidden of [
        "datatype",
        "collection",
        "minCount",
        "maxCount",
        "default",
        "defaultNow",
        "materializeDefault",
        "in",
    ]) {
        if (raw[forbidden] !== undefined) {
            fail(`field.${forbidden} is not allowed on a nested field`);
        }
    }
    const field = { name, predicate, kind: "nested", node };
    if (raw.guards !== undefined) {
        if (!isObject(raw.guards))
            fail("field.guards must be an object");
        assertKnownKeys(raw.guards, new Set(["requiredFailClosed"]), "nested field.guards");
        if (raw.guards.requiredFailClosed !== undefined) {
            field.guards = {
                requiredFailClosed: checkBoolean(raw.guards.requiredFailClosed, "field.guards.requiredFailClosed"),
            };
        }
    }
    return field;
}
function validateField(raw, seenNames, allowNested = false) {
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
    if (raw.kind === "nested") {
        if (!allowNested)
            fail('field.kind "nested" is only allowed inside a composite entity');
        return validateNestedField(raw, name, predicate);
    }
    if (raw.node !== undefined)
        fail("field.node is only allowed on a nested field");
    if (raw.kind !== "iri" && raw.kind !== "literal") {
        fail('field.kind must be "iri", "literal", or "nested"');
    }
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
/** Validate a non-empty, capped, control-char-free array of type IRIs. */
function validateTypeIris(raw, what) {
    if (!Array.isArray(raw) || raw.length === 0)
        fail(`${what} must be a non-empty array`);
    if (raw.length > CAP.type_iris_per_entity) {
        fail(`${what} exceeds the ${CAP.type_iris_per_entity} cap`);
    }
    return raw.map((t, i) => checkString(t, `${what}[${i}]`));
}
function validateEntity(raw) {
    assertKnownKeys(raw, ENTITY_KEYS, "entity");
    if (raw.kind !== undefined && raw.kind !== "flat") {
        fail('entity.kind must be "flat" or "composite"');
    }
    const name = checkString(raw.name, "entity.name");
    const typeIris = validateTypeIris(raw.typeIris, "entity.typeIris");
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
    // A flat entity carries no `kind` key (byte-compatible with existing manifests).
    return { name, typeIris, subject: { convention }, fields };
}
// A document fragment must be a bare fragment (no `#` / `/` / whitespace) so the node
// IRI `${resourceUrl}#${fragment}` is a single, well-formed fragment identifier.
const FRAGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
function validateNode(raw, seenFieldNames) {
    if (!isObject(raw))
        fail("composite node must be an object");
    assertKnownKeys(raw, NODE_KEYS, "composite node");
    const name = checkString(raw.name, "node.name");
    if (!NAME_RE.test(name))
        fail(`node.name "${name}" is not a valid node name`);
    const typeIris = validateTypeIris(raw.typeIris, "node.typeIris");
    const fragment = checkString(raw.fragment, "node.fragment");
    if (!FRAGMENT_RE.test(fragment))
        fail(`node.fragment "${fragment}" is not a valid fragment`);
    if (!Array.isArray(raw.fields))
        fail("node.fields must be an array");
    if (raw.fields.length > CAP.fields_per_entity) {
        fail(`node.fields exceeds the ${CAP.fields_per_entity} cap`);
    }
    // Field names are GLOBALLY unique across the composite (the flat projection is one
    // object), so the seen-set is shared across all the composite's nodes.
    const fields = raw.fields.map((f) => validateField(f, seenFieldNames, /* allowNested */ true));
    return { name, typeIris, fragment, fields };
}
/**
 * Validate a composite (document-projection) entity FAIL-CLOSED and assert its TREE
 * invariant: exactly one root (named by `root`); every non-root node has EXACTLY ONE
 * incoming `nested` link; every `nested` link targets a declared node; the link graph
 * is acyclic and spans every node (reachable from the root). A cycle, an orphan node, a
 * dangling link target, or a link INTO the root fails closed.
 */
function validateCompositeEntity(raw) {
    assertKnownKeys(raw, COMPOSITE_ENTITY_KEYS, "composite entity");
    const name = checkString(raw.name, "entity.name");
    const root = checkString(raw.root, "entity.root");
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
        fail("composite entity.nodes must be a non-empty array");
    }
    if (raw.nodes.length > CAP.nodes_per_composite) {
        fail(`composite entity.nodes exceeds the ${CAP.nodes_per_composite} cap`);
    }
    const seenNodeNames = new Set();
    const seenFragments = new Set();
    const seenFieldNames = new Set();
    const nodes = raw.nodes.map((n) => {
        const node = validateNode(n, seenFieldNames);
        if (seenNodeNames.has(node.name))
            fail(`duplicate composite node name "${node.name}"`);
        seenNodeNames.add(node.name);
        if (seenFragments.has(node.fragment)) {
            fail(`duplicate composite node fragment "${node.fragment}"`);
        }
        seenFragments.add(node.fragment);
        return node;
    });
    if (!seenNodeNames.has(root))
        fail(`composite entity.root "${root}" is not a declared node`);
    // Build the nested-link parent map and assert the TREE invariant.
    const parentOf = new Map(); // child node name → the node that links to it
    for (const node of nodes) {
        for (const field of node.fields) {
            if (field.kind !== "nested")
                continue;
            const target = field.node;
            if (!seenNodeNames.has(target)) {
                fail(`composite nested field "${field.name}" targets unknown node "${target}"`);
            }
            if (target === root)
                fail(`composite nested field "${field.name}" links into the root node`);
            if (target === node.name)
                fail(`composite nested field "${field.name}" links a node to itself`);
            if (parentOf.has(target)) {
                fail(`composite node "${target}" has more than one incoming nested link (not a tree)`);
            }
            parentOf.set(target, node.name);
        }
    }
    // Every non-root node must have exactly one parent; the root must have none.
    for (const node of nodes) {
        if (node.name === root)
            continue;
        if (!parentOf.has(node.name)) {
            fail(`composite node "${node.name}" is unreachable (no incoming nested link)`);
        }
    }
    // Reachability from the root (also rejects a cycle among non-root nodes, which the
    // one-parent rule alone would leave disconnected from the root).
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const reached = new Set();
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        if (reached.has(current))
            continue;
        reached.add(current);
        const node = byName.get(current);
        if (!node)
            continue;
        for (const field of node.fields) {
            if (field.kind === "nested" && field.node !== undefined)
                stack.push(field.node);
        }
    }
    if (reached.size !== nodes.length) {
        fail("composite link graph is not a tree spanning every node (a cycle or orphan)");
    }
    return { name, kind: "composite", root, nodes };
}
function validateEntityAny(raw) {
    if (!isObject(raw))
        fail("entity must be an object");
    return raw.kind === "composite" ? validateCompositeEntity(raw) : validateEntity(raw);
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
        const entity = validateEntityAny(e);
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