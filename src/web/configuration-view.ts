export type ConfigurationState = { families: any[]; pools: any[]; profiles: any[] };
export const showArchived = () => localStorage.getItem("task-broker:show-archived") === "true";
export const setShowArchived = (show: boolean) =>
  localStorage.setItem("task-broker:show-archived", String(show));
export const familyFor = (state: ConfigurationState, row: any) =>
  state.families.find((f) => f.id === (row.family_id ?? row.owner_family_id));
export const profileRoute = (state: ConfigurationState, profile: any) =>
  `${familyFor(state, profile)?.slug ?? "?"}/${profile.slug}`;
export function archiveReason(state: ConfigurationState, table: string, row: any): string {
  if (row.archived_at) return "Archived";
  if (table !== "families" && familyFor(state, row)?.archived_at) return "Family archived";
  if (table === "profiles" && state.pools.find((p) => p.id === row.pool_id)?.archived_at)
    return "Pool archived";
  return "";
}
export const visibleConfiguration = (state: ConfigurationState, table: string, row: any) =>
  showArchived() || !archiveReason(state, table, row);
