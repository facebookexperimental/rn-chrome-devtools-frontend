// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import type * as Platform from '../../core/platform/platform.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as CodeMirror from '../../third_party/codemirror.next/codemirror.next.js';

const cssParser = CodeMirror.css.cssLanguage.parser;

function nodeText(node: CodeMirror.SyntaxNode, text: string): string {
  return text.substring(node.from, node.to);
}

export class SyntaxTree {
  readonly propertyValue: string;
  readonly rule: string;
  readonly tree: CodeMirror.SyntaxNode;
  readonly trailingNodes: CodeMirror.SyntaxNode[];
  readonly propertyName: string|undefined;
  constructor(
      propertyValue: string, rule: string, tree: CodeMirror.SyntaxNode, propertyName?: string,
      trailingNodes: CodeMirror.SyntaxNode[] = []) {
    this.propertyName = propertyName;
    this.propertyValue = propertyValue;
    this.rule = rule;
    this.tree = tree;
    this.trailingNodes = trailingNodes;
  }

  text(node?: CodeMirror.SyntaxNode): string {
    return nodeText(node ?? this.tree, this.rule);
  }

  subtree(node: CodeMirror.SyntaxNode): SyntaxTree {
    return new SyntaxTree(this.propertyValue, this.rule, node);
  }
}

export interface SyntaxNodeRef {
  node: CodeMirror.SyntaxNode;
}

export abstract class TreeWalker {
  readonly ast: SyntaxTree;
  constructor(ast: SyntaxTree) {
    this.ast = ast;
  }
  static walkExcludingSuccessors<T extends TreeWalker, ArgTs extends unknown[]>(
      this: {new(ast: SyntaxTree, ...args: ArgTs): T}, propertyValue: SyntaxTree, ...args: ArgTs): T {
    const instance = new this(propertyValue, ...args);
    instance.iterateExcludingSuccessors(propertyValue.tree);
    return instance;
  }
  static walk<T extends TreeWalker, ArgTs extends unknown[]>(
      this: {new(ast: SyntaxTree, ...args: ArgTs): T}, propertyValue: SyntaxTree, ...args: ArgTs): T {
    const instance = new this(propertyValue, ...args);
    instance.iterate(propertyValue.tree);
    return instance;
  }

  protected iterate(tree: CodeMirror.SyntaxNode): void {
    tree.cursor().iterate(this.enter.bind(this), this.leave.bind(this));
  }

  protected iterateExcludingSuccessors(tree: CodeMirror.SyntaxNode): void {
    // Customize the first step to avoid visiting siblings of `tree`
    if (this.enter(tree)) {
      tree.firstChild?.cursor().iterate(this.enter.bind(this), this.leave.bind(this));
    }
    this.leave(tree);
  }

  protected enter(_node: SyntaxNodeRef): boolean {
    return true;
  }

  protected leave(_node: SyntaxNodeRef): void {
  }
}

export class RenderingContext {
  constructor(
      readonly ast: SyntaxTree, readonly matchedResult: BottomUpTreeMatching, readonly cssControls?: CSSControlMap) {
  }
  addControl(cssType: string, control: HTMLElement): void {
    if (this.cssControls) {
      const controls = this.cssControls.get(cssType);
      if (!controls) {
        this.cssControls.set(cssType, [control]);
      } else {
        controls.push(control);
      }
    }
  }
}

export interface Match {
  readonly text: string;
  readonly type: string;
  render(context: RenderingContext): Node[];
  computedText?(): string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor = (abstract new (...args: any[]) => any)|(new (...args: any[]) => any);
export type MatchFactory<MatchT extends Constructor> = (...args: ConstructorParameters<MatchT>) => InstanceType<MatchT>;

export interface Matcher {
  matches(node: CodeMirror.SyntaxNode, matching: BottomUpTreeMatching): Match|null;
}

export abstract class MatcherBase<MatchT extends Constructor> implements Matcher {
  constructor(readonly createMatch: MatchFactory<MatchT>) {
  }

  abstract matches(node: CodeMirror.SyntaxNode, matching: BottomUpTreeMatching): Match|null;
}

type MatchKey = Platform.Brand.Brand<string, 'MatchKey'>;
export class BottomUpTreeMatching extends TreeWalker {
  #matchers: Matcher[] = [];
  #matchedNodes = new Map<MatchKey, Match>();
  readonly computedText: ComputedText;

  #key(node: CodeMirror.SyntaxNode): MatchKey {
    return `${node.from}:${node.to}` as MatchKey;
  }

  constructor(ast: SyntaxTree, matchers: Matcher[]) {
    super(ast);
    this.computedText = new ComputedText(ast.propertyValue);
    this.#matchers.push(...matchers);
    this.#matchers.push(new TextMatcher());
  }

