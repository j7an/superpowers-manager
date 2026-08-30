// @ts-check
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

/** @type {readonly never[]} */
export const CONSTRUCTOR_MATCHER_EXEMPTIONS = Object.freeze([]);

/**
 * @param {{ new (...args: any[]): Error; name: string }} ErrorType
 * @param {string} expectedMessage
 * @returns {(error: unknown) => true}
 */
export function exactError(ErrorType, expectedMessage) {
  return (error) => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}`);
    assert.equal(error.message, expectedMessage);
    return true;
  };
}

/**
 * @param {{ new (...args: any[]): Error; name: string }} ErrorType
 * @param {RegExp} expectedPattern
 * @returns {(error: unknown) => true}
 */
export function matchingError(ErrorType, expectedPattern) {
  return (error) => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}`);
    assert.match(error.message, expectedPattern);
    return true;
  };
}

/**
 * @typedef {{ path: string; line: number; test: string; matcher: string }} ConstructorMatcherFinding
 * @typedef {{ path: string; test: string; matcher: string; rationale: string }} ConstructorMatcherExemption
 */

/**
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

/**
 * @param {import("typescript/unstable/ast").SourceFile} source
 * @param {import("typescript/unstable/ast").Node} node
 * @returns {number}
 */
function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/**
 * @param {import("typescript/unstable/sync").Diagnostic} diagnostic
 * @param {string} root
 * @param {string} fallbackPath
 * @param {import("typescript/unstable/sync").Project} project
 * @returns {string}
 */
function formatDiagnostic(diagnostic, root, fallbackPath, project) {
  const path = diagnostic.fileName ?? fallbackPath;
  const source = diagnostic.fileName
    ? project.program.getSourceFile(diagnostic.fileName)
    : undefined;
  const line = source
    ? source.getLineAndCharacterOfPosition(diagnostic.pos).line + 1
    : 1;
  return `${relativePath(root, path)}:${line}: ${diagnostic.text}`;
}

/**
 * @param {import("typescript/unstable/sync").Project} project
 * @param {string} root
 * @param {string} configPath
 * @returns {void}
 */
function assertDiagnosticFree(project, root, configPath) {
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
        .map((diagnostic) => formatDiagnostic(diagnostic, root, configPath, project))
        .join("\n"),
    );
  }
}

/**
 * @param {import("typescript/unstable/ast").SourceFile} source
 * @returns {{ defaults: Set<string>; namespaces: Set<string>; named: Map<string, "throws" | "rejects"> }}
 */
function nodeAssertBindings(source) {
  const defaults = new Set();
  const namespaces = new Set();
  const named = new Map();
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
    if (bindings && isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
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

/**
 * @param {import("typescript/unstable/ast").CallExpression} call
 * @param {{ defaults: Set<string>; namespaces: Set<string>; named: Map<string, "throws" | "rejects"> }} bindings
 * @returns {"throws" | "rejects" | undefined}
 */
function boundNodeAssertKind(call, bindings) {
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

/**
 * @param {import("typescript/unstable/sync").Project} project
 * @param {import("typescript/unstable/ast").CallExpression} call
 * @returns {"throws" | "rejects" | undefined}
 */
function resolvedNodeAssertKind(project, call) {
  const declaration = project.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !declaration.path.replaceAll("\\\\", "/").endsWith("/@types/node/assert.d.ts")) {
    return undefined;
  }
  const node = declaration.resolve(project);
  const declarationName = node && "name" in node
    ? /** @type {import("typescript/unstable/ast").Node | undefined} */ (node.name)
    : undefined;
  const name = declarationName && isIdentifier(declarationName)
    ? declarationName.text
    : undefined;
  return name === "throws" || name === "rejects" ? name : undefined;
}

/**
 * @param {import("typescript/unstable/ast").Node} node
 * @returns {string}
 */
function enclosingTestName(node) {
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

/**
 * @param {{ root: string; tsconfigPath: string; exemptions: readonly ConstructorMatcherExemption[] }} options
 * @returns {ConstructorMatcherFinding[]}
 */
export function auditConstructorMatchers({ root, tsconfigPath, exemptions }) {
  const api = new API({ cwd: root });
  /** @type {ReturnType<API["updateSnapshot"]> | undefined} */
  let snapshot;
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

    /** @type {ConstructorMatcherFinding[]} */
    const findings = [];
    for (const sourceName of project.program.getSourceFileNames()) {
      const source = project.program.getSourceFile(sourceName);
      if (!source || project.program.isSourceFileFromExternalLibrary(source)) continue;
      const path = relativePath(root, source.fileName);
      if (!path.startsWith("tests/")) continue;
      const bindings = nodeAssertBindings(source);
      /** @param {import("typescript/unstable/ast").Node} node */
      const visit = (node) => {
        if (isCallExpression(node)) {
          const resolvedKind = resolvedNodeAssertKind(project, node);
          const boundKind = boundNodeAssertKind(node, bindings);
          if (resolvedKind && !boundKind) {
            throw new Error(
              `unresolved node:assert call shape: ${path}:${lineOf(source, node)}`,
            );
          }
          if (boundKind && node.arguments[1]) {
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
              throw new Error(`constructor matcher audit could not resolve Error in ${path}`);
            }
            const errorType = project.checker.getDeclaredTypeOfSymbol(errorSymbol);
            if (!errorType || isErrorType(errorType)) {
              throw new Error(`constructor matcher audit could not inspect Error in ${path}`);
            }
            const constructs = project.checker.getSignaturesOfType(
              matcherType,
              SignatureKind.Construct,
            );
            if (
              constructs.some((signature) => {
                const returned = project.checker.getReturnTypeOfSignature(signature);
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
    const keys = new Set();
    for (const exemption of exemptions) {
      if (!exemption.rationale.trim()) {
        throw new Error("constructor matcher exemption requires a rationale");
      }
      const key = `${exemption.path}\u0000${exemption.test}\u0000${exemption.matcher}`;
      if (keys.has(key)) throw new Error(`duplicate constructor matcher exemption: ${key}`);
      keys.add(key);
    }
    const exempted = new Set();
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
    snapshot?.dispose();
    api.close();
  }
}
