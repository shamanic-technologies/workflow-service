/**
 * COPY-SIGNER-1121: prints the catalogue writes that UPGRADE each sender of `COPY_SIGNER_SENDERS` to a version able to
 * copy (Cc) the person its email is signed as (`addCopySigner` on its STORED code, tactics + `copiesSigner: true`, the
 * description + one sentence saying so, which is what features-service's script tactic is judged on).
 * Input on stdin: one JSON line per active version, `{outcome, dynasty, code, tactics, description}` (read on the box).
 * Output: one `create` op per dynasty (already stored = upgraded) for the container's poster:
 *   … | npx tsx scripts/engine-ports/copy-signer-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * A version already able to copy is skipped (stderr).
 */
import { readFileSync } from "node:fs";
import { COPY_SIGNER_SENDERS, addCopySigner, copySignerTactics } from "../../src/lib/scripts/copy-signer.js";

export const COPY_SIGNER_SENTENCE =
  "When the campaign brief asks that emails copy the person they are signed as, it signs as the brand's sales rep and copies that rep on every email.";

const wanted = new Set(COPY_SIGNER_SENDERS.map((s) => `${s.outcome}/${s.dynasty}`));
const lines = readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "");
const seen = new Set<string>();
for (const line of lines) {
  const s = JSON.parse(line) as { outcome: string; dynasty: string; code: string; tactics: Record<string, unknown>; description: string };
  const id = `${s.outcome}/${s.dynasty}`;
  if (!wanted.has(id)) continue;
  seen.add(id);
  if (s.code.includes("function copiedSigner(")) {
    console.error(`${id}: already copies its signer, skipped`);
    continue;
  }
  const description = s.description.includes(COPY_SIGNER_SENTENCE) ? s.description : `${s.description.trim()} ${COPY_SIGNER_SENTENCE}`;
  console.log(JSON.stringify({ op: "create", body: { outcome: s.outcome, dynasty: s.dynasty, code: addCopySigner(s.code), tactics: copySignerTactics(s.tactics), description } }));
}
const missing = [...wanted].filter((w) => !seen.has(w));
if (missing.length) throw new Error(`no stored version read for ${missing.join(", ")}: nothing printed for them`);