  protected override leave({node}: SyntaxNodeRef): void {
    for (const matcher of this.#matchers) {
      const match = matcher.matches(node, this);
      if (match) {
        this.computedText.push(match, node.from - this.ast.tree.from);
        this.#matchedNodes.set(this.#key(node), match);
        break;
      }
    }
  }

  matchText(node: CodeMirror.SyntaxNode): void {
    const matchers = this.#matchers.splice(0);
    this.#matchers.push(new TextMatcher());
    this.iterateExcludingSuccessors(node);
    this.#matchers.push(...matchers);
  }

  getMatch(node: CodeMirror.SyntaxNode): Match|undefined {
    return this.#matchedNodes.get(this.#key(node));
  }

  getComputedText(node: CodeMirror.SyntaxNode): string {
    return this.computedText.get(node.from - this.ast.tree.from, node.to - this.ast.tree.from);
  }
}

type MatchWithComputedText = Match&{computedText: NonNullable<Match['computedText']>};
class ComputedTextChunk {
  #cachedComputedText: string|null = null;
  constructor(readonly match: MatchWithComputedText, readonly offset: number) {
  }

  get end(): number {
    return this.offset + this.length;
  }

  get length(): number {
    return this.match.text.length;
  }

  get computedText(): string {
    if (this.#cachedComputedText === null) {
      this.#cachedComputedText = this.match.computedText();
    }
    return this.#cachedComputedText;
  }
}

// This class constructs the "computed" text from the input property text, i.e., it will strip comments and substitute
// var() functions if possible. It's intended for use during the bottom-up tree matching process. The original text is
// not modified. Instead, computed text slices are produced on the fly. During bottom-up matching, the sequence of
// top-level comments and var() matches will be recorded. This produces an ordered sequence of text pieces that need to
// be substituted into the original text. When a computed text slice is requested, it is generated by piecing together
// original and computed slices as required.
export class ComputedText {
  readonly #chunks: ComputedTextChunk[] = [];
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  get chunkCount(): number {
    return this.#chunks.length;
  }

  // Add another substitutable match. The match will either be appended to the list of existing matches or it will
  // be substituted for the last match(es) if it encompasses them.
  push(match: Match, offset: number): void {
    function hasComputedText(match: Match): match is MatchWithComputedText {
      return Boolean(match.computedText);
    }
    if (!hasComputedText(match) || offset < 0 || offset >= this.text.length) {
      return;
    }
    const chunk = new ComputedTextChunk(match, offset);
    if (chunk.end > this.text.length) {
      return;
    }
    if (this.#chunks.length === 0) {
      this.#chunks.push(chunk);
      return;
    }
    const lastChunk = this.#chunks[this.#chunks.length - 1];
    if (chunk.offset <= lastChunk.offset && lastChunk.end <= chunk.end) {
      // The new chunk is more general than the last chunk, so drop that and retry.
      this.#chunks.pop();
      this.push(match, offset);
    } else if (chunk.offset >= lastChunk.end) {
      // The new chunk is to be inserted after the last chunk.
      this.#chunks.push(chunk);
    }
  }

  // Get a slice of the computed text corresponding to the property text in the range [begin, end). The slice may not
  // start within a substitution chunk, e.g., it's invalid to request the computed text for the property value text
  // slice "1px var(--".
  get(begin: number, end: number): string {
    const pieces = [];

    for (let currentChunk = this.#chunks.find(c => c.offset >= begin); begin < end && currentChunk;
         currentChunk = this.#chunks.find(c => c.offset >= begin)) {
      pieces.push(this.text.substring(begin, Math.min(currentChunk.offset, end)));
      if (end >= currentChunk.end) {
        pieces.push(currentChunk.computedText);
      }

      begin = currentChunk.end;
    }
    if (begin < end) {
      pieces.push(this.text.substring(begin, end));
    }
    return pieces.join('');
  }
}

// This function determines whether concatenating two pieces of text requires any spacing inbetween. For example, there
// shouldn't be any space between 'var' and '(', but there should be a space between '1px' and 'solid'. The node
// sequences that make up the pieces of text may contain non-text nodes/trees. Any such element inbetween the texts is
// ignored for the spacing requirement.
export function requiresSpace(a: Node[], b: Node[]): boolean {
  const tail = a.findLast(node => node.textContent)?.textContent;
  const trailingChar = tail ? tail[tail.length - 1] : '';
  const head = b.find(node => node.textContent)?.textContent;
  const leadingChar = head ? head[0] : '';

  const noSpaceAfter = ['', '(', ' ', '{', '}', ';'];
  const noSpaceBefore = ['', '(', ')', ',', ':', ' ', '*', '{', ';'];
  return !noSpaceAfter.includes(trailingChar) && !noSpaceBefore.includes(leadingChar);
}

