/**
 * Resolving what a rollup actually rolls up.
 *
 * A rollup's target property lives on the *related* data source, so its type —
 * the thing that decides whether `min`/`max` yields a number or a date, and
 * therefore whether core will accept a filter on it at all — cannot be read
 * from this schema. This hook fetches it once per related data source and hands
 * the filter surfaces a lookup, so the menu never offers a chip core will
 * reject.
 */

import type { PropertyDef, PropertyType } from "@kumi/core";
import { commands } from "../ipc";
import { useAsync } from "../hooks";
import { relationConfigOf, rollupConfigOf } from "./properties";

export type RollupTargetTypes = ReadonlyMap<string, PropertyType | null>;

const EMPTY: RollupTargetTypes = new Map();

export function useRollupTargetTypes(properties: PropertyDef[]): RollupTargetTypes {
  // Identity of the *question*, not of the array: a refetch that returns an
  // equivalent schema must not re-run these lookups.
  const key = properties
    .filter((property) => property.type === "rollup")
    .map((property) => {
      const rollup = rollupConfigOf(property);
      return rollup === null
        ? property.id
        : `${property.id}:${rollup.relationPropertyId}:${rollup.targetPropertyId ?? ""}`;
    })
    .join("|");

  const state = useAsync(async () => {
    if (key === "") return EMPTY;
    const out = new Map<string, PropertyType | null>();
    const bundles = new Map<string, PropertyDef[]>();

    for (const property of properties) {
      if (property.type !== "rollup") continue;
      const rollup = rollupConfigOf(property);
      if (rollup === null || rollup.targetPropertyId === null) {
        out.set(property.id, null);
        continue;
      }
      const relation = properties.find((p) => p.id === rollup.relationPropertyId) ?? null;
      const dataSourceId = relation === null ? null : (relationConfigOf(relation)?.dataSourceId ?? null);
      if (dataSourceId === null) {
        out.set(property.id, null);
        continue;
      }
      let targets = bundles.get(dataSourceId);
      if (targets === undefined) {
        const bundle = await commands.getDataSource(dataSourceId).catch(() => null);
        targets = bundle?.properties ?? [];
        bundles.set(dataSourceId, targets);
      }
      out.set(property.id, targets.find((p) => p.id === rollup.targetPropertyId)?.type ?? null);
    }
    return out;
    // `properties` is fully described by `key` for this computation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state.data ?? EMPTY;
}
