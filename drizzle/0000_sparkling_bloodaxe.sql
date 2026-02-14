CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid,
	"org_id" text NOT NULL,
	"campaign_id" text,
	"subrequest_id" text,
	"run_id" text,
	"windmill_job_id" text,
	"windmill_workspace" text DEFAULT 'prod' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"inputs" jsonb,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text,
	"campaign_id" text,
	"subrequest_id" text,
	"name" text NOT NULL,
	"description" text,
	"dag" jsonb NOT NULL,
	"windmill_flow_path" text,
	"windmill_workspace" text DEFAULT 'prod' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_workflow" ON "workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_windmill_job" ON "workflow_runs" USING btree ("windmill_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_status" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_org" ON "workflow_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_org" ON "workflows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_campaign" ON "workflows" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_status" ON "workflows" USING btree ("status");