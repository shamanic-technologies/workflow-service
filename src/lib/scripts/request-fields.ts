/**
 * ENGINE-GET-ASK-1123: the Request fields a script's code reads (`ctx.request.<field>`), read off the code like its
 * materials are, so a caller asking the Engine outside a campaign knows what to state in `request`
 * (`email_checked/dy_email_check` reads `request.email`; a caller that sent `{emails: [...]}` got `unmade: no_email`).
 *
 * Spellings read (types stripped first; strings and comments never read as code):
 * - `ctx.request.x`, `ctx.request?.x`, `(ctx.request as T)?.x`, `ctx.request["x"]`, the context under the run
 *   function's own parameter name or a variable it was copied to (`ctx_ = ctx`);
 * - an alias of the whole Request, `const R = ctx.request`, `= ctx.request ?? {}`, `= (ctx.request || {})`, then `R.x`,
 *   `R?.x`, `R["x"]`, inside the block that declares it and not where the name is declared again (another `r`);
 * - destructuring, `const { a, b: c, d = 1 } = ctx.request` (or from an alias).
 * Top-level fields only (`trigger`, never `trigger.leadId`). NOT read as fields: the Request handed whole to a function
 * or to an asked Engine (`ctx.ask({ request: R })`: the fields the asked script reads are that script's) or walked key
 * by key; `readRequest` says so (`whole`), never guesses them. A field named by a computed key is not read.
 */
import { transform } from "sucrase";

const IDENT = "[A-Za-z_$][\\w$]*";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a `/` at `i` opens a regex literal (after an operator, an opening bracket or a keyword), not a division. */
function regexMayStart(js: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (js[k] === " " || js[k] === "\t" || js[k] === "\n")) k--;
  if (k < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(js[k]!)) return true;
  return /(?:^|[^\w$.])(?:return|typeof|case|in|of|void|delete)$/.test(js.slice(Math.max(0, k - 10), k + 1));
}

/** The text with every string, template and comment blanked (same length): only code is left to read. */
function codeOnly(js: string): string {
  const out = js.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < js.length) {
    const c = js[i]!;
    const d = js[i + 1];
    if (c === "/" && d === "/") {
      const end = js.indexOf("\n", i);
      const to = end < 0 ? js.length : end;
      blank(i, to);
      i = to;
    } else if (c === "/" && d === "*") {
      const end = js.indexOf("*/", i + 2);
      const to = end < 0 ? js.length : end + 2;
      blank(i, to);
      i = to;
    } else if (c === "/" && regexMayStart(js, i)) {
      // A regex literal (its quotes and braces are not code): to its closing slash, classes and escapes honoured.
      let j = i + 1;
      let inClass = false;
      while (j < js.length && js[j] !== "\n" && (inClass || js[j] !== "/")) {
        if (js[j] === "\\") j++;
        else if (js[j] === "[") inClass = true;
        else if (js[j] === "]") inClass = false;
        j++;
      }
      blank(i + 1, Math.min(j, js.length));
      i = j + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < js.length && js[j] !== c) j += js[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, js.length));
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

/** For each index, the `{` that opens its innermost block (-1 at the top), and each block's closing index. */
function blocksOf(code: string): { openAt: Int32Array; closeOf: Map<number, number> } {
  const openAt = new Int32Array(code.length).fill(-1);
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "}") {
      const o = stack.pop();
      if (o !== undefined) closeOf.set(o, i);
    }
    openAt[i] = stack.length ? stack[stack.length - 1]! : -1;
    if (code[i] === "{") stack.push(i);
  }
  for (const o of stack) closeOf.set(o, code.length);
  return { openAt, closeOf };
}

export function readRequestFields(source: string): string[] {
  return readRequest(source).fields;
}

/**
 * `fields` = the top-level Request fields the code reads; `whole` = it also uses the Request as ONE value (handed to a
 * function, a vendor or an asked Engine, spread, or walked key by key), so fields beyond `fields` may count: those are
 * read by whoever receives it (`llm_completion` forwards every field of its Request to the model call).
 */
