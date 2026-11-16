/**
 * ONE-WRITER-N-MODELS-1116: prints the catalogue writes that move the cold email onto one writer per way of writing
 * (one JSON line each, dry by construction; pipe them into `scripts/post-catalogue-ops.mjs`). Reads ONE JSON object
 * on stdin, read from production right before (the stored code is the source of truth):
 *   {writer: <code of message_written/dy_template_writer_full>, sender: <code of email_sent/dy_cold_email_signed_sender_client_brand>,
 *    senders: {<dynasty>: <its active tactics>}, copies: [{dynasty, template, model}]}
 * Phases (`--phase`): `writers` = the 5 writers created (inert: nobody asks them yet); `senders` = the 4 senders
 * UPGRADED to ask a writer (live at once); `merges` = every per-model copy merged (retired, history placed).
 */
import { readFileSync } from "node:fs";
import {
  buildSenderSource,
  buildWriterSource,
  mergePlaces,
  MERGE_REASON,
  SENDER_OUTCOME,
  SENDERS,
  senderTactics,
  WAYS_OF_WRITING,
  WRITER_OUTCOME,
  writerDescription,
  writerTactics,
  type ColdCopy,
} from "./cold-email-one-writer.js";

const phase = process.argv[process.argv.indexOf("--phase") + 1];
if (!["writers", "senders", "merges"].includes(phase ?? "")) throw new Error("--phase writers|senders|merges");
const input = JSON.parse(readFileSync(0, "utf8")) as { writer: string; sender: string; senders: Record<string, Record<string, unknown>>; copies: ColdCopy[] };
const out = (o: unknown) => console.log(JSON.stringify(o));

if (phase === "writers") {
  const code = buildWriterSource(input.writer);
  for (const way of WAYS_OF_WRITING) {
    out({ op: "create", body: { outcome: WRITER_OUTCOME, dynasty: way.dynasty, name: way.name, code, description: writerDescription(way), tactics: writerTactics(way) } });
  }
}
if (phase === "senders") {
  const code = buildSenderSource(input.sender);
  for (const dynasty of SENDERS) {
    const current = input.senders[dynasty];
    if (!current) throw new Error(`no active tactics for ${SENDER_OUTCOME}/${dynasty}`);
    out({ op: "create", body: { outcome: SENDER_OUTCOME, dynasty, code, description: "Serves one person, asks the way of writing the Rating picks for the email, and sends it. It names no template and no model.", tactics: senderTactics(current) } });
  }
}
if (phase === "merges") {
  for (const copy of input.copies) {
    out({ op: "merge", absorbed: `${SENDER_OUTCOME}/${copy.dynasty}`, places: mergePlaces(copy), reason: MERGE_REASON });
  }
}
