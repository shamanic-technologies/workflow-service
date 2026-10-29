#!/usr/bin/env node
/**
 * Ops script: the FOUNDER HELLO, created as DATA (FOUNDER-HELLO-1027, `src/lib/founder-hello-dag.ts`). Idempotent,
 * dry run by default, `--apply` to write. Each step reads first and writes only what is missing or behind:
 *
 *  1. features-service: the channel `founder-hello` (conversion, platform, software) and its leg Start -> Positive reply,
 *     reactive on `whatsapp_number_given` (run-time declarations: data, never code).
 *  2. workflow-service: the workflow on that pipe (created, or UPGRADED in its dynasty when its DAG is behind), FIRST so
 *     a new template version never reaches a DAG that cannot read it.
 *  3. content-generation: the template dynasty `founder-hello-whatsapp` on that pipe, its first version the text in
 *     `src/lib/founder-hello-template.ts`; a head whose text differs gets a NEW version (never an edit in place).
 *  4. content-generation: on that pipe only, every writer LLM but GLM is deprecated (owner 2026-10-27: « laisse
 *     uniquement GLM », « WTF tu as choisi Fable c'est bcp trop cher »).
 *
 * Usage, from inside the workflow-service container (dist built):
 *   node seed-founder-hello.mjs            # dry run
 *   node seed-founder-hello.mjs --apply
 * Env (in the container): WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL/_API_KEY, CONTENT_GENERATION_SERVICE_URL/_API_KEY;
 * USER_ID + RUN_ID = a REAL staff identity (runs-service rejects an unknown parent run); STAFF_EMAIL (who decided).
 */
import {
  FOUNDER_HELLO_DESCRIPTION,
  FOUNDER_HELLO_FEATURE_SLUG,
  FOUNDER_HELLO_LEG_KEY,
  FOUNDER_HELLO_PIPE_ID,
  FOUNDER_HELLO_TRIGGER_ID,
  buildFounderHelloDag,
} from "../dist/lib/founder-hello-dag.js";
import {
  FOUNDER_HELLO_TEMPLATE,
  FOUNDER_HELLO_TEMPLATE_DYNASTY_NAME,
  FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG,
  FOUNDER_HELLO_TEMPLATE_VARIABLES,
} from "../dist/lib/founder-hello-template.js";
import { computeDAGSignature } from "../dist/lib/dag-signature.js";

const APPLY = process.argv.includes("--apply");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const WF_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const FEATURES_URL = process.env.FEATURES_SERVICE_URL;
const FEATURES_KEY = process.env.FEATURES_SERVICE_API_KEY;
const CG_URL = process.env.CONTENT_GENERATION_SERVICE_URL;
const CG_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
const ORG_ID = process.env.ORG_ID ?? "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const USER_ID = process.env.USER_ID;
const RUN_ID = process.env.RUN_ID;
const STAFF_EMAIL = process.env.STAFF_EMAIL ?? "kevin@distribute.you";
const ACTOR = "staff:FOUNDER-HELLO-1027";

if (!WF_KEY || !FEATURES_URL || !FEATURES_KEY || !CG_URL || !CG_KEY || !USER_ID || !RUN_ID) {
  console.error("WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL/_API_KEY, CONTENT_GENERATION_SERVICE_URL/_API_KEY, USER_ID and RUN_ID are required");
  process.exit(1);
}

