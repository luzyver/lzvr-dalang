// CodeMirror for the code editor: one editor state per open file, styled from the panel's own tokens so it follows the
// theme and accent palette, and the language of each file loaded on demand (vendor/code has a chunk per language).
import {
  addCursorAbove, addCursorBelow, autocompletion, bracketMatching, closeBrackets, closeBracketsKeymap, Compartment,
  completionKeymap, crosshairCursor, defaultKeymap, drawSelection, dropCursor, EditorState, EditorView, ensureSyntaxTree,
  foldGutter, foldKeymap, highlightActiveLine, highlightActiveLineGutter, highlightSelectionMatches, highlightSpecialChars,
  HighlightStyle, history, historyKeymap, indentOnInput, indentUnit, indentWithTab, keymap, LanguageDescription, languages,
  lineNumbers, openSearchPanel, rectangularSelection, searchKeymap, syntaxHighlighting, tags as t,
} from '../vendor/code/editor.js';

export { EditorState, EditorView, openSearchPanel };

/** Word wrap, shared by every open file (Alt+Z switches it). */
export const wrapping = new Compartment();
const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
export const wrapOn = { value: pref('dalang-code-wrap', innerWidth <= 760) }; // phones start with it on

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--code-fs, 13px)', color: 'var(--text)', backgroundColor: 'var(--bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0 40vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--accent-soft-2)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface-3) 55%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-faint)', border: 'none', paddingRight: '4px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '44px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-faint)', cursor: 'pointer' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: '1px solid var(--line)', color: 'var(--text-dim)', borderRadius: '4px', padding: '0 4px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent-line)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--warn-soft) 80%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid color-mix(in srgb, var(--warn) 40%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft-2)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font)', fontSize: '12.5px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { minHeight: '26px', fontSize: '12.5px', margin: '2px 3px', borderRadius: 'var(--r-sm)' },
  '.cm-panel.cm-search input[type=checkbox]': { minHeight: 0, verticalAlign: 'middle' },
  '.cm-panel.cm-search input.cm-textfield': { width: 'auto', padding: '2px 8px' },
  '.cm-panel.cm-search button': { border: '1px solid var(--line-strong)', background: 'var(--surface)', padding: '0 8px', backgroundImage: 'none', color: 'var(--text)' },
  '.cm-panel.cm-search button[name=close]': { border: 0, background: 'none', fontSize: '18px', color: 'var(--text-dim)' },
  '.cm-panel.cm-search label': { fontSize: '12.5px', color: 'var(--text-dim)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12.5px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft-2)', color: 'var(--text)' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-text)', fontWeight: 600 },
});

// The same colours the panel's highlighted code blocks use (--syn-*).
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--syn-k)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.inserted], color: 'var(--syn-s)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: 'var(--syn-f)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.escape, t.constant(t.variableName)], color: 'var(--syn-n)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta, t.processingInstruction], color: 'var(--syn-c)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.attributeName, t.self, t.annotation], color: 'var(--syn-t)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--text)' },
  { tag: t.deleted, color: 'var(--err)' },
  { tag: t.invalid, color: 'var(--err)', textDecoration: 'underline wavy' },
  { tag: t.heading, fontWeight: 700, color: 'var(--syn-t)' },
  { tag: t.strong, fontWeight: 700 },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent-text)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--accent-text)' },
]);

/** The language of a file by its name (or a few names CodeMirror's list does not know), or null for plain text. */
export function languageOf(path) {
  const name = path.split('/').pop();
  if (/^\.env(\..+)?$/.test(name)) return LanguageDescription.matchLanguageName(languages, 'Properties files');
  if (/^\.(bashrc|profile|zshrc)$/.test(name)) return LanguageDescription.matchLanguageName(languages, 'Shell');
  return LanguageDescription.matchFilename(languages, name);
}

/** Two spaces unless the file is indented with tabs (or clearly with four spaces). */
function detectIndent(text) {
  let tabs = 0;
  let two = 0;
  let four = 0;
  for (const line of text.split('\n', 2000)) {
    if (line[0] === '\t') tabs++;
    else if (/^ {4}\S/.test(line)) four++;
    else if (/^ {2}\S/.test(line)) two++;
  }
  if (tabs > two + four) return '\t';
  return four > two * 2 ? '    ' : '  ';
}

/**
 * A fresh editor state for a file. `onSave` runs on Ctrl/Cmd+S; `keys` are bindings that win over CodeMirror's. CRLF files keep their line breaks (the document
 * joins lines with them), and the language is filled in once its chunk has loaded.
 */
