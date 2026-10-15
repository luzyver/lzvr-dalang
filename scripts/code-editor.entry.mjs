// What the code editor (public/js/editor/*) imports from CodeMirror and xterm.js. scripts/vendor.mjs bundles it into
// public/vendor/code/editor.js; each language of @codemirror/language-data becomes its own chunk, loaded when a file
// of that language is opened.
export { Compartment, EditorSelection, EditorState } from '@codemirror/state';
export {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search';
export { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
export {
  bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting,
} from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { languages } from '@codemirror/language-data';
export { Terminal } from '@xterm/xterm';
export { FitAddon } from '@xterm/addon-fit';
