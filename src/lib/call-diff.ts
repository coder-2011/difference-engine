import { getCallDiffSource } from "@/lib/github";
import type { CallDiffDocument, CallDiffEntry, CallDiffNode, CallDiffStatus } from "@/types/call-diff";

type TypeScript = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSourceFile = import("typescript").SourceFile;

type CallStep = {
  children: CallStep[];
  file: string;
  key: string;
  label: string;
  line: number;
  type: "branch" | "call";
};

type FunctionInfo = {
  className?: string;
  exported: boolean;
  file: string;
  id: string;
  line: number;
  localOwner?: string;
  scope: string;
  steps: CallStep[];
  symbol: string;
};

type FunctionIndex = {
  byFile: Map<string, Map<string, FunctionInfo>>;
  byId: Map<string, FunctionInfo>;
  byOwner: Map<string, Map<string, FunctionInfo>>;
  bySymbol: Map<string, FunctionInfo[]>;
};

type CallTreeNode = Omit<CallDiffNode, "status">;

const CALL_DIFF_ENTRY_LIMIT = 12;
const CALL_DIFF_MAX_DEPTH = 4;

/** Selects the TypeScript parser mode from the filename GitHub supplied. */
function scriptKindForPath(ts: TypeScript, path: string): import("typescript").ScriptKind {
  if (/\.(?:tsx|jsx)$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/i.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Returns a stable function identity that survives line movement within one changed file. */
function functionId(scope: string, symbol: string): string {
  return `${scope}\0${symbol}`;
}

/** Formats functions and constructor calls consistently in the call-flow tree. */
function functionLabel(symbol: string): string {
  return `${symbol}()`;
}

/** Extracts the source line used by both entry headers and deep-link targets. */
function lineForNode(sourceFile: TsSourceFile, node: TsNode): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Detects an export modifier without treating default or ambient declarations specially. */
function isExported(ts: TypeScript, node: TsNode): boolean {
  return Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

/** Converts an AST call target to the shallow symbol name used for local resolution. */
function callSymbol(ts: TypeScript, sourceFile: TsSourceFile, expression: import("typescript").Expression, className?: string): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    if (className && expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return `${className}.${expression.name.text}`;
    }
    return expression.getText(sourceFile).replace(/\s+/g, "");
  }
  return expression.getText(sourceFile).replace(/\s+/g, "");
}

/** Reads a component tag while excluding intrinsic HTML elements from the call graph. */
function jsxSymbol(sourceFile: TsSourceFile, tagName: import("typescript").JsxTagNameExpression): string | undefined {
  const symbol = tagName.getText(sourceFile).replace(/\s+/g, "");
  return /^[A-Z]/.test(symbol) || symbol.includes(".") ? symbol : undefined;
}

/** Collects calls in source order while keeping conditional arms as distinct tree branches. */
function collectSteps(ts: TypeScript, sourceFile: TsSourceFile, body: TsNode, className?: string): CallStep[] {
  const steps: CallStep[] = [];

  /** Adds one conditional arm without descending into a nested function declaration. */
  function addBranch(label: string, node: TsNode, anchor = node): void {
    steps.push({
      children: collectSteps(ts, sourceFile, node, className),
      file: sourceFile.fileName,
      key: `branch:${label}`,
      label,
      line: lineForNode(sourceFile, anchor),
      type: "branch",
    });
  }

  /** Adds the then and else arms of a conditional with labels that remain stable across revisions. */
  function addIfStatement(node: import("typescript").IfStatement, prefix = "if"): void {
    const condition = node.expression.getText(sourceFile).replace(/\s+/g, " ").trim();
    steps.push(...collectSteps(ts, sourceFile, node.expression, className));
    addBranch(`${prefix} (${condition})`, node.thenStatement, node);
    if (!node.elseStatement) return;
    if (ts.isIfStatement(node.elseStatement)) {
      addIfStatement(node.elseStatement, "else if");
      return;
    }
    addBranch("else", node.elseStatement);
  }

  /** Visits source nodes until a call, branch, or nested function establishes an ownership boundary. */
  function visit(node: TsNode): void {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;

    if (ts.isIfStatement(node)) {
      addIfStatement(node);
      return;
    }

    if (ts.isCallExpression(node)) {
      const symbol = callSymbol(ts, sourceFile, node.expression, className);
      steps.push({
        children: [],
        file: sourceFile.fileName,
        key: symbol,
        label: functionLabel(symbol),
        line: lineForNode(sourceFile, node),
        type: "call",
      });
      node.arguments.forEach(visit);
      return;
    }

    if (ts.isNewExpression(node)) {
      const symbol = `new ${callSymbol(ts, sourceFile, node.expression, className)}`;
      steps.push({
        children: [],
        file: sourceFile.fileName,
        key: symbol,
        label: functionLabel(symbol),
        line: lineForNode(sourceFile, node),
        type: "call",
      });
      node.arguments?.forEach(visit);
      return;
    }

    if (ts.isJsxSelfClosingElement(node)) {
      const symbol = jsxSymbol(sourceFile, node.tagName);
      if (symbol) steps.push({ children: [], file: sourceFile.fileName, key: symbol, label: `<${symbol} />`, line: lineForNode(sourceFile, node), type: "call" });
      ts.forEachChild(node.attributes, visit);
      return;
    }

    if (ts.isJsxElement(node)) {
      const symbol = jsxSymbol(sourceFile, node.openingElement.tagName);
      if (symbol) steps.push({ children: [], file: sourceFile.fileName, key: symbol, label: `<${symbol}>`, line: lineForNode(sourceFile, node), type: "call" });
      ts.forEachChild(node.openingElement.attributes, visit);
      node.children.forEach(visit);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(body);
  return steps;
}

/** Adds a parsed function to the changed-file index with its declaration source location. */
function addFunction(functions: FunctionInfo[], ts: TypeScript, sourceFile: TsSourceFile, scope: string, symbol: string, definition: TsNode, body: TsNode, exported: boolean, className?: string, localOwner?: string): FunctionInfo {
  const info = {
    className,
    exported,
    file: sourceFile.fileName,
    id: functionId(localOwner ?? scope, symbol),
    line: lineForNode(sourceFile, definition),
    localOwner,
    scope,
    steps: collectSteps(ts, sourceFile, body, className),
    symbol,
  };
  functions.push(info);
  return info;
}

/** Indexes named nested helpers so calls resolve to their lexical implementation. */
function addLocalFunctions(functions: FunctionInfo[], ts: TypeScript, sourceFile: TsSourceFile, body: TsNode, parent: FunctionInfo): void {
  /** Records a nested declaration and descends into it without attributing its body to the parent. */
  function visit(node: TsNode): void {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const local = addFunction(functions, ts, sourceFile, parent.scope, node.name.text, node, node.body, false, parent.className, parent.id);
      addLocalFunctions(functions, ts, sourceFile, node.body, local);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      const local = addFunction(functions, ts, sourceFile, parent.scope, node.name.text, node, node.initializer.body, false, parent.className, parent.id);
      addLocalFunctions(functions, ts, sourceFile, node.initializer.body, local);
      return;
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(body, visit);
}

/** Parses top-level functions, callable variables, and class members from one source snapshot. */
function parseFunctions(ts: TypeScript, path: string, text: string, scope: string): FunctionInfo[] {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindForPath(ts, path));
  const functions: FunctionInfo[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      const info = addFunction(functions, ts, sourceFile, scope, statement.name.text, statement, statement.body, isExported(ts, statement));
      addLocalFunctions(functions, ts, sourceFile, statement.body, info);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = isExported(ts, statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
        const info = addFunction(functions, ts, sourceFile, scope, declaration.name.text, declaration, declaration.initializer.body, exported);
        addLocalFunctions(functions, ts, sourceFile, declaration.initializer.body, info);
      }
      continue;
    }

    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const className = statement.name.text;
    const exported = isExported(ts, statement);
    for (const member of statement.members) {
      if (ts.isConstructorDeclaration(member) && member.body) {
        const info = addFunction(functions, ts, sourceFile, scope, `new ${className}`, member, member.body, exported, className);
        addLocalFunctions(functions, ts, sourceFile, member.body, info);
        continue;
      }
      if (ts.isMethodDeclaration(member) && member.body && member.name) {
        const info = addFunction(functions, ts, sourceFile, scope, `${className}.${member.name.getText(sourceFile)}`, member, member.body, exported, className);
        addLocalFunctions(functions, ts, sourceFile, member.body, info);
        continue;
      }
      if (!ts.isPropertyDeclaration(member) || !member.name || !member.initializer) continue;
      if (!ts.isArrowFunction(member.initializer) && !ts.isFunctionExpression(member.initializer)) continue;
      const info = addFunction(functions, ts, sourceFile, scope, `${className}.${member.name.getText(sourceFile)}`, member, member.initializer.body, exported, className);
      addLocalFunctions(functions, ts, sourceFile, member.initializer.body, info);
    }
  }

  return functions;
}

/** Builds direct local and unambiguous cross-file lookups for one snapshot. */
function createFunctionIndex(functions: FunctionInfo[]): FunctionIndex {
  const byFile = new Map<string, Map<string, FunctionInfo>>();
  const byId = new Map<string, FunctionInfo>();
  const byOwner = new Map<string, Map<string, FunctionInfo>>();
  const bySymbol = new Map<string, FunctionInfo[]>();

  for (const info of functions) {
    byId.set(info.id, info);
    if (info.localOwner) {
      let local = byOwner.get(info.localOwner);
      if (!local) {
        local = new Map();
        byOwner.set(info.localOwner, local);
      }
      local.set(info.symbol, info);
      continue;
    }
    let inFile = byFile.get(info.scope);
    if (!inFile) {
      inFile = new Map();
      byFile.set(info.scope, inFile);
    }
    inFile.set(info.symbol, info);
    const matching = bySymbol.get(info.symbol);
    if (matching) matching.push(info);
    else bySymbol.set(info.symbol, [info]);
  }

  return { byFile, byId, byOwner, bySymbol };
}

/** Resolves a call to its file-local definition first, then to an unambiguous changed-file definition. */
function resolveCall(step: CallStep, owner: FunctionInfo, index: FunctionIndex): FunctionInfo | undefined {
  const nested = index.byOwner.get(owner.id)?.get(step.key);
  if (nested) return nested;

  // A nested helper can call its immediately enclosing helper by name.
  const parent = owner.localOwner ? index.byId.get(owner.localOwner) : undefined;
  if (parent?.symbol === step.key) return parent;

  const sibling = owner.localOwner ? index.byOwner.get(owner.localOwner)?.get(step.key) : undefined;
  if (sibling) return sibling;

  const local = index.byFile.get(owner.scope)?.get(step.key);
  if (local) return local;

  const matching = index.bySymbol.get(step.key);
  return matching?.length === 1 ? matching[0] : undefined;
}

/** Expands changed-file calls to a bounded tree and marks recursion without re-entering it. */
function buildCallTree(info: FunctionInfo, index: FunctionIndex): CallTreeNode {
  /** Expands steps owned by one function while preserving branch hierarchy and call order. */
  function expandSteps(steps: CallStep[], owner: FunctionInfo, depth: number, visiting: Set<string>): CallTreeNode[] {
    return steps.map((step) => {
      if (step.type === "branch") {
        return {
          children: expandSteps(step.children, owner, depth, visiting),
          file: step.file,
          kind: "branch",
          key: step.key,
          label: step.label,
          line: step.line,
        };
      }

      const callee = resolveCall(step, owner, index);
      if (!callee) {
        return { children: [], file: step.file, kind: "call", key: step.key, label: step.label, line: step.line };
      }
      if (visiting.has(callee.id)) {
        return { children: [], file: step.file, kind: "call", key: step.key, label: `${callee.symbol}() ↻`, line: step.line };
      }
      if (depth >= CALL_DIFF_MAX_DEPTH) {
        return { children: [], file: step.file, kind: "call", key: step.key, label: step.label, line: step.line };
      }

      visiting.add(callee.id);
      const children = expandSteps(callee.steps, callee, depth + 1, visiting);
      visiting.delete(callee.id);
      return { children, file: step.file, kind: "call", key: step.key, label: functionLabel(callee.symbol), line: step.line };
    });
  }

  return {
    children: expandSteps(info.steps, info, 1, new Set([info.id])),
    file: info.file,
    kind: "call",
    key: info.id,
    label: functionLabel(info.symbol),
    line: info.line,
  };
}

/** Marks a complete added or removed subtree without changing its source location. */
function markTree(node: CallTreeNode, status: Exclude<CallDiffStatus, "same">): CallDiffNode {
  return { ...node, children: node.children.map((child) => markTree(child, status)), status };
}

/** Checks whether an LCS diff can retain the fully aligned child sequence without a matrix. */
function haveAlignedKeys(before: CallTreeNode[], after: CallTreeNode[]): boolean {
  if (before.length !== after.length) return false;

  for (let index = 0; index < before.length; index += 1) {
    if (before[index]!.key !== after[index]!.key) return false;
  }

  return true;
}

/** Compares expanded trees before diffing so unchanged source locations do not create review entries. */
function sameCallTree(before: CallTreeNode | undefined, after: CallTreeNode | undefined): boolean {
  if (!before || !after) return before === after;
  if (before.kind !== after.kind || before.key !== after.key || before.children.length !== after.children.length) return false;

  for (let index = 0; index < before.children.length; index += 1) {
    if (!sameCallTree(before.children[index], after.children[index])) return false;
  }

  return true;
}

/** Diffs ordered child calls through LCS so additions and removals retain source order. */
function diffChildren(before: CallTreeNode[], after: CallTreeNode[]): CallDiffNode[] {
  if (haveAlignedKeys(before, after)) return before.map((node, index) => diffTree(node, after[index]!));

  const rows = before.length;
  const columns = after.length;
  const matches = Array.from({ length: rows + 1 }, () => Array<number>(columns + 1).fill(0));

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      matches[row]![column] = before[row]!.key === after[column]!.key
        ? matches[row + 1]![column + 1]! + 1
        : Math.max(matches[row + 1]![column]!, matches[row]![column + 1]!);
    }
  }

  const result: CallDiffNode[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row]!.key === after[column]!.key) {
      result.push(diffTree(before[row]!, after[column]!));
      row += 1;
      column += 1;
    } else if (matches[row + 1]![column]! >= matches[row]![column + 1]!) {
      result.push(markTree(before[row]!, "removed"));
      row += 1;
    } else {
      result.push(markTree(after[column]!, "added"));
      column += 1;
    }
  }
  while (row < rows) result.push(markTree(before[row++]!, "removed"));
  while (column < columns) result.push(markTree(after[column++]!, "added"));
  return result;
}

