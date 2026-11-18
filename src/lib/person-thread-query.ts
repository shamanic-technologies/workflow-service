/**
 * What every read of a person's crm thread leaves out (UNIBOX-API-LOGS-1117): crm-service `excludeSources`, the
 * `api` source = logs of calls to our API and MCP, never a message a person sent. Shared by the script door and the
 * workflow converter (dag-to-openflow.ts), so a script and a DAG read the same thread.
 */
export const PERSON_THREAD_DEFAULT_QUERY = { excludeSources: "api" } as const;
