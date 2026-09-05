import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { routes, componentSchemas, errorSchema } from "../src/shared/routes";
const convert = (schema: z.ZodType) => {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
  delete out.$schema;
  return out;
};
const paths: Record<string, Record<string, unknown>> = {};
for (const route of routes) {
  const query = route.query ? convert(route.query) : undefined;
  const parameters = [
    ...Array.from(route.path.matchAll(/\{([^}]+)\}/g), (m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    })),
    ...Object.entries(query?.properties ?? {}).map(([name, schema]) => ({
      name,
      in: "query",
      required: false,
      schema,
    })),
  ];
  const security = route.path.startsWith("/api/") ? [{ FamilyKey: [] }] : [{ AccessSession: [] }];
  const success = convert(
    z.object({
      ok: z.literal(true),
      api_version: z.literal("1"),
      request_id: z.string().nullable(),
      data: route.response,
    }),
  );
  const response = (description: string, schema: unknown) => ({
    description,
    content: { "application/json": { schema } },
  });
  (paths[route.path] ??= {})[route.method] = {
    summary: route.summary,
    operationId: `${route.method}_${route.path.replace(/[^a-z0-9]+/gi, "_")}`,
    security,
    parameters,
    ...(route.schema
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: convert(route.schema) } },
          },
        }
      : {}),
    responses: {
      "200": response(
        "Committed or replayed operation. Report/renew item errors remain HTTP 200.",
        success,
      ),
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 503].map((status) => [
          status,
          response(
            "Error envelope. Retain prepared mutations after uncertain transport or retryable failure.",
            convert(errorSchema),
          ),
        ]),
      ),
    },
  };
}
const document = {
  openapi: "3.1.0",
  info: {
    title: "Cloudflare Task Broker",
    version: "1.0.0",
    description:
      "All mutations require stable request_id and request_created_at. Receipt identity spans mutation endpoints for each actor. Administrator mutations additionally require exact Origin and X-Task-Broker: 1. Report and renewal envelopes validate items independently; see ReportItem and RenewItem components. Integer values beyond JavaScript precision must be decimal strings.",
  },
  servers: [{ url: "https://YOUR-HOST" }],
  paths,
  components: {
    securitySchemes: {
      FamilyKey: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "tb_<public UUID>_<256-bit secret>",
      },
      AccessSession: { type: "apiKey", in: "cookie", name: "CF_Authorization" },
    },
    schemas: Object.fromEntries(Object.entries(componentSchemas).map(([k, v]) => [k, convert(v)])),
  },
};
const output = JSON.stringify(document, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile("openapi.json", "utf8")) !== output)
    throw new Error("openapi.json is stale; run npm run api:generate.");
  console.log("OpenAPI matches the shared route registry.");
} else {
  await writeFile("openapi.json", output);
  console.log(`Generated ${routes.length} endpoint contracts.`);
}
