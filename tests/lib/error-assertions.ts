import assert from "node:assert/strict";
import { relative, resolve, sep } from "node:path";
import {
  API,
  SignatureKind,
  SymbolFlags,
  isErrorType,
} from "typescript/unstable/sync";
import {
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isPropertyAccessExpression,
  isStringLiteral,
} from "typescript/unstable/ast/is";

export const CONSTRUCTOR_MATCHER_EXEMPTIONS: readonly never[] = Object.freeze(
  [],
);

export function exactError(
  ErrorType: { new (...args: any[]): Error; name: string },
  expectedMessage: string,
): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}`);
    assert.equal(error.message, expectedMessage);
    return true;
  };
}

export function matchingError(
  ErrorType: { new (...args: any[]): Error; name: string },
  expectedPattern: RegExp,
): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}`);
    assert.match(error.message, expectedPattern);
    return true;
  };
}

export type ConstructorMatcherFinding = {
  path: string;
  line: number;
  test: string;
  matcher: string;
};
export type ConstructorMatcherExemption = {
  path: string;
  test: string;
  matcher: string;
  rationale: string;
};

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function lineOf(
  source: import("typescript/unstable/ast").SourceFile,
  node: import("typescript/unstable/ast").Node,
): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function formatDiagnostic(
  diagnostic: import("typescript/unstable/sync").Diagnostic,
  root: string,
  fallbackPath: string,
  project: import("typescript/unstable/sync").Project,
): string {
  const path = diagnostic.fileName ?? fallbackPath;
  const source = diagnostic.fileName
    ? project.program.getSourceFile(diagnostic.fileName)
    : undefined;
  const line = source
    ? source.getLineAndCharacterOfPosition(diagnostic.pos).line + 1
    : 1;
  return `${relativePath(root, path)}:${line}: ${diagnostic.text}`;
}

function assertDiagnosticFree(
  project: import("typescript/unstable/sync").Project,
  root: string,
  configPath: string,
): void {
  const diagnostics = [
    ...project.program.getConfigFileParsingDiagnostics(),
    ...project.program.getGlobalDiagnostics(),
    ...project.program.getSyntacticDiagnostics(),
    ...project.program.getBindDiagnostics(),
    ...project.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      diagnostics
        .map((diagnostic) =>
          formatDiagnostic(diagnostic, root, configPath, project),
        )
        .join("\n"),
    );
  }
}

function nodeAssertBindings(
  source: import("typescript/unstable/ast").SourceFile,
): {
  defaults: Set<string>;
  namespaces: Set<string>;
  named: Map<string, "throws" | "rejects">;
} {
  const defaults = new Set<string>();
  const namespaces = new Set<string>();
  const named = new Map<string, "throws" | "rejects">();
  for (const statement of source.statements) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      (statement.moduleSpecifier.text !== "node:assert" &&
        statement.moduleSpecifier.text !== "node:assert/strict")
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) defaults.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && isNamespaceImport(bindings))
      namespaces.add(bindings.name.text);
    if (bindings && isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        if (imported === "throws" || imported === "rejects") {
          named.set(specifier.name.text, imported);
        }
      }
    }
  }
  return { defaults, namespaces, named };
}

function boundNodeAssertKind(
  call: import("typescript/unstable/ast").CallExpression,
  bindings: {
    defaults: Set<string>;
    namespaces: Set<string>;
    named: Map<string, "throws" | "rejects">;
  },
): "throws" | "rejects" | undefined {
  const expression = call.expression;
  if (isIdentifier(expression)) return bindings.named.get(expression.text);
  if (!isPropertyAccessExpression(expression)) return undefined;
  const kind = expression.name.text;
  if (kind !== "throws" && kind !== "rejects") return undefined;
  if (isIdentifier(expression.expression)) {
    const base = expression.expression.text;
    return bindings.defaults.has(base) || bindings.namespaces.has(base)
      ? kind
      : undefined;
  }
  if (
    isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "strict" &&
    isIdentifier(expression.expression.expression)
  ) {
    const base = expression.expression.expression.text;
    return bindings.defaults.has(base) || bindings.namespaces.has(base)
      ? kind
      : undefined;
  }
  return undefined;
}

function resolvedNodeAssertKind(
  project: import("typescript/unstable/sync").Project,
  call: import("typescript/unstable/ast").CallExpression,
): "throws" | "rejects" | undefined {
  const declaration = project.checker.getResolvedSignature(call)?.declaration;
  if (
    !declaration ||
    !declaration.path
      .replaceAll("\\\\", "/")
      .endsWith("/@types/node/assert.d.ts")
  ) {
    return undefined;
  }
  const node = declaration.resolve(project);
  const declarationName =
    node && "name" in node
      ? (node.name as import("typescript/unstable/ast").Node | undefined)
      : undefined;
  const name =
    declarationName && isIdentifier(declarationName)
      ? declarationName.text
      : undefined;
  return name === "throws" || name === "rejects" ? name : undefined;
}

