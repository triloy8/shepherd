import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "..");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : Promise.resolve(/\.tsx?$/.test(file) ? [file] : []);
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
          // Adapters implement ports; application services are never a provider dependency.
          const core = target.includes("/server/core/");
          const forbidden = directory === "server/providers" ? upward || core : directory === "server/storage" ? sdk || native || upward : sdk || native || storage;
          if (forbidden) violations.push(`${path.relative(root, file)} -> ${specifier}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  expect(violations).toEqual([]);
});

test("application contracts and ports cannot depend on provider implementations or identities", async () => {
  const files = [...await sourceFiles(path.join(root, "shared/protocol")), ...await sourceFiles(path.join(root, "server/core")), ...await sourceFiles(path.join(root, "server/adapters")), ...await sourceFiles(path.join(root, "ui/src")), path.join(root, "server/ports/provider_session.ts"), path.join(root, "server/ports/provider_services.ts"), path.join(root, "server/storage/thread_provider_directory.ts"), path.join(root, "server/runtime/provider_registration.ts")];
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
        if (/\/(schemas|providers)\//.test(target) || expression.text.startsWith("@anthropic-ai/")) {
          violations.push(`${path.relative(root, file)} -> ${expression.text}`);
        }
      }
      if (ts.isStringLiteralLike(node) && ["codex", "claude", "on-request", "untrusted", "never", "read-only", "workspace-write", "danger-full-access"].includes(node.text)) {
        violations.push(`${path.relative(root, file)} contains a native provider identity or policy spelling`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});

// Codex app-server vocabulary that once leaked into shared contracts. Adapters translate it at the boundary.
const nativeValues = new Set([
  "userMessage", "agentMessage", "inProgress", "notLoaded", "localImage", "localAudio",
  "inputText", "inputImage", "inputAudio", "appServer", "commentary", "final_answer", "acceptForSession",
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "imageGeneration", "imageView", "contextCompaction",
  // OpenAI image detail, and Claude SDK permission modes, tools and presets.
  "original", "bypassPermissions", "acceptEdits", "dontAsk", "AskUserQuestion", "claude_code",
]);
const nativeFields = new Set([
  "modelProvider", "reasoningEffort", "supportedReasoningEfforts", "defaultReasoningEffort", "cachedInputTokens",
  "modelContextWindow", "baseInstructions", "developerInstructions", "text_elements", "byteRange", "deferLoading",
  "normalModelSlug", "limitName", "planType", "imageUrl", "audioUrl", "revisedPrompt", "effectiveEnabled", "savedPath",
  // Anthropic usage and Claude SDK option names.
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "permissionMode", "allowDangerouslySkipPermissions", "cwds", "forceReload",
]);
/** Codex app-server JSON-RPC methods, such as thread/start or item/tool/requestUserInput. */
const nativeMethod = /^(?:thread|turn|item|account|model|skills|config|review|fs|command|mcpServer)\/[A-Za-z]/;
/** New provider directories automatically join the guard, along with SDK vendor names. */
const providerNames = ["anthropic", "openai", ...(await readdir(path.join(root, "server/providers"), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)];
const providerName = new RegExp(providerNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

function vocabularyViolations(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    const literal = ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? (node as ts.LiteralLikeNode).text : undefined;
    const identifier = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : undefined;
    if (literal !== undefined && (nativeValues.has(literal) || nativeFields.has(literal) || nativeMethod.test(literal))) violations.push(`"${literal}"`);
    if (identifier !== undefined && nativeFields.has(identifier)) violations.push(identifier);
    // OpenAI's phase name also leaks through naming; application code says "interim".
    if (identifier !== undefined && /commentary/i.test(identifier)) violations.push(`names a native phase: ${identifier}`);
    if ((literal ?? identifier) !== undefined && providerName.test(literal ?? identifier!)) violations.push(`names a provider: ${literal ?? identifier}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

test("vocabulary guard checks quoted keys, provider identifiers, template fragments and native method families", () => {
  const source = ts.createSourceFile("probe.ts", 'const ClaudeOptions = { activeCommentary: null, "forceReload": true, "permissionMode": "bypassPermissions", method: "thread/newNativeMethod", prompt: `OpenAI ${value} request`, usage: { cache_creation_input_tokens: 0 } };', ts.ScriptTarget.Latest, true);
  expect(vocabularyViolations(source)).toEqual(expect.arrayContaining([
    "names a provider: ClaudeOptions", "names a native phase: activeCommentary", '"forceReload"', '"permissionMode"', '"bypassPermissions"', '"thread/newNativeMethod"', "names a provider: OpenAI ", "cache_creation_input_tokens",
  ]));
  const application = ts.createSourceFile("application.ts", 'type Input = { includeHidden?: boolean; isSecret?: boolean }; const event = "turn.image.generated";', ts.ScriptTarget.Latest, true);
  expect(vocabularyViolations(application)).toEqual([]);
});

test("shared contracts, core, surfaces and UI use application vocabulary rather than provider wire names", async () => {
  // Provider identities and implementations meet only at the composition root.
  const runtime = (await sourceFiles(path.join(root, "server/runtime"))).filter(file => path.basename(file) !== "provider_services.ts");
  const files = [
    ...await sourceFiles(path.join(root, "shared/protocol")), ...await sourceFiles(path.join(root, "server/core")),
    ...await sourceFiles(path.join(root, "server/adapters")), ...await sourceFiles(path.join(root, "server/ports")),
    ...await sourceFiles(path.join(root, "server/storage")), ...await sourceFiles(path.join(root, "server/config")),
    ...await sourceFiles(path.join(root, "server/signals")), ...await sourceFiles(path.join(root, "ui/src")), ...runtime,
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    violations.push(...vocabularyViolations(source).map(violation => `${path.relative(root, file)}: ${violation}`));
  }
  expect(violations).toEqual([]);
});
