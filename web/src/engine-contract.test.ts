import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENGINE_CONTRACT, ENGINE_REQUEST_TYPES, engineRequestType } from "./engine-contract";

const source = readFileSync(new URL("../../crates/spektrafilm-web/src/lib.rs", import.meta.url), "utf8");

/** Returns the text inside the parentheses that start at or after `from`, respecting nesting. */
function argumentList(text: string, from: number) {
  const open = text.indexOf("(", from);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced argument list at ${from}`);
}

/** Counts declared Rust parameters, ignoring the receiver and any generic/tuple commas. */
function arity(args: string) {
  let depth = 0;
  const parameters: string[] = [];
  let current = "";
  for (const character of args) {
    if ("(<[".includes(character)) depth += 1;
    if (")>]".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parameters.push(current);
      current = "";
    } else current += character;
  }
  parameters.push(current);
  return parameters
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter.length > 0 && !/^&?(mut )?self$/.test(parameter)).length;
}

/** Every `#[wasm_bindgen]`-exported free function, mapped to its declared parameter count. */
function exportedFunctions() {
  const found: Record<string, number> = {};
  const pattern = /#\[wasm_bindgen\]\s*(?:#\[[^\]]*\]\s*|\/\/[^\n]*\n\s*)*pub (?:async )?fn (\w+)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    found[match[1]] = arity(argumentList(source, match.index + match[0].length - 1));
  }
  return found;
}

/** Every `pub fn` inside the `#[wasm_bindgen] impl BrowserEngine` block. */
function engineMethods() {
  const start = source.indexOf("#[wasm_bindgen]\nimpl BrowserEngine {");
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf("\n}\n", start));
  const found: Record<string, number> = {};
  for (const match of block.matchAll(/pub (?:async )?fn (\w+)\s*\(/g)) {
    found[match[1]] = arity(argumentList(block, match.index + match[0].length - 1));
  }
  return found;
}

describe("engine contract", () => {
  it("names exactly the free functions the Rust crate exports to JavaScript", () => {
    expect(ENGINE_CONTRACT.functions).toEqual(exportedFunctions());
  });

  it("names exactly the BrowserEngine methods the Rust crate exports to JavaScript", () => {
    expect(ENGINE_CONTRACT.engine).toEqual(engineMethods());
  });
});

describe("engine request routing", () => {
  it("accepts every request type the worker handles", () => {
    for (const type of ENGINE_REQUEST_TYPES) expect(engineRequestType({ id: 1, type })).toBe(type);
  });

  it("rejects an unknown request instead of falling through to another handler", () => {
    expect(() => engineRequestType({ id: 1, type: "inspct" })).toThrow(/Unknown engine request: "inspct"/);
  });

  it("rejects a request with no usable type", () => {
    expect(() => engineRequestType({ id: 1 })).toThrow(/Unknown engine request/);
    expect(() => engineRequestType(null)).toThrow(/Unknown engine request/);
  });
});
