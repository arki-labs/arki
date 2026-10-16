---
'@arki/ai': minor
---

Structured generation takes any Standard Schema instead of a Zod type. `generateStructuredData`, `generateStructuredDataFromMessages`, `generateCustom`, `batchGenerate` and `StructuredLLMProvider` now accept `S extends StandardSchemaV1` and return `SchemaOutput<S>`. The model is shown the schema's input JSON Schema; the result is the schema's output. A schema with no JSON Schema converter throws a `ConfigurationError` naming `withJsonSchema`.
`AgentTool.inputSchema` is a Standard Schema (`StandardSchemaV1<unknown, TInput>`) that can emit JSON Schema. `useAIGeneration` `schema` option is a Standard Schema and the request body carries its input JSON Schema as `jsonSchema`.
