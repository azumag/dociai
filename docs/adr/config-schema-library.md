# ADR: Config schema library

## Decision

Use a small declarative, dependency-free schema core in `src/config/`. The same ES modules run in Browser, Renderer, Main, and Node tests.

## Rationale

The project currently ships without a runtime schema dependency. A pure registry plus structured `ValidationIssue` keeps bundle size and CSP surface unchanged, supports exact paths/codes, and can be extended incrementally during migration work in #108. Zod, Ajv, and TypeBox were considered; each would add a dependency or build/runtime split before the schema stabilizes.
