/**
 * `@jeswr/model-runtime` — the ONE audited generic runtime for the
 * federation-codegen pipeline. It interprets a JSON shape-manifest to parse /
 * validate / read / write RDF over `@rdfjs/wrapper`, carrying the full guard
 * inventory the six hand-written `@jeswr` data-model packages (solid-bookmark,
 * solid-task-model, solid-drawing, solid-chat-interop, solid-memory,
 * solid-health-diary) each duplicated.
 *
 * **Data, not code (design §7.1).** A generated model is a fixed-template shim
 * that inlines a pure-data manifest and calls {@link defineModel}. All behaviour —
 * every guard, every accessor — lives here and is audited once. The manifest is
 * validated FAIL-CLOSED before interpretation ({@link validateManifest}); it may
 * never carry executable, regex-source, template, or path-expression content.
 *
 * securityCritical: this package is the shared interpreter of federation-sourced
 * schemas for every domain; it is the highest-consequence package in the design.
 *
 * @packageDocumentation
 */
export { type DatatypeMapper, expandDatatype, iriMapper, isKnownDatatype, isXsdDate, isXsdDateTime, isXsdDuration, type JsType, literalMapper, XSD, } from "./datatypes.js";
export { httpIriOrUndefined, isHttpIri, sanitizeText, tryRead, } from "./guards.js";
export { type AnyManifestEntity, type CompositeManifestEntity, isCompositeEntity, MANIFEST_VERSION, type ManifestEntity, ManifestError, type ManifestField, type ManifestFieldGuards, type ManifestNode, type ManifestScalar, type ModelManifest, RUNTIME_MAJOR, validateManifest, } from "./manifest.js";
export { type DefineModelOptions, defineModel, type EntityData, type EntityWrapper, type EntityWrapperConstructor, type Model, type ModelEntity, } from "./model.js";
//# sourceMappingURL=index.d.ts.map