function enclosingTestName(
  node: import("typescript/unstable/ast").Node,
): string {
  for (let current = node.parent; current; current = current.parent) {
    if (
      isCallExpression(current) &&
      isIdentifier(current.expression) &&
      current.expression.text === "test" &&
      isStringLiteral(current.arguments[0])
    ) {
      return current.arguments[0].text;
    }
  }
  return "<module-scope>";
}

export function auditConstructorMatchers({
  root,
  tsconfigPath,
  exemptions,
}: {
  root: string;
  tsconfigPath: string;
  exemptions: readonly ConstructorMatcherExemption[];
}): ConstructorMatcherFinding[] {
  const api = new API({ cwd: root });

  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    const configPath = resolve(tsconfigPath);
    snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot
      .getProjects()
      .find((candidate) => resolve(candidate.configFileName) === configPath);
    if (!project) {
      throw new Error(`constructor matcher audit could not open ${configPath}`);
    }
    assertDiagnosticFree(project, root, configPath);

    const findings: ConstructorMatcherFinding[] = [];
    for (const sourceName of project.program.getSourceFileNames()) {
      const source = project.program.getSourceFile(sourceName);
      if (!source || project.program.isSourceFileFromExternalLibrary(source))
        continue;
      const path = relativePath(root, source.fileName);
      if (!path.startsWith("tests/")) continue;
      const bindings = nodeAssertBindings(source);

      const visit = (node: import("typescript/unstable/ast").Node) => {
        if (isCallExpression(node)) {
          const resolvedKind = resolvedNodeAssertKind(project, node);
          const boundKind = boundNodeAssertKind(node, bindings);
          if (resolvedKind && resolvedKind !== boundKind) {
            throw new Error(
              `unresolved node:assert call shape: ${path}:${lineOf(source, node)}`,
            );
          }
          if (boundKind && boundKind === resolvedKind && node.arguments[1]) {
            const matcher = node.arguments[1];
            const matcherType = project.checker.getTypeAtLocation(matcher);
            if (!matcherType || isErrorType(matcherType)) {
              throw new Error(
                `constructor matcher audit could not inspect ${path}:${lineOf(source, matcher)}`,
              );
            }
            const errorSymbol = project.checker.resolveName(
              "Error",
              SymbolFlags.Type,
              matcher,
              false,
            );
            if (!errorSymbol) {
              throw new Error(
                `constructor matcher audit could not resolve Error in ${path}`,
              );
            }
            const errorType =
              project.checker.getDeclaredTypeOfSymbol(errorSymbol);
            if (!errorType || isErrorType(errorType)) {
              throw new Error(
                `constructor matcher audit could not inspect Error in ${path}`,
              );
            }
            const constructs = project.checker.getSignaturesOfType(
              matcherType,
              SignatureKind.Construct,
            );
            if (
              constructs.some((signature) => {
                const returned =
                  project.checker.getReturnTypeOfSignature(signature);
                if (!returned || isErrorType(returned)) {
                  throw new Error(
                    `constructor matcher audit could not inspect ${path}:${lineOf(source, matcher)}`,
                  );
                }
                return project.checker.isTypeAssignableTo(returned, errorType);
              })
            ) {
              findings.push({
                path,
                line: lineOf(source, node),
                test: enclosingTestName(node),
                matcher: matcher.getText(source),
              });
            }
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
    }

    findings.sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.matcher.localeCompare(right.matcher),
    );
    const keys = new Set<string>();
    for (const exemption of exemptions) {
      if (!exemption.rationale.trim()) {
        throw new Error("constructor matcher exemption requires a rationale");
      }
      const key = `${exemption.path}\u0000${exemption.test}\u0000${exemption.matcher}`;
      if (keys.has(key))
        throw new Error(`duplicate constructor matcher exemption: ${key}`);
      keys.add(key);
    }
    const exempted = new Set<string>();
    const retained = findings.filter((finding) => {
      const key = `${finding.path}\u0000${finding.test}\u0000${finding.matcher}`;
      if (!keys.has(key)) return true;
      exempted.add(key);
      return false;
    });
    for (const key of keys) {
      if (!exempted.has(key)) {
        throw new Error(`unused constructor matcher exemption: ${key}`);
      }
    }
    return retained;
  } finally {
    try {
      snapshot?.dispose();
    } finally {
      api.close();
    }
  }
}