function mergeWithSpacing(nodes: Node[], merge: Node[]): Node[] {
  const result = [...nodes];
  if (requiresSpace(nodes, merge)) {
    result.push(document.createTextNode(' '));
  }
  result.push(...merge);
  return result;
}

export const CSSControlMap = Map<string, [HTMLElement]>;
export type CSSControlMap = Map<string, [HTMLElement]>;

export class Renderer extends TreeWalker {
  readonly #matchedResult: BottomUpTreeMatching;
  #output: Node[] = [];
  readonly #context: RenderingContext;

  constructor(ast: SyntaxTree, matchedResult: BottomUpTreeMatching, cssControls: CSSControlMap) {
    super(ast);
    this.#matchedResult = matchedResult;
    this.#context = new RenderingContext(this.ast, this.#matchedResult, cssControls);
  }

  static render(nodeOrNodes: CodeMirror.SyntaxNode|CodeMirror.SyntaxNode[], context: RenderingContext):
      {nodes: Node[], cssControls: CSSControlMap} {
    if (!Array.isArray(nodeOrNodes)) {
      return this.render([nodeOrNodes], context);
    }
    const cssControls = new CSSControlMap();
    const renderers = nodeOrNodes.map(
        node => this.walkExcludingSuccessors(context.ast.subtree(node), context.matchedResult, cssControls));
    const nodes = renderers.map(node => node.#output).reduce(mergeWithSpacing);
    return {nodes, cssControls};
  }

  static renderInto(
      nodeOrNodes: CodeMirror.SyntaxNode|CodeMirror.SyntaxNode[], context: RenderingContext,
      parent: Node): {nodes: Node[], cssControls: CSSControlMap} {
    const {nodes, cssControls} = this.render(nodeOrNodes, context);
    if (parent.lastChild && requiresSpace([parent.lastChild], nodes)) {
      parent.appendChild(document.createTextNode(' '));
    }
    nodes.map(n => parent.appendChild(n));
    return {nodes, cssControls};
  }

  renderedMatchForTest(_nodes: Node[], _match: Match): void {
  }

  protected override enter({node}: SyntaxNodeRef): boolean {
    const match = this.#matchedResult.getMatch(node);
    if (match) {
      const output = match.render(this.#context);
      this.renderedMatchForTest(output, match);
      this.#output = mergeWithSpacing(this.#output, output);
      return false;
    }

    return true;
  }
}

function siblings(node: CodeMirror.SyntaxNode|null): CodeMirror.SyntaxNode[] {
  const result = [];
  while (node) {
    result.push(node);
    node = node.nextSibling;
  }
  return result;
}

export function children(node: CodeMirror.SyntaxNode): CodeMirror.SyntaxNode[] {
  return siblings(node.firstChild);
}

export abstract class ColorMatch implements Match {
  readonly text: string;
  get type(): string {
    return 'color';
  }
  constructor(text: string) {
    this.text = text;
  }
  abstract render(context: RenderingContext): Node[];
}

export class ColorMatcher extends MatcherBase<typeof ColorMatch> {
  matches(node: CodeMirror.SyntaxNode, matching: BottomUpTreeMatching): Match|null {
    if (matching.ast.propertyName && !SDK.CSSMetadata.cssMetadata().isColorAwareProperty(matching.ast.propertyName)) {
      return null;
    }
    const text = matching.ast.text(node);
    if (node.name === 'ColorLiteral') {
      return this.createMatch(text);
    }
    if (node.name === 'ValueName' && Common.Color.Nicknames.has(text)) {
      return this.createMatch(text);
    }
    if (node.name === 'CallExpression') {
      const callee = node.getChild('Callee');
      if (callee && matching.ast.text(callee).match(/^(rgba?|hsla?|hwba?|lab|lch|oklab|oklch|color)$/)) {
        return this.createMatch(text);
      }
    }
    return null;
  }
}

class LegacyRegexMatch implements Match {
  readonly processor: (text: string) => Node | null;
  readonly #matchedText: string;
  readonly #suffix: string;
  get text(): string {
    return this.#matchedText + this.#suffix;
  }
  get type(): string {
    return `${this.processor}`;
  }
  constructor(matchedText: string, suffix: string, processor: (text: string) => Node | null) {
    this.#matchedText = matchedText;
    this.#suffix = suffix;
    this.processor = processor;
  }
  render(): Node[] {
    const rendered = this.processor(this.#matchedText);
    return rendered ? [rendered, document.createTextNode(this.#suffix)] : [];
  }
}

export class LegacyRegexMatcher implements Matcher {
  readonly regexp: RegExp;
  readonly processor: (text: string) => Node | null;
  constructor(regexp: RegExp, processor: (text: string) => Node | null) {
    this.regexp = new RegExp(regexp);
    this.processor = processor;
  }
  matches(node: CodeMirror.SyntaxNode, matching: BottomUpTreeMatching): Match|null {
    const text = matching.ast.text(node);
    this.regexp.lastIndex = 0;
    const match = this.regexp.exec(text);
    if (!match || match.index !== 0) {
      return null;
    }
    // Some of the legacy regex matching relies on matching prefixes of the text, e.g., for var()s. That particular
    // matcher can't be extended for a full-text match, because that runs into problems matching the correct closing
    // parenthesis (with fallbacks, specifically). At the same time we can't rely on prefix matching here because it
    // has false positives for some subexpressions, such as 'var() + var()'. We compromise by accepting prefix matches
    // where the remaining suffix is exclusively closing parentheses and whitespace, specifically to handle the existing
    // prefix matchers like that for var().
    const suffix = text.substring(match[0].length);
    if (!suffix.match(/^[\s)]*$/)) {
      return null;
    }
    return new LegacyRegexMatch(match[0], suffix, this.processor);
  }
}

export class TextMatch implements Match {
  readonly type = 'text';
  computedText?: () => string;
  constructor(readonly text: string, readonly isComment: boolean) {
    if (isComment) {
      this.computedText = (): string => '';
    }
  }
  render(): Node[] {
    return [document.createTextNode(this.text)];
  }
}

class TextMatcher implements Matcher {
  matches(node: CodeMirror.SyntaxNode, matching: BottomUpTreeMatching): Match|null {
    if (!node.firstChild || node.name === 'NumberLiteral' /* may have a Unit child */) {
      // Leaf node, just emit text
      const text = matching.ast.text(node);
      if (text.length) {
        return new TextMatch(text, node.name === 'Comment');
      }
    }
    return null;
  }
}

function declaration(rule: string): CodeMirror.SyntaxNode|null {
  return cssParser.parse(rule).topNode.getChild('RuleSet')?.getChild('Block')?.getChild('Declaration') ?? null;
}

export function tokenizePropertyValue(propertyValue: string, propertyName?: string): SyntaxTree|null {
  const fakePropertyName = '--property';
  const rule = `*{${fakePropertyName}: ${propertyValue};}`;
  const decl = declaration(rule);
  if (!decl || decl.type.isError) {
    return null;
  }

  const childNodes = children(decl);
  if (childNodes.length < 3) {
    return null;
  }
  const [varName, colon, tree] = childNodes;
  if (!varName || varName.type.isError || !colon || colon.type.isError || !tree || tree.type.isError) {
    return null;
  }

  // It's possible that there are nodes following the declaration when there are comments or syntax errors. We want to
  // render any comments, so pick up any trailing nodes following the declaration excluding the final semicolon and
  // brace.
  const trailingNodes = siblings(decl).slice(1);
  const [semicolon, brace] = trailingNodes.splice(trailingNodes.length - 2, 2);
  if (semicolon?.name !== ';' && brace?.name !== '}') {
    return null;
  }

  const name = (propertyName && tokenizePropertyName(propertyName)) ?? undefined;
  const ast = new SyntaxTree(propertyValue, rule, tree, name, trailingNodes);
  if (ast.text(varName) !== fakePropertyName || colon.name !== ':') {
    return null;
  }
  return ast;
}

export function tokenizePropertyName(name: string): string|null {
  const rule = `*{${name}: inherit;}`;
  const decl = declaration(rule);
  if (!decl || decl.type.isError) {
    return null;
  }

  const propertyName = decl.getChild('PropertyName');
  if (!propertyName) {
    return null;
  }

  return nodeText(propertyName, rule);
}

// This function renders a property value as HTML, customizing the presentation with a set of given AST matchers. This
// comprises the following steps:
// 1. Build an AST of the property.
// 2. Apply tree matchers during bottom up traversal.
// 3. Render the value from left to right into HTML, deferring rendering of matched subtrees to the matchers
//
// More general, longer matches take precedence over shorter, more specific matches. Whitespaces are normalized, for
// unmatched text and around rendered matching results.
export function renderPropertyValue(value: string, matchers: Matcher[], propertyName?: string): Node[] {
  const ast = tokenizePropertyValue(value, propertyName);
  if (!ast) {
    return [document.createTextNode(value)];
  }
  const matchedResult = BottomUpTreeMatching.walk(ast, matchers);
  ast.trailingNodes.forEach(n => matchedResult.matchText(n));
  const context = new RenderingContext(ast, matchedResult);
  return Renderer.render([...siblings(ast.tree), ...ast.trailingNodes], context).nodes;
}