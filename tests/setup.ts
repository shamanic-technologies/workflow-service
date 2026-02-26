process.env.WORKFLOW_SERVICE_DATABASE_URL =
  process.env.WORKFLOW_SERVICE_DATABASE_URL ??
  "postgresql://test:test@localhost/windmill_test";
process.env.WORKFLOW_SERVICE_API_KEY = "test-api-key";
process.env.WINDMILL_SERVER_URL = "http://localhost:8000";
process.env.WINDMILL_SERVER_API_KEY = "test-windmill-token";
process.env.WINDMILL_SERVER_WORKSPACE = "test";
process.env.KEY_SERVICE_URL = "http://localhost:4000";
process.env.KEY_SERVICE_API_KEY = "test-key-svc-key";
process.env.RUNS_SERVICE_URL = "http://localhost:5000";
process.env.RUNS_SERVICE_API_KEY = "test-runs-svc-key";
process.env.EMAIL_GATEWAY_SERVICE_URL = "http://localhost:6000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "test-email-gw-key";
process.env.NODE_ENV = "test";
