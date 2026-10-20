import type { DAG } from "./dag-validator.js";

/**
 * A ONE-LEG COPY (ONE-LEG-FORKS-1020, owner 2026-10-19: « A workflow can only be at one leg at a time », « fork, pas
 * de duplicate de leg ») runs the same steps as its source on another pipe of the channel. Two active workflows of a
 * channel cannot share a DAG signature, so the copy's DAG states `forkedForPipe` (inert at run time: the converter
 * never reads it). Which pipe a workflow serves stays features-service's.
 *
 * Every new version of a copy keeps its mark: a builder (a seed) or a client sends the steps without it, and the new
 * version would otherwise take its source's signature (409) or its sibling copies'.
 */
export function keepForkMark<T extends DAG>(dag: T, stored: unknown): T {
  const mark = (stored as DAG | null | undefined)?.forkedForPipe;
  if (!mark || dag.forkedForPipe) return dag;
  return { ...dag, forkedForPipe: mark };
}
