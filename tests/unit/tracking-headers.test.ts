import { describe, it, expect } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireIdentity, requireBrandId } from "../../src/middleware/auth.js";

function mockReqRes(headers: Record<string, string>, body?: Record<string, unknown>) {
  const req = { headers, body: body ?? {} } as unknown as Request;
  const locals: Record<string, unknown> = {};
  const res = { locals, status: () => ({ json: () => {} }) } as unknown as Response;
  return { req, res, locals };
}

describe("requireIdentity – tracking headers", () => {
  it("extracts x-brand-id and optional x-campaign-id, x-workflow-name into res.locals", () => {
    const { req, res, locals } = mockReqRes({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-brand-id": "brand-xyz",
      "x-campaign-id": "camp-abc",
      "x-workflow-name": "sales-email-cold-outreach",
    });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(true);
    expect(locals.brandId).toBe("brand-xyz");
    expect(locals.campaignId).toBe("camp-abc");
    expect(locals.workflowName).toBe("sales-email-cold-outreach");
  });

  it("passes without x-brand-id (now optional on identity middleware)", () => {
    const { req, res, locals } = mockReqRes({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
    });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(true);
    expect(locals).not.toHaveProperty("brandId");
    expect(locals).not.toHaveProperty("campaignId");
    expect(locals).not.toHaveProperty("workflowName");
  });

  it("sets brandId in locals when x-brand-id header is present", () => {
    const { req, res, locals } = mockReqRes({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-brand-id": "brand-1",
    });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(true);
    expect(locals.brandId).toBe("brand-1");
  });

  it("rejects requests missing all required identity headers", () => {
    const req = { headers: { "x-campaign-id": "camp-1" } } as unknown as Request;
    let statusCode = 0;
    const res = {
      locals: {},
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    } as unknown as Response;

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireIdentity(req, res, next);

    expect(called).toBe(false);
    expect(statusCode).toBe(400);
  });
});

describe("requireBrandId – execution endpoints", () => {
  it("passes when x-brand-id header is present", () => {
    const { req, res } = mockReqRes({ "x-brand-id": "brand-1" });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireBrandId(req, res, next);

    expect(called).toBe(true);
  });

  it("passes when inputs.brandId is in request body", () => {
    const { req, res } = mockReqRes({}, { inputs: { brandId: "brand-from-body" } });

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireBrandId(req, res, next);

    expect(called).toBe(true);
  });

  it("rejects when neither header nor body has brandId", () => {
    const req = { headers: {}, body: {} } as unknown as Request;
    let statusCode = 0;
    let errorBody: unknown;
    const res = {
      locals: {},
      status: (code: number) => {
        statusCode = code;
        return { json: (b: unknown) => { errorBody = b; } };
      },
    } as unknown as Response;

    let called = false;
    const next: NextFunction = () => { called = true; };

    requireBrandId(req, res, next);

    expect(called).toBe(false);
    expect(statusCode).toBe(400);
    expect(errorBody).toEqual({
      error: "x-brand-id header or inputs.brandId is required for execution endpoints",
    });
  });
});
