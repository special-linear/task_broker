import { readFile, writeFile } from "node:fs/promises";
import { admin, meta } from "./verification-api.mjs";
const actions = [];
for (const file of [
  "performance-remote.json",
  "performance-remote-optimized-1000.json",
  "remote-fixture.json",
]) {
  let fixture;
  try {
    fixture = JSON.parse(await readFile(`artifacts/private/${file}`, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const keys = (await admin(`/keys?family_id=${fixture.family}`)).rows;
  const key = keys.find((k) => k.id === fixture.key_id);
  if (key && key.status !== "hard_revoked") {
    await admin(`/keys/${key.id}/hard-revoke`, {
      ...meta(),
      reason: "Disposable verification finished",
    });
    actions.push({ kind: "key_revoked", id: key.id });
  }
  const pool = await admin(`/pools/${fixture.pool}`);
  if (!pool.archived_at) {
    await admin(
      `/pools/${pool.id}`,
      { ...meta(), expected_revision: pool.config_revision, patch: { archived: true } },
      "PATCH",
    );
    actions.push({ kind: "pool_archived", id: pool.id });
  }
}
await writeFile(
  "artifacts/private/verification/fixture-cleanup.json",
  JSON.stringify(
    {
      completed: true,
      recorded_at: new Date().toISOString(),
      permanent_history_retained: true,
      actions,
    },
    null,
    2,
  ),
);
console.log(`Completed ${actions.length} fixture cleanup actions; all history retained.`);