async function call(base, key, method, path, body, extra = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {}
  return { status: res.status, payload };
}
const must = (r, what, ok = [200, 201]) => {
  if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.payload).slice(0, 600)}`);
  return r.payload;
};
const act = async (what, fn) => {
  if (!APPLY) return console.log(`WOULD ${what}`);
  await fn();
  console.log(`DONE ${what}`);
};

// 1. Channel + leg.
const channel = await call(FEATURES_URL, FEATURES_KEY, "GET", `/internal/declarations/channels/${FOUNDER_HELLO_FEATURE_SLUG}`);
if (channel.status === 404) {
  await act(`declare channel ${FOUNDER_HELLO_FEATURE_SLUG}`, async () =>
    must(
      await call(FEATURES_URL, FEATURES_KEY, "POST", "/internal/declarations/channels", {
        slug: FOUNDER_HELLO_FEATURE_SLUG,
        name: "Founder Hello",
        description:
          "The founder says hello once on WhatsApp to a person who just set up the product, naming what they set up themselves, to start a conversation.",
        shortDescription: "One WhatsApp hello from the founder",
        icon: "hand-waving",
        channelType: "conversion",
        operatedBy: "platform",
        performedBy: "software",
        dailyOperatingCostCents: 0,
        minimumCommitmentDays: 1,
        maxDaysToFirstProduction: 0,
        createdBy: ACTOR,
      }),
      "declare channel",
    ),
  );
} else {
  must(channel, "read channel", [200]);
  console.log(`channel ${FOUNDER_HELLO_FEATURE_SLUG} exists`);
}
const legs = channel.status === 200 ? channel.payload.legs ?? channel.payload.channel?.legs ?? [] : [];
if (!legs.some((l) => l.legKey === FOUNDER_HELLO_LEG_KEY)) {
  await act(`declare leg ${FOUNDER_HELLO_PIPE_ID} on ${FOUNDER_HELLO_TRIGGER_ID}`, async () =>
    must(
      await call(FEATURES_URL, FEATURES_KEY, "POST", `/internal/declarations/channels/${FOUNDER_HELLO_FEATURE_SLUG}/legs`, {
        fromStep: null,
        toStep: "conversation",
        mode: "reactive",
        triggerId: FOUNDER_HELLO_TRIGGER_ID,
        published: true,
        createdBy: ACTOR,
      }),
      "declare leg",
    ),
  );
} else {
  console.log(`leg ${FOUNDER_HELLO_PIPE_ID} exists`);
}
const published = channel.status === 200 && (channel.payload.published ?? channel.payload.channel?.published) === true;
if (!published) {
  await act(`publish channel ${FOUNDER_HELLO_FEATURE_SLUG}`, async () =>
    must(
      await call(FEATURES_URL, FEATURES_KEY, "PATCH", `/internal/declarations/channels/${FOUNDER_HELLO_FEATURE_SLUG}`, { published: true, updatedBy: ACTOR }),
      "publish channel",
    ),
  );
}

// 2. The workflow, BEFORE the template: a template version the stored DAG cannot read yet (FOUNDER-HELLO-SOPHIE-NUMBER-1029: the assistant marker) never reaches a live run.
const wfHeaders = { "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };
const current = buildFounderHelloDag();
const listed = must(
  await call(BASE_URL, WF_KEY, "GET", `/workflows?featureSlug=${FOUNDER_HELLO_FEATURE_SLUG}&status=active`, undefined, wfHeaders),
  "list workflows",
  [200],
);
const rows = Array.isArray(listed) ? listed : listed.workflows ?? [];
if (rows.length === 0) {
  await act(`create the workflow on ${FOUNDER_HELLO_PIPE_ID}`, async () => {
    const created = must(
      await call(
        BASE_URL,
        WF_KEY,
        "POST",
        "/workflows",
        { featureSlug: FOUNDER_HELLO_FEATURE_SLUG, pipeId: FOUNDER_HELLO_PIPE_ID, description: FOUNDER_HELLO_DESCRIPTION, dag: current },
        wfHeaders,
      ),
      "create workflow",
      [201],
    );
    console.log(`created ${created.workflowSlug}`);
  });
}
for (const w of rows) {
  if (computeDAGSignature(w.dag) === computeDAGSignature(current)) {
    console.log(`${w.workflowSlug} is current`);
    continue;
  }
  await act(`upgrade ${w.workflowDynastySlug}`, async () => {
    const up = must(
      await call(
        BASE_URL,
        WF_KEY,
        "POST",
        "/workflows/upgrade",
        { workflowDynastySlug: w.workflowDynastySlug, dag: current, description: FOUNDER_HELLO_DESCRIPTION },
        wfHeaders,
      ),
      `upgrade ${w.workflowDynastySlug}`,
    );
    console.log(`upgraded -> ${(up.workflow ?? up).workflowSlug}`);
  });
}

// 3. Template dynasty.
const dynasty = await call(CG_URL, CG_KEY, "GET", `/internal/template-dynasties/${FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG}/head`);
if (dynasty.status === 404) {
  await act(`create template dynasty ${FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG}`, async () =>
    must(
      await call(
        CG_URL,
        CG_KEY,
        "POST",
        "/internal/template-dynasties",
        {
          slug: FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG,
          name: FOUNDER_HELLO_TEMPLATE_DYNASTY_NAME,
          description: "The founder's one WhatsApp hello to a person who just set up the product, naming what they set up.",
          signature: "Hello, who you are in a few words, one line naming what they set up, their one next step. No question about what they told us.",
          identity: "named",
          featureSlug: FOUNDER_HELLO_FEATURE_SLUG,
          legKey: FOUNDER_HELLO_LEG_KEY,
          template: { prompt: FOUNDER_HELLO_TEMPLATE, variables: FOUNDER_HELLO_TEMPLATE_VARIABLES },
        },
        { "x-org-id": ORG_ID, "x-staff-email": STAFF_EMAIL },
      ),
      "create template dynasty",
    ),
  );
} else {
  const head = must(dynasty, "read template head", [200]);
  if ((head.template?.prompt ?? "").trim() === FOUNDER_HELLO_TEMPLATE.trim()) {
    console.log(`template dynasty ${FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG} head is current (${head.template?.type})`);
  } else {
    await act(`add a version to ${FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG} (head ${head.template?.type} differs)`, async () =>
      must(
        await call(
          CG_URL,
          CG_KEY,
          "POST",
          `/internal/template-dynasties/${FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG}/versions`,
          { prompt: FOUNDER_HELLO_TEMPLATE, variables: FOUNDER_HELLO_TEMPLATE_VARIABLES },
          { "x-staff-email": STAFF_EMAIL },
        ),
        "add template version",
      ),
    );
  }
}

// 4. GLM only on this pipe.
const models = must(
  await call(CG_URL, CG_KEY, "GET", `/internal/models?featureSlug=${FOUNDER_HELLO_FEATURE_SLUG}&legKey=${FOUNDER_HELLO_LEG_KEY}`),
  "list models",
  [200],
).models;
const isGlm = (m) => /^glm/i.test(m.model) || /^glm/i.test(m.dynasty ?? "");
if (!models.some((m) => isGlm(m) && m.status === "active")) throw new Error("no active GLM model on the pipe: nothing would write the hello");
for (const m of models.filter((x) => !isGlm(x) && x.status !== "deprecated")) {
  await act(`deprecate ${m.model} on ${FOUNDER_HELLO_PIPE_ID}`, async () =>
    must(
      await call(
        CG_URL,
        CG_KEY,
        "PUT",
        `/internal/models/${encodeURIComponent(m.model)}/status`,
        {
          status: "deprecated",
          reason: "The founder hello writes with GLM only (owner 2026-10-27: « laisse uniquement GLM, c'est très bien »)",
          featureSlug: FOUNDER_HELLO_FEATURE_SLUG,
          legKey: FOUNDER_HELLO_LEG_KEY,
        },
        { "x-staff-email": STAFF_EMAIL },
      ),
      `deprecate ${m.model}`,
    ),
  );
}