export function readRequest(source: string): { fields: string[]; whole: boolean } {
  let js = source;
  try {
    js = transform(source, { transforms: ["typescript"], disableESTransforms: true }).code;
  } catch {
    // Not parseable as TypeScript: read as written.
  }
  const code = codeOnly(js);
  const { openAt, closeOf } = blocksOf(code);
  const scopeOf = (at: number): [number, number] => {
    const o = openAt[at]!;
    return o < 0 ? [0, code.length] : [o, closeOf.get(o) ?? code.length];
  };
  const fields = new Set<string>();
  let whole = false;
  /** The Request (as `subject`) used as one value: an argument, a property value, a spread, its keys walked. */
  const usedWhole = (subject: string, from: number, to: number, skip: Array<[number, number]> = []) => {
    // A spread's own dots sit right before the name: read it without the "not after a dot" guard.
    const bare = subject.replace("(?<![\\w$.])", "");
    const rx = new RegExp(`(?:(?:[(,:]|\\bin\\s)\\s*${subject}|\\.\\.\\.\\s*${bare})\\s*(?=[,)}\\]])`, "g");
    rx.lastIndex = from;
    for (let m = rx.exec(code); m && m.index < to; m = rx.exec(code)) if (!skip.some(([a, b]) => m!.index > a && m!.index < b)) whole = true;
  };

  // The context's names: the run function's parameter, and a variable it was copied to.
  const ctxNames = new Set<string>(["ctx"]);
  const run = code.match(new RegExp(`export\\s+default\\s+(?:async\\s+)?function\\s*(?:${IDENT})?\\s*\\(\\s*(${IDENT})`));
  if (run) ctxNames.add(run[1]!);
  for (const m of code.matchAll(new RegExp(`(${IDENT})\\s*=\\s*(${IDENT})\\s*[;\\n]`, "g"))) if (ctxNames.has(m[2]!)) ctxNames.add(m[1]!);
  const CTX = `(?<![\\w$.])(?:${[...ctxNames].map(esc).join("|")})\\s*\\.\\s*request\\b`;
  /** The whole Request as a value: `ctx.request`, optionally defaulted to `{}`, optionally in parentheses. */
  const WHOLE = `\\(?\\s*${CTX}\\s*(?:(?:\\?\\?|\\|\\|)\\s*\\{\\s*\\})?\\s*\\)?`;

  /** The fields read off `subject` (a regex source) between two indexes: `.x`, `?.x`, `["x"]`. */
  const readOff = (subject: string, from: number, to: number, skip: Array<[number, number]> = []) => {
    const dotted = new RegExp(`${subject}\\s*\\)?\\s*(?:\\?\\.|\\.)\\s*(${IDENT})|${subject}\\s*\\)?\\s*(?:\\?\\.)?\\s*\\[\\s*(["'])`, "g");
    dotted.lastIndex = from;
    for (let m = dotted.exec(code); m && m.index < to; m = dotted.exec(code)) {
      if (skip.some(([a, b]) => m!.index > a && m!.index < b)) continue;
      if (m[1]) {
        if (m[1] !== "request" || subject !== CTX) fields.add(m[1]);
      } else {
        // A literal key: its text is in the unblanked source at the same place.
        const open = m.index + m[0].length;
        const close = js.indexOf(m[2]!, open);
        const key = close > open ? js.slice(open, close) : "";
        if (new RegExp(`^${IDENT}$`).test(key) && /^\s*\]/.test(code.slice(close + 1))) fields.add(key);
      }
    }
  };
  readOff(CTX, 0, code.length);
  usedWhole(CTX, 0, code.length);

  const destructured = (names: string) => {
    for (const part of names.split(",")) {
      const key = part.trim().split(/[:=]/)[0]!.trim();
      if (key && !key.startsWith("...") && new RegExp(`^${IDENT}$`).test(key)) fields.add(key);
    }
  };
  const END = `\\s*(?=[;\\n,]|$)`;
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*${WHOLE}${END}`, "g"))) destructured(m[1]!);

  // Aliases of the whole Request, each read inside its own block, outside any block that declares the name again.
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+(${IDENT})\\s*=\\s*${WHOLE}${END}`, "g"))) {
    const name = m[1]!;
    const [, end] = scopeOf(m.index!);
    const from = m.index! + m[0].length;
    const NAME = `(?<![\\w$.])${esc(name)}(?![\\w$])`;
    const shadows: Array<[number, number]> = [];
    const again = new RegExp(`(?:const|let|var)\\s+(?:${NAME}|\\{[^}]*${NAME}[^}]*\\})\\s*=|function\\s*(?:${IDENT})?\\s*\\(([^)]*)\\)\\s*\\{|\\(([^()]*)\\)\\s*=>\\s*\\{|${NAME}\\s*=>\\s*\\{`, "g");
    again.lastIndex = from;
    for (let s = again.exec(code); s && s.index < end; s = again.exec(code)) {
      const params = s[1] ?? s[2];
      if (params !== undefined) {
        if (!new RegExp(NAME).test(params)) continue;
        const open = s.index + s[0].length - 1;
        shadows.push([open, closeOf.get(open) ?? code.length]);
      } else if (s[0].endsWith("{")) {
        const open = s.index + s[0].length - 1;
        shadows.push([open, closeOf.get(open) ?? code.length]);
      } else {
        const [a, b] = scopeOf(s.index);
        // Declared again in a block inside the alias's: that block is another variable's.
        if (a > m.index!) shadows.push([a, b]);
      }
    }
    readOff(NAME, from, end, shadows);
    usedWhole(NAME, from, end, shadows);
    const from2 = new RegExp(`(?:const|let|var)\\s+\\{([^}]*)\\}\\s*=\\s*${NAME}${END}`, "g");
    from2.lastIndex = from;
    for (let d = from2.exec(code); d && d.index < end; d = from2.exec(code)) if (!shadows.some(([a, b]) => d!.index > a && d!.index < b)) destructured(d[1]!);
  }
  return { fields: [...fields].sort(), whole };
}