export function createState(text, path, { readOnly = false, onSave, onChange, keys = [] } = {}) {
  const lang = new Compartment();
  const crlf = /\r\n/.test(text);
  const indent = detectIndent(text);
  const state = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
      dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
      autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
      syntaxHighlighting(highlight, { fallback: true }), theme, lang.of([]),
      indentUnit.of(indent), EditorState.tabSize.of(indent === '\t' ? 4 : indent.length),
      crlf ? EditorState.lineSeparator.of('\r\n') : [],
      wrapping.of(wrapOn.value ? EditorView.lineWrapping : []),
      EditorState.readOnly.of(readOnly), // still focusable: the cursor, selection and find work
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } },
        // VS Code's keys where CodeMirror's differ (`keys`, e.g. Ctrl+G: go to line rather than find next), and
        // Ctrl+Alt+↑/↓ to add a cursor.
        ...keys,
        { key: 'Mod-Alt-ArrowUp', preventDefault: true, run: addCursorAbove },
        { key: 'Mod-Alt-ArrowDown', preventDefault: true, run: addCursorBelow },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((u) => { if (u.docChanged || u.selectionSet) onChange?.(u); }),
    ],
  });
  return { state, lang, crlf, indent };
}

/** Load the file's language and switch it on in `view` (if the file is still showing there). */
export async function loadLanguage(view, doc, path) {
  const desc = languageOf(path);
  if (!desc) return null;
  try {
    const support = await desc.load();
    const effects = doc.lang.reconfigure(support);
    if (view && view.dalangDoc === doc) { view.dispatch({ effects }); doc.state = view.state; } else doc.state = doc.state.update({ effects }).state;
  } catch { /* stays plain text */ }
  return desc.name;
}

// ---------- symbols, for "Go to symbol" (Ctrl+Shift+O) ----------

/** Syntax nodes that declare something worth jumping to, across the Lezer grammars (JS/TS, Python, Rust, Go, Java, ...). */
const DECL = /^(FunctionDeclaration|FunctionDefinition|ClassDeclaration|ClassDefinition|MethodDeclaration|MethodDefinition|InterfaceDeclaration|TypeAliasDeclaration|EnumDeclaration|FunctionItem|StructItem|EnumItem|TraitItem|ImplItem|ModItem|TypeItem|MacroDefinition|FunctionDecl|MethodDecl|TypeSpec|ConstructorDeclaration|RuleSet)$/;
const NAME = /^(VariableDefinition|PropertyDefinition|TypeDefinition|VariableName|BoundIdentifier|TypeIdentifier|Identifier|DefName|FieldIdentifier|PropertyName|TypeName|Definition)$/;
const KIND = (node) => (/Class|Struct|Impl|Trait/.test(node) ? 'class' : /Interface|Type|Enum/.test(node) ? 'type'
  : /Method|Constructor/.test(node) ? 'method' : /Mod/.test(node) ? 'module' : /RuleSet/.test(node) ? 'rule' : 'function');
/** For grammars without a tree (the legacy modes) or without those nodes: declarations by their usual words. */
const DECL_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:static\s+)?(function\*?|class|def|fn|func|interface|type|struct|enum|trait|impl|module|sub|proc)\s+([A-Za-z_$][\w$]*)/;

/** The declarations in a file: { name, kind, line, pos } in document order. */
export function symbolsOf(state) {
  const out = [];
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 300);
  if (tree) {
    tree.iterate({
      enter(n) {
        if (/^ATXHeading[1-6]$|^SetextHeading[12]$/.test(n.name)) { // Markdown headings
          const text = doc.sliceString(n.from, n.to).replace(/^#+\s*|\s*#*$/g, '').split('\n')[0];
          out.push({ name: text, kind: `h${n.name.slice(-1)}`, pos: n.from });
          return false;
        }
        if (n.name === 'VariableDeclaration' && /^(Script|ExportDeclaration)$/.test(n.node.parent?.name)) {
          const def = n.node.getChild('VariableDefinition');
          if (def) out.push({ name: doc.sliceString(def.from, def.to), kind: 'variable', pos: def.from });
          return false;
        }
        if (!DECL.test(n.name)) return undefined;
        if (n.name === 'RuleSet') {
          out.push({ name: doc.sliceString(n.from, Math.min(n.to, doc.lineAt(n.from).to)).replace(/\s*\{.*$/, ''), kind: 'rule', pos: n.from });
          return false;
        }
        for (let c = n.node.firstChild; c; c = c.nextSibling) {
          if (NAME.test(c.name)) { out.push({ name: doc.sliceString(c.from, c.to), kind: KIND(n.name), pos: c.from }); break; }
        }
        return undefined;
      },
    });
  }
  if (!out.length) {
    for (let i = 1; i <= doc.lines && out.length < 2000; i++) {
      const line = doc.line(i);
      const m = DECL_LINE.exec(line.text);
      if (m) out.push({ name: m[2], kind: /class|struct|impl|trait/.test(m[1]) ? 'class' : /interface|type|enum/.test(m[1]) ? 'type' : 'function', pos: line.from + m.index + m[0].length - m[2].length });
    }
  }
  return out.map((sym) => ({ ...sym, line: doc.lineAt(sym.pos).number }));
}
