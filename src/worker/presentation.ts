import { assert, iso } from "../shared/core";
import type { Row } from "./types";
const timestamp = (key: string) =>
  key.endsWith("_at") || ["timestamp", "first_seen", "last_seen"].includes(key);
// Only record metadata is converted. Nested scientific inputs/results stay lossless.
export function recordDto(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      timestamp(key) && typeof value === "number" ? iso(value) : value,
    ]),
  );
}
export function importedRecord(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (timestamp(key) && typeof value === "string") {
        assert(
          /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value)),
          "INVALID_VALUE",
          `Invalid imported UTC timestamp ${key}.`,
        );
        return [key, Date.parse(value)];
      }
      return [key, value];
    }),
  );
}
