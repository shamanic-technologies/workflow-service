/**
 * The roll-back's production deps: a version re-activated gets its Windmill flow back first (a deprecated version's
 * flow may have been cleaned up; `syncFlowToWindmill` re-creates it at its recorded path, no-op when present). Throws
 * on failure: a roll-back that cannot restore the flow must not leave a live-but-broken workflow.
 */
import type { RollbackDeps } from "./script-guard.js";
import { getWindmillClient } from "../windmill-client.js";
import { syncFlowToWindmill } from "../startup-validator.js";

export function productionRollbackDeps(): RollbackDeps {
  return {
    async restoreFlow(workflow) {
      const client = getWindmillClient();
      if (!client) return;
      await syncFlowToWindmill(workflow, client);
    },
  };
}
