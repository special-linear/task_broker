import { AppError } from "../shared/core";

export interface QueryMetrics {
  statements: number;
  max_parameters: number;
  rows_read: number;
  rows_written: number;
  sql_duration_ms: number;
  size_after: number;
}
export function instrumentDatabase(native: D1Database) {
  const metrics: QueryMetrics = {
    statements: 0,
    max_parameters: 0,
    rows_read: 0,
    rows_written: 0,
    sql_duration_ms: 0,
    size_after: 0,
  };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function reserve(count: number) {
    if (metrics.statements + count > 49)
      throw new AppError(
        "BUSY",
        "The request reached its database query budget. Retry the unchanged operation.",
        503,
        undefined,
        true,
      );
    metrics.statements += count;
  }
  function record(result: D1Result) {
    metrics.rows_read += result.meta.rows_read ?? 0;
    metrics.rows_written += result.meta.rows_written ?? 0;
    metrics.sql_duration_ms += result.meta.timings?.sql_duration_ms ?? result.meta.duration ?? 0;
    metrics.size_after = Math.max(metrics.size_after, result.meta.size_after ?? 0);
  }
  function wrap(original: D1PreparedStatement): D1PreparedStatement {
    const proxy = new Proxy(original, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => {
            metrics.max_parameters = Math.max(metrics.max_parameters, values.length);
            return wrap(target.bind(...values));
          };
        if (property === "first")
          return async (column?: string) => {
            reserve(1);
            const r = await target.all<Record<string, unknown>>();
            record(r);
            return column === undefined ? (r.results[0] ?? null) : (r.results[0]?.[column] ?? null);
          };
        if (property === "all" || property === "run")
          return async () => {
            reserve(1);
            const r = await target[property]();
            record(r);
            return r;
          };
        if (property === "raw")
          return (...args: any[]) => {
            reserve(1);
            return (target.raw as Function)(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, original);
    return proxy;
  }
  const db = new Proxy(native, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          reserve(statements.length);
          const result = await target.batch(statements.map((s) => originals.get(s) ?? s));
          result.forEach(record);
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, metrics };
}
