// Third-party code for txtpad, bundled into ../lib.js so the app works offline.
export * as A from '@automerge/automerge/slim';
export { joinRoom } from 'trystero';
export { basicSetup } from 'codemirror';
export { EditorState, Compartment, Annotation, Transaction } from '@codemirror/state';
export { EditorView } from '@codemirror/view';
export { markdown } from '@codemirror/lang-markdown';
export { vim } from '@replit/codemirror-vim';
export { default as MarkdownIt } from 'markdown-it';
export { full as emoji } from 'markdown-it-emoji';
export { default as hljs } from 'highlight.js/lib/common';
export { default as DOMPurify } from 'dompurify';
export { words } from './words.js';
export { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { MatchDecorator, Decoration, ViewPlugin } from '@codemirror/view';
