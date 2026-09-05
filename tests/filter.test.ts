/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { compileFilter, evaluateFilter, fieldResolver, parseFilter } from "../src/shared/filter";
import { fieldSchema, normalizeTags, parseJSON } from "../src/shared/core";
const fields = [
  fieldSchema.parse({ key: "n", label: "n", type: "integer" }),
  fieldSchema.parse({ key: "text", label: "Text", type: "string" }),
];
fields.push(fieldSchema.parse({ key: "flag", label: "Flag", type: "boolean" }));
const resolve = fieldResolver(fields, {});
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
test("FILTER-01/FILTER-02 SQL and reference evaluator agree on blanks and literals", async () => {
  const rows = [
    {},
    { n: null, text: "" },
    { n: 0, text: "A_%", flag: false },
    { n: 3, text: "alpha", flag: true },
    { n: "9007199254740993", text: "Alpha" },
  ];
  for (const text of [
    "flag = false",
    "flag != true",
    "NOT (flag = true)",
    "flag IS BLANK",
    "n != 3",
    "NOT (n = 3)",
    "n NOT IN (0,3)",
    "n IS BLANK",
    'text CONTAINS "_%"',
    'text STARTS_WITH "A"',
    "n > 9007199254740992",
  ]) {
    const ast = parseFilter(text),
      compiled = compileFilter(ast, resolve);
    for (const row of rows) {
      const result = await env.DB.prepare(
        `SELECT ${compiled.sql} matches FROM (SELECT ?${compiled.params.length + 1} parameters_json,NULL result_summary_json,'test' task_uid) t`,
      )
        .bind(...compiled.params, JSON.stringify(row))
        .first<any>();
      expect(!!result.matches, `${text}: ${JSON.stringify(row)}`).toBe(
        evaluateFilter(ast, row, resolve),
      );
    }
  }
});
test("reject injection, comparison chains, incompatible types and unsafe numbers", () => {
  expect(() => parseFilter("1 < n < 3")).toThrow();
  expect(() => parseFilter("n = 9007199254740993e0")).toThrow();
  expect(() => parseFilter("n = 2; DROP TABLE tasks")).toThrow();
  expect(() => compileFilter(parseFilter('n = "3"'), resolve)).toThrow();
  expect(() => parseJSON('{"n":9007199254740993}')).toThrow();
  expect(parseJSON('{"n":"9007199254740993"}')).toEqual({
    n: "9007199254740993",
  });
  expect(normalizeTags([" GPU ", "gpu", "É"])).toEqual(["gpu", "é"]);
});
