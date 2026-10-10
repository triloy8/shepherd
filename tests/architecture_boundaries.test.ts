import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : Promise.resolve(file.endsWith(".ts") ? [file] : []);
  }));
  return nested.flat();
}

test("core and protocol cannot depend on adapters; shared runtime cannot depend on surface transports", async () => {
  const violations: string[] = [];
  for (const directory of ["server/core", "shared/protocol", "server/runtime"]) {
    const files = await sourceFiles(path.join(root, directory));
    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
    for (const [index, file] of files.entries()) {
      const source = ts.createSourceFile(file, contents[index]!, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (directory === "server/core" && ts.isStringLiteralLike(node) && /(?:^|[\s`])![a-z]+(?:[\s`]|$)/.test(node.text)) {
          violations.push(`${path.relative(root, file)} contains surface command instructions`);
        }
        let specifier: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) specifier = node.argument.literal;
        if (specifier && ts.isStringLiteralLike(specifier)) {
          const target = specifier.text.startsWith(".") ? path.resolve(path.dirname(file), specifier.text) : specifier.text;
          const forbidden = directory === "server/runtime"
            ? (target.includes("/adapters/discord/") || target.includes("/adapters/web/"))
            : target.includes("/adapters/") || target.includes("/server/runtime/");
          if (target === "discord.js" || target.startsWith("discord.js/") || forbidden) {
            violations.push(`${path.relative(root, file)} -> ${specifier.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  expect(violations).toEqual([]);
});

test("browser source imports shared protocol rather than server implementation", async () => {
  const violations: string[] = [];
  async function check(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await check(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          const target = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : specifier;
          if (target.includes("/server/") || target.startsWith("node:")) violations.push(`${file}: ${specifier}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  await check(path.join(root, "ui/src"));
  expect(violations).toEqual([]);
});

test("provider SDKs and persistence stay outside application and transport layers", async () => {
  const violations: string[] = [];
  for (const directory of ["server/core", "server/ports", "shared/protocol", "server/storage", "server/adapters", "server/providers"]) {
    for (const file of await sourceFiles(path.join(root, directory))) {
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        let expression: ts.Expression | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) expression = node.moduleSpecifier;
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) expression = node.arguments[0];
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) expression = node.argument.literal;
        if (expression && ts.isStringLiteralLike(expression)) {
          const specifier = expression.text;
          const target = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : specifier;
          const sdk = specifier.startsWith("@anthropic-ai/") || specifier.startsWith("@modelcontextprotocol/");
          const native = target.includes("/server/providers/");
          const storage = target.includes("/server/storage/");
          const upward = target.includes("/server/runtime/") || target.includes("/server/adapters/");
          const forbidden = directory === "server/providers" ? upward : directory === "server/storage" ? sdk || native || upward : sdk || native || storage;
          if (forbidden) violations.push(`${path.relative(root, file)} -> ${specifier}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  expect(violations).toEqual([]);
});

test("additive v2 contracts and ports cannot import v1/native provider contracts", async () => {
  const files = [
    ...await sourceFiles(path.join(root, "shared/protocol/v2")),
    ...["server/ports/provider_v2.ts", "server/core/provider_registry.ts", "server/runtime/provider_defaults.ts", "server/core/projection_event_log.ts"].map(file => path.join(root, file)),
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      let expression: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) expression = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) expression = node.arguments[0];
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) expression = node.argument.literal;
      if (expression && ts.isStringLiteralLike(expression)) {
        const target = path.resolve(path.dirname(file), expression.text);
        if (/\/(schemas|providers)\//.test(target) || /\/shared\/protocol\/(requests|events|approvals|user_input)\.js$/.test(target) || expression.text.startsWith("@anthropic-ai/")) {
          violations.push(`${path.relative(root, file)} -> ${expression.text}`);
        }
      }
      if (!file.endsWith("provider_defaults.ts") && ts.isStringLiteralLike(node) && ["codex", "claude"].includes(node.text)) {
        violations.push(`${path.relative(root, file)} contains a fixed provider identity`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
