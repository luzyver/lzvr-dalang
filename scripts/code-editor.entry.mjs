// What the code editor (public/js/editor/*) imports from CodeMirror and xterm.js. scripts/vendor.mjs bundles it into
// public/vendor/code/editor.js; each language of @codemirror/language-data becomes its own chunk, loaded when a file
// of that language is opened.
export { Compartment, EditorSelection, EditorState } from '@codemirror/state';
export {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
export {
  addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, cursorMatchingBracket, defaultKeymap, deleteLine, history,
  historyKeymap, indentLess, indentMore, indentSelection, indentWithTab, insertBlankLine, moveLineDown, moveLineUp,
  selectLine, selectParentSyntax, toggleBlockComment, toggleComment, undoSelection,
} from '@codemirror/commands';
export {
  closeSearchPanel, findNext, findPrevious, highlightSelectionMatches, openSearchPanel, searchKeymap,
  selectNextOccurrence, selectSelectionMatches,
} from '@codemirror/search';
export { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion } from '@codemirror/autocomplete';
export {
  bracketMatching, ensureSyntaxTree, foldAll, foldCode, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit,
  LanguageDescription, syntaxHighlighting, unfoldAll, unfoldCode,
} from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { languages } from '@codemirror/language-data';
export { Terminal } from '@xterm/xterm';
export { FitAddon } from '@xterm/addon-fit';