/** Diffs two call nodes and retains the destination location when a call survives the change. */
function diffTree(before: CallTreeNode | undefined, after: CallTreeNode | undefined): CallDiffNode {
  if (!before && after) return markTree(after, "added");
  if (before && !after) return markTree(before, "removed");
  if (!before || !after) throw new Error("Call-diff tree node is missing");
  return { ...after, children: diffChildren(before.children, after.children), status: "same" };
}

/** Detects whether a structural call-tree diff contains any added or removed node. */
function treeHasChanges(node: CallDiffNode): boolean {
  return node.status !== "same" || node.children.some(treeHasChanges);
}

/** Reads both snapshots, infers affected exported entrypoints, and returns their compact call-tree diffs. */
export async function getCallDiffDocument(source: string[], token?: string): Promise<CallDiffDocument> {
  const [snapshot, ts] = await Promise.all([getCallDiffSource(source, token), import("typescript")]);
  const before = createFunctionIndex(snapshot.files.flatMap((file) => file.before ? parseFunctions(ts, file.before.path, file.before.text, file.key) : []));
  const after = createFunctionIndex(snapshot.files.flatMap((file) => file.after ? parseFunctions(ts, file.after.path, file.after.text, file.key) : []));
  const entries: Array<CallDiffEntry & { exported: boolean }> = [];
  const functionIds = new Set([...before.byId.keys(), ...after.byId.keys()]);

  for (const id of functionIds) {
    const beforeInfo = before.byId.get(id);
    const afterInfo = after.byId.get(id);
    if (beforeInfo?.localOwner || afterInfo?.localOwner) continue;
    const beforeTree = beforeInfo && buildCallTree(beforeInfo, before);
    const afterTree = afterInfo && buildCallTree(afterInfo, after);
    if (sameCallTree(beforeTree, afterTree)) continue;
    const tree = diffTree(beforeTree, afterTree);
    if (!treeHasChanges(tree)) continue;
    entries.push({ exported: Boolean(beforeInfo?.exported || afterInfo?.exported), key: id, tree });
  }

  const exportedEntries = entries.filter((entry) => entry.exported);
  const visibleEntries = (exportedEntries.length ? exportedEntries : entries)
    .sort((left, right) => left.tree.label.localeCompare(right.tree.label))
    .slice(0, CALL_DIFF_ENTRY_LIMIT)
    .map(({ exported: _exported, ...entry }) => entry);
  return {
    entries: visibleEntries,
    filesAnalyzed: snapshot.files.length,
    fromRef: snapshot.fromRef,
    ignoredFiles: snapshot.ignoredFiles,
    toRef: snapshot.toRef,
    truncated: snapshot.truncated || entries.length > visibleEntries.length,
  };
}
