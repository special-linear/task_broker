import type { Field } from "../shared/core";
import { sqlString } from "../shared/filter";
import { resolverFor } from "./model";

export function sortResolver(
  fields: Field[],
  profileId: string | null,
  allowlist?: string[],
  alias = "t",
  time?: string,
  epoch?: string,
) {
  const resolve = resolverFor(fields, profileId, time, epoch, allowlist);
  return (key: string) => {
    const resolved = resolve(key),
      field = fields.find((f) => f.active && f.key === resolved.key);
    const prefix = alias ? alias + "." : "";
    return field
      ? {
          ...resolved,
          expression: `json_extract(${prefix}${field.kind === "input" ? "parameters_json" : "result_summary_json"},${sqlString("$." + JSON.stringify(field.key))})`,
        }
      : { ...resolved, expression: resolved.expression.replace(/\bt\./g, prefix) };
  };
}
