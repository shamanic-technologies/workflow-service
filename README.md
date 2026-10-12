# workflow-service

Workflow orchestration service wrapping Windmill. Translates internal DAG format to Windmill OpenFlow, manages workflow lifecycle, and tracks executions.

## Setup

```bash
npm install
cp .env.example .env  # fill in values
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `WINDMILL_SERVER_URL` | Windmill instance URL |
| `WINDMILL_SERVER_API_KEY` | Windmill Bearer token |
| `WINDMILL_SERVER_WORKSPACE` | Windmill workspace (default: `prod`) |
| `WORKFLOW_SERVICE_DATABASE_URL` | Neon Postgres connection string |
| `WORKFLOW_SERVICE_API_KEY` | API key for incoming service-to-service auth |
| `WORKFLOW_SERVICE_URL` | Public URL of this service |
| `API_SERVICE_URL` | api-service (customer API gateway), read by the figure reader. Never forwarded to flows |
| `ADMIN_DISTRIBUTE_API_KEY` | Gateway key the figure reader acts with, as ONE recipient. Never forwarded to flows |
| `PORT` | HTTP port (default: `3000`) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (DB + Windmill) |
| POST | `/workflows` | Create a workflow |
| GET | `/workflows?orgId=X` | List workflows |
| GET | `/workflows/:id` | Get a workflow |
| PUT | `/workflows/:id` | Update a workflow |
| DELETE | `/workflows/:id` | Soft delete a workflow |
| POST | `/workflows/:id/validate` | Validate DAG |
| POST | `/workflows/:id/execute` | Execute a workflow |
| GET | `/workflow-runs/:id` | Get run status |
| GET | `/workflow-runs` | List runs |
| POST | `/workflow-runs/:id/cancel` | Cancel a run |
| POST | `/orgs/figures/read` | Read the figures a message needs (public + the recipient's own account) |
| GET | `/openapi.json` | OpenAPI spec |

## What an instruction may ask for (figures)

A workflow instruction (e.g. the `instruction` of an AI Follow-up Email campaign, written by the Copilot) may ask
for a figure WITHOUT stating it: "give Marie her exact cost per booked meeting and compare it to the $42 estimate".
At run time the workflow reads it (`POST /orgs/figures/read`) from:

- **The recipient's own account**: anything the customer API (`/v1`, GET) serves for the organization(s) the
  person the email goes to belongs to: spend, costs, results, campaigns, offers, leads, billing. Read as that
  person, exactly what their dashboard shows.
- **Public data**: our public catalogue routes, and the live web.

It can NEVER read another organization's figure. An instruction asking for one (another client, another
company the recipient does not belong to, an id typed into the instruction) gets nothing: the email is not sent
and the run names why. A recipient who belongs to no organization (a prospect) gets public figures only.

