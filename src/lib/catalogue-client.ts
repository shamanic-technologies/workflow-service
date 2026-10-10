/**
 * The pipe a workflow runs on, read from features-service's catalogue (the owner of the model).
 *
 * Vocabulary (owner 2026-10-10): a STEP is a stage a person reaches (Lead found, Positive reply,
 * Meeting booked...). A SALES PATH is a chain of steps to Paid client. A CHANNEL is how we work a
 * person. A PIPE is one leg of a path (fromStep -> toStep) worked by one channel; its id is
 * `<channel slug>|<leg key>`. A SALES FUNNEL is a path with one pipe per leg. A WORKFLOW runs on
 * ONE pipe, proactively (it goes and finds its own people) or reactively (a trigger, the pipe's
 * fromStep, hands it someone). A CAMPAIGN is a sales funnel capped by a max budget and a max
 * volume (proactive) or "Up to" (reactive); every pipe stops when the funnel's cap is reached.
 *
 * Nothing here is computed locally: mode, trigger and the step a pipe produces are the pipe's own
 * facts, read as served.
 */
import { z } from "zod";
import type { DownstreamHeaders } from "./downstream-headers.js";

export const CataloguePipeSchema = z.object({
  id: z.string(),
  name: z.string(),
  line: z.string(),
  channelSlug: z.string(),
  channelName: z.string(),
  legKey: z.string(),
  fromStep: z.string(),
  toStep: z.string(),
  mode: z.enum(["proactive", "reactive"]),
  triggerId: z.string().nullable(),
  operatedBy: z.string(),
  runnable: z.boolean(),
});
export type CataloguePipe = z.infer<typeof CataloguePipeSchema>;

const PipeListSchema = z.object({
  total: z.number(),
  truncated: z.boolean(),
  rows: z.array(z.object({ id: z.string(), line: z.string(), mode: z.enum(["proactive", "reactive"]), runnable: z.boolean() })),
});
export type CataloguePipeSummary = z.infer<typeof PipeListSchema>["rows"][number];

export const CatalogueStepSchema = z.object({ id: z.string(), name: z.string(), line: z.string() });
export type CatalogueStep = z.infer<typeof CatalogueStepSchema>;

/** Thrown when the catalogue answers but the request names nothing a workflow can run on. */
export class PipeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipeResolutionError";
  }
}

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.FEATURES_SERVICE_URL;
  const apiKey = process.env.FEATURES_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to read the pipe catalogue");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function catalogueGet<T>(
  path: string,
  schema: z.ZodType<T>,
  downstreamHeaders?: DownstreamHeaders,
): Promise<{ status: 200; body: T } | { status: 404 }> {
  const { baseUrl, apiKey } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { "x-api-key": apiKey, ...downstreamHeaders },
    signal: AbortSignal.timeout(600_000),
  });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`features-service error: GET ${path} -> ${res.status} ${res.statusText}: ${text}`);
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`features-service GET ${path} returned an unexpected shape: ${parsed.error.message}`);
  }
  return { status: 200, body: parsed.data };
}

/** One pipe by id (`<channel slug>|<leg key>`). Throws PipeResolutionError when it does not exist. */
export async function fetchPipe(pipeId: string, downstreamHeaders?: DownstreamHeaders): Promise<CataloguePipe> {
  const r = await catalogueGet(`/internal/catalogue/pipes/${encodeURIComponent(pipeId)}`, CataloguePipeSchema, downstreamHeaders);
  if (r.status === 404) throw new PipeResolutionError(`No pipe "${pipeId}" in the features-service catalogue`);
  return r.body;
}

/** The pipes of one channel (a workflow's featureSlug is its channel slug). */
export async function fetchChannelPipes(
  channelSlug: string,
  downstreamHeaders?: DownstreamHeaders,
): Promise<CataloguePipeSummary[]> {
  const r = await catalogueGet(
    `/internal/catalogue/pipes?channels=${encodeURIComponent(channelSlug)}&limit=25`,
    PipeListSchema,
    downstreamHeaders,
  );
  if (r.status === 404) return [];
  if (r.body.truncated) {
    throw new Error(`features-service lists more than 25 pipes for channel "${channelSlug}": the generator reads one page only`);
  }
  return r.body.rows;
}

/** One step by id. Throws PipeResolutionError when the catalogue does not know it. */
export async function fetchStep(stepId: string, downstreamHeaders?: DownstreamHeaders): Promise<CatalogueStep> {
  const r = await catalogueGet(`/internal/catalogue/steps/${encodeURIComponent(stepId)}`, CatalogueStepSchema, downstreamHeaders);
  if (r.status === 404) throw new PipeResolutionError(`No step "${stepId}" in the features-service catalogue`);
  return r.body;
}
