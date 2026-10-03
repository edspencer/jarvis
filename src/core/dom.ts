import type { DomLookup, Escape } from './types';

export const $: DomLookup = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** HTML-escape a value for innerHTML */
export const esc: Escape = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** the query string of the page */
export const query = (): URLSearchParams => new URLSearchParams(location.search);
