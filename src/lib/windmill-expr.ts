/**
 * How Windmill evaluates a `javascript` input transform, so a converted flow never hands a step `null`.
 *
 * Windmill (backend/windmill-jseval `should_add_return_quickjs`) prepends `return` to an expression ONLY when it
 * does not start with a statement keyword (`const `, `if `, `return `, ...) and holds no `;` outside a string.
 * Anything else is run as a function BODY: a single expression with a `;` in it (an arrow with a block body, say)
 * then evaluates to `undefined`, which the step receives as `null`, silently. That is what took every chat-service
 * LLM door to `body: null` on 2026-11-05 (ONE-BRIEF-1105's brief wrapper had a block-bodied arrow): every answering
 * run failed on its first LLM call with a 400 naming every body field "undefined".
 *
 * So the conversion refuses such an expression (`assertFlowTransformsReturnValues`, fail loud at build time instead of a
 * null body at run time), and the tests evaluate expressions the way Windmill does (`evalAsWindmill`).
 */

const STATEMENT_PREFIXES = [
  "const ", "let ", "var ", "if ", "if(", "for ", "for(", "while ", "while(", "switch ", "switch(",
  "try ", "try{", "throw ", "function ", "class ", "async ", "await ",
];

/** Windmill's `contains_semicolon_outside_strings`, char for char (same quote tracking, same escape rule). */
function containsSemicolonOutsideStrings(expr: string): boolean {
  let single = false;
  let double = false;
  let template = false;
  let prev = "\0";
  for (const ch of expr) {
    if (ch === "'" && prev !== "\\" && !double && !template) single = !single;
    else if (ch === '"' && prev !== "\\" && !single && !template) double = !double;
    else if (ch === "`" && prev !== "\\" && !single && !double) template = !template;
    else if (ch === ";" && !single && !double && !template) return true;
    prev = ch;
  }
  return false;
}

/** True when Windmill prepends `return` to this expression (it is then evaluated as an expression). */
export function windmillAddsReturn(expr: string): boolean {
  const t = expr.trim();
  if (!t) return true;
  if (t.startsWith("return ") || t.startsWith("return;") || t === "return") return false;
  if (STATEMENT_PREFIXES.some((p) => t.startsWith(p))) return false;
  return !containsSemicolonOutsideStrings(t);
}

/**
 * Throws when an EXPRESSION (it opens on no statement keyword) holds a `;` outside strings: Windmill then runs it as
 * a function body and, an expression statement returning nothing, the step receives null. A transform that opens on
 * a statement (`const `, `return `, ...) is a body by intent and is the author's to make return.
 */
export function assertWindmillReturnsValue(expr: string, where: string): void {
  if (windmillAddsReturn(expr)) return;
  const t = expr.trim();
  if (t.startsWith("return") || STATEMENT_PREFIXES.some((p) => t.startsWith(p))) return;
  throw new Error(
    `${where}: this javascript input transform holds a ";" outside strings, so Windmill runs it as a function body ` +
      `with no return and the step receives null. Write it as one expression without ";" (arrows with expression ` +
      `bodies, ternaries). Expression: ${t.slice(0, 200)}`,
  );
}

/** Every `javascript` input transform of a converted flow, nested branches and loop bodies included. */
export function assertFlowTransformsReturnValues(modules: unknown, flowName: string): void {
  const walk = (v: unknown, where: string): void => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, where));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : null;
    const transforms = (o.value as { input_transforms?: Record<string, { type?: string; expr?: unknown }> } | undefined)
      ?.input_transforms;
    const here = id ? `${where}/${id}` : where;
    if (id && transforms) {
      for (const [k, t] of Object.entries(transforms)) {
        if (t?.type === "javascript" && typeof t.expr === "string") assertWindmillReturnsValue(t.expr, `${here}.${k}`);
      }
    }
    for (const x of Object.values(o)) walk(x, here);
  };
  walk(modules, flowName);
}

/** Evaluates `expr` the way Windmill does, for tests: `return` prepended only when Windmill would prepend it. */
export function evalAsWindmill(expr: string, scope: Record<string, unknown>): unknown {
  const names = Object.keys(scope);
  const body = windmillAddsReturn(expr) ? `return ${expr.trim()}` : expr;
  // eslint-disable-next-line no-new-func
  const out = new Function(...names, body)(...names.map((n) => scope[n]));
  return out === undefined ? null : out;
}
