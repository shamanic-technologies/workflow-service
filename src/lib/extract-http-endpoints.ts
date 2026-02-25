import type { DAG } from "./dag-validator.js";

export interface HttpEndpoint {
  service: string;
  method: string;
  path: string;
}

export function extractHttpEndpoints(dag: DAG): HttpEndpoint[] {
  const endpoints: HttpEndpoint[] = [];
  const seen = new Set<string>();

  for (const node of dag.nodes) {
    if (node.type !== "http.call") continue;
    if (!node.config) continue;

    const { service, method, path } = node.config;

    if (
      typeof service !== "string" ||
      typeof method !== "string" ||
      typeof path !== "string"
    ) {
      continue;
    }

    const key = `${service}|${method}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    endpoints.push({ service, method, path });
  }

  return endpoints;
}
