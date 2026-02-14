process.env.WINDMILL_SERVICE_DATABASE_URL =
  process.env.WINDMILL_SERVICE_DATABASE_URL ??
  "postgresql://test:test@localhost/windmill_test";
process.env.WINDMILL_SERVICE_API_KEY = "test-api-key";
process.env.WINDMILL_BASE_URL = "http://localhost:8000";
process.env.WINDMILL_API_TOKEN = "test-token";
process.env.WINDMILL_WORKSPACE = "test";
process.env.NODE_ENV = "test";
