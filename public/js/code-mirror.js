// CodeMirror for the code editor: one editor state per open file, styled from the panel's own tokens so it follows the
// theme and accent palette, and the language of each file loaded on demand (vendor/code has a chunk per language).
import {
  autocompletion, bracketMatching, closeBrackets, closeBracketsKeymap, Compartment, completionKeymap, crosshairCursor,
  defaultKeymap, drawSelection, dropCursor, EditorState, EditorView, foldGutter, foldKeymap, highlightActiveLine,
  highlightActiveLineGutter, highlightSelectionMatches, highlightSpecialChars, HighlightStyle, history, historyKeymap,
  indentOnInput, indentUnit, indentWithTab, keymap, LanguageDescription, languages, lineNumbers, rectangularSelection,
  searchKeymap, syntaxHighlighting, tags as t,
} from '../vendor/code/editor.js';

export { EditorState, EditorView };

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', color: 'var(--text)', backgroundColor: 'var(--bg)' },
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
 * A fresh editor state for a file. `onSave` runs on Ctrl/Cmd+S. CRLF files keep their line breaks (the document
 * joins lines with them), and the language is filled in once its chunk has loaded.
 */
export function createState(text, path, { readOnly = false, onSave, onChange } = {}) {
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
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } },
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
