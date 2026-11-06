import { describe, expect, it } from "vitest";
import { assertFlowTransformsReturnValues, evalAsWindmill, windmillAddsReturn } from "../../src/lib/windmill-expr.js";

describe("windmill-expr: Windmill's implicit return", () => {
  it("adds it to a plain expression, even with a ';' inside a string", () => {
    expect(windmillAddsReturn(`results.a?.b`)).toBe(true);
    expect(windmillAddsReturn(`({ a: "x; y", b: 'it\\'s' })`)).toBe(true);
  });

  it("does not add it when a ';' sits outside strings or the text opens on a statement", () => {
    expect(windmillAddsReturn(`((b) => { const x = b; return x; })(1)`)).toBe(false);
    expect(windmillAddsReturn(`const x = 1; return x`)).toBe(false);
    expect(windmillAddsReturn(`return 1`)).toBe(false);
  });

  it("a block-bodied arrow evaluates to null under Windmill: the 2026-11-05 body: null", () => {
    expect(evalAsWindmill(`((b) => { const x = b; return x; })({ a: 1 })`, {})).toBeNull();
    expect(evalAsWindmill(`((b) => b)({ a: 1 })`, {})).toEqual({ a: 1 });
  });

  it("the conversion guard refuses an expression Windmill would evaluate to null, nested or not", () => {
    const flow = (expr: string) => ({
      modules: [{ id: "outer", value: { type: "branchone", branches: [{ modules: [{ id: "draft", value: { type: "script", input_transforms: { body: { type: "javascript", expr } } } }] }] } }],
    });
    expect(() => assertFlowTransformsReturnValues(flow(`((b) => { return b; })(1)`), "f")).toThrow(/f\/outer\/draft\.body/);
    expect(() => assertFlowTransformsReturnValues(flow(`((b) => b)(1)`), "f")).not.toThrow();
    expect(() => assertFlowTransformsReturnValues(flow(`const x = 1; return x`), "f")).not.toThrow();
  });
});
