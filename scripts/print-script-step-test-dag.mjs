#!/usr/bin/env node
/**
 * FACTORY-P2-ENGINES proof: prints the body of `POST /workflows` for a TEST workflow whose one step runs the stored
 * script `message_written/dy_template_writer` on a FICTIONAL person (no real person's data, no send: the step only
 * writes; nothing downstream reads it). Create it on the staff test org only, never on a live pipe:
 *   node scripts/print-script-step-test-dag.mjs <leadId of a staff test lead> > /tmp/script-step-test.json
 */
const leadId = process.argv[2];
if (!leadId) throw new Error("usage: print-script-step-test-dag.mjs <lead id the produced message_written is declared on>");
const node = {
  id: "write-with-script",
  type: "http.call",
  config: {
    service: "workflow",
    method: "POST",
    path: "/orgs/scripts/run",
    body: {
      outcome: "message_written",
      dynasty: "dy_template_writer",
      subject: { service: "lead-service", id: leadId },
      units: {
        lead_identified: {
          subject: { service: "lead-service", id: leadId },
          content: { variables: { leadFirstName: "Robin", leadLastName: "Quill", leadTitle: "Head of Growth", leadCompanyName: "Fictional Kites Ltd", leadCompanyIndustry: "Outdoor toys" } },
        },
        brand_context: { content: { variables: { clientCompanyName: "Reed", clientCompanyOverview: "Reed is a staff test brand used for end-to-end tests.", currentDate: new Date().toISOString().slice(0, 10) } } },
        template_written: {
          content: {
            text:
              "Write a 2-step cold email sequence from {{clientCompanyName}} ({{clientCompanyOverview}}) to {{leadFirstName}}, {{leadTitle}} at {{leadCompanyName}}. " +
              "Step 1 under 80 words, step 2 a short follow-up 3 days later. Today is {{currentDate}}. Answer as JSON: subject, emails[{body, daysSinceLastStep}].",
          },
        },
      },
    },
  },
};
console.log(
  JSON.stringify(
    {
      featureSlug: "factory-engines-test",
      description: "Staff test: one step runs the stored script message_written/dy_template_writer on a fictional person. Sends nothing.",
      dag: { nodes: [node], edges: [] },
    },
    null,
    2,
  ),
);
