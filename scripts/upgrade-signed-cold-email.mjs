// SENDER-NAME-BODY-1111: the cold email scripts that CHOOSE the signature (tactic `signedBy`) decide it before the
// writer and hand it over (`coldEmailSignatureFirstSource`, sender-identity.ts). One UPGRADE per dynasty (never a fork).
// Dry run by default (prints the diff size); `--apply` upgrades. Skips a dynasty whose active version already hands
// the signature. Run inside the workflow-service container (it reads dist):
//   docker exec -e ORG_ID=… -e USER_ID=… -e RUN_ID=… -e STAFF_EMAIL=… distribute-workflow-service-1 node scripts/upgrade-signed-cold-email.mjs [--apply]
const { coldEmailSignatureFirstSource } = await import("../dist/lib/scripts/sender-identity.js");

const DYNASTIES = ["dy_cold_email_signed_sender_client_brand", "dy_cold_email_signed_client_person"];
const OUTCOME = "email_sent";
const apply = process.argv.includes("--apply");

const key = process.env.WORKFLOW_SERVICE_API_KEY;
const { ORG_ID, USER_ID, RUN_ID, STAFF_EMAIL } = process.env;
if (!key) throw new Error("WORKFLOW_SERVICE_API_KEY is required");
if (!ORG_ID || !USER_ID || !RUN_ID || !STAFF_EMAIL) throw new Error("ORG_ID, USER_ID, RUN_ID and STAFF_EMAIL (a real staff identity: who decided) are required");
const headers = { "x-api-key": key, "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID, "x-email": STAFF_EMAIL, "content-type": "application/json" };
const base = (process.env.WORKFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");

async function json(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

let failed = false;
for (const dynasty of DYNASTIES) {
  const dyn = await json(await fetch(`${base}/scripts/dynasty/${OUTCOME}/${dynasty}`, { headers }), `read ${dynasty}`);
  const active = dyn.versions?.find((v) => v.runnable);
  if (!active) {
    console.log(`${dynasty}: no runnable version, skipped`);
    continue;
  }
  const current = await json(await fetch(`${base}/scripts/${active.id}`, { headers }), `read ${active.scriptSlug}`);
  if (current.code.includes("request: { signature: statedSignature }")) {
    console.log(`${dynasty}: ${active.scriptSlug} already hands the signature to the writer, skipped`);
    continue;
  }
  const code = coldEmailSignatureFirstSource(current.code);
  console.log(`${dynasty}: ${active.scriptSlug} -> next version (${current.code.length} -> ${code.length} chars)${apply ? "" : " (dry run)"}`);
  if (!apply) continue;
  const res = await fetch(`${base}/scripts/dynasty/${OUTCOME}/${dynasty}/upgrade`, { method: "POST", headers, body: JSON.stringify({ code }) });
  const text = await res.text();
  console.log(`  ${res.status} ${text.slice(0, 400)}`);
  if (!res.ok) failed = true;
}
process.exit(failed ? 1 : 0);
