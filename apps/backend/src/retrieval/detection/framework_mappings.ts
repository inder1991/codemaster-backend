// framework_mappings — port of the versioned data file
//   vendor/codemaster-py/codemaster/retrieval/detection/data/framework_mappings.toml
//   (Sub-spec B T5 + FOLLOW-UP-framework-detector-data-file; schema_version 1).
//
// Maps ecosystem-agnostic dependency names (canonical-normalized per ADR-0058: NFKC + lowercase +
// ASCII regex) to canonical `framework:*` labels. Multiple ecosystems may resolve to the same label —
// the label is canonical, not per-ecosystem. The Python loads this from TOML at import + validates
// every value is `framework:*` namespaced; here the data is a frozen const (the data file IS the
// source of truth — this is the thin TS equivalent of the Python loader's output).

/** schema_version of the source data file. */
export const FRAMEWORK_MAPPINGS_SCHEMA_VERSION = 1 as const;

/** Dependency name (canonical-lowercase) → canonical `framework:*` label. */
export const FRAMEWORK_MAPPINGS: Readonly<Record<string, string>> = {
  // ─── JS/TS frontend ───────────────────────────────────────────────
  react: "framework:react",
  next: "framework:nextjs",
  preact: "framework:preact",
  "solid-js": "framework:solid",
  svelte: "framework:svelte",
  "@angular/core": "framework:angular",
  vue: "framework:vue",
  nuxt: "framework:nuxt",
  // ─── JS/TS backend ────────────────────────────────────────────────
  express: "framework:express",
  fastify: "framework:fastify",
  koa: "framework:koa",
  "@nestjs/core": "framework:nestjs",
  // ─── Python web ───────────────────────────────────────────────────
  fastapi: "framework:fastapi",
  django: "framework:django",
  flask: "framework:flask",
  starlette: "framework:starlette",
  tornado: "framework:tornado",
  aiohttp: "framework:aiohttp",
  // ─── Python ML ────────────────────────────────────────────────────
  torch: "framework:pytorch",
  tensorflow: "framework:tensorflow",
  jax: "framework:jax",
  // ─── Go ───────────────────────────────────────────────────────────
  "github.com/gin-gonic/gin": "framework:gin",
  "github.com/labstack/echo/v4": "framework:echo",
  "github.com/gofiber/fiber/v2": "framework:fiber",
  // ─── Java/Kotlin ──────────────────────────────────────────────────
  "org.springframework.boot:spring-boot-starter": "framework:spring-boot",
  "io.ktor:ktor-server-core": "framework:ktor",
  // ─── Ruby ─────────────────────────────────────────────────────────
  rails: "framework:rails",
  sinatra: "framework:sinatra",
  // ─── .NET ─────────────────────────────────────────────────────────
  "microsoft.aspnetcore.app": "framework:aspnetcore",
};
