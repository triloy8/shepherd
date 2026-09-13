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

test("core and protocol cannot depend on adapters; shared runtime cannot depend on Discord", async () => {
  const violations: string[] = [];
  for (const directory of ["server/core", "shared/protocol", "server/runtime"]) {
    for (const file of await sourceFiles(path.join(root, directory))) {
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
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
            ? target.includes("/adapters/discord/")
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
