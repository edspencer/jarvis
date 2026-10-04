// The HUD's shared CSS: every region's shadow root adopts it. Everything is in --jv-* tokens (tokens.ts).
import { css } from 'lit';

export const base = css`
  :host {
    font: 13px/1.4 var(--jv-font);
    color: var(--jv-text);
    box-sizing: border-box;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  [hidden] {
    display: none !important;
  }
  button {
    font: inherit;
    color: inherit;
  }
  :focus-visible {
    outline: 2px solid var(--jv-accent);
    outline-offset: 2px;
  }
  .surface {
    background: var(--jv-surface);
    backdrop-filter: blur(12px) saturate(1.2);
    -webkit-backdrop-filter: blur(12px) saturate(1.2);
    border: 1px solid var(--jv-border);
    box-shadow: var(--jv-shadow);
  }
  @supports not (backdrop-filter: blur(1px)) {
    .surface {
      background: rgba(18, 21, 27, 0.94);
    }
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .mono {
    font-family: var(--jv-mono);
    font-size: 12px;
    word-break: break-all;
  }
  .muted {
    color: var(--jv-text-muted);
  }
  .faint {
    color: var(--jv-text-faint);
  }
  .ic {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    flex: none;
  }
  .ic svg {
    width: 100%;
    height: 100%;
  }
  .glyph {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    font: 800 9.5px var(--jv-font);
    color: #111;
    flex: none;
  }
  .glyph.hollow {
    background: transparent !important;
    box-shadow: inset 0 0 0 2px currentColor;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex: none;
    background: var(--jv-off);
  }
  .tone-ok {
    --tone: var(--jv-ok);
  }
  .tone-warn {
    --tone: var(--jv-warn);
  }
  .tone-bad {
    --tone: var(--jv-bad);
  }
  .tone-info {
    --tone: var(--jv-info);
  }
  .tone-off {
    --tone: var(--jv-off);
  }
  .dot[class*='tone-'] {
    background: var(--tone);
  }
  .dot.tone-ok {
    box-shadow: 0 0 6px var(--jv-ok);
  }
  .t[class*='tone-'] {
    color: var(--tone);
  }
  kbd {
    font: 600 10px var(--jv-mono);
    opacity: 0.75;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 0 12px;
    border-radius: var(--jv-radius-ctl);
    font: 600 12.5px var(--jv-font);
    background: var(--jv-surface-sunken);
    color: var(--jv-text);
    border: 1px solid var(--jv-border);
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    background: var(--jv-surface-raised);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn.primary {
    background: var(--jv-accent);
    color: #0e1116;
    border-color: transparent;
  }
  .btn.danger {
    color: #ffb0a9;
    border-color: rgba(239, 90, 79, 0.5);
  }
  .btn kbd {
    opacity: 0.6;
  }
  .iconbtn {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: none;
    border: 0;
    color: var(--jv-text-faint);
    cursor: pointer;
    padding: 0;
  }
  .iconbtn:hover:not(:disabled) {
    color: var(--jv-text);
    background: var(--jv-surface-sunken);
  }
  .iconbtn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .iconbtn svg {
    width: 15px;
    height: 15px;
  }
`;

/** the standard blocks (blocks.ts) */
export const blockStyles = css`
  .blocks {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .kv {
    display: grid;
    grid-template-columns: minmax(84px, 112px) 1fr;
    gap: 5px 10px;
  }
  .kv .k {
    color: var(--jv-text-muted);
    font-size: 12px;
    padding-top: 1px;
  }
  .kv .v {
    min-width: 0;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .kv .v.open {
    display: block;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    background: color-mix(in srgb, var(--tone, var(--jv-off)) 18%, transparent);
    color: color-mix(in srgb, var(--tone, var(--jv-off)) 55%, white);
    white-space: nowrap;
  }
  .note {
    color: var(--jv-text-muted);
    font-size: 12.5px;
    white-space: pre-line;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .note.open {
    display: block;
  }
  .more {
    color: var(--jv-accent);
    font-size: 12px;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .lbl {
    font-size: 11px;
    color: var(--jv-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 2px 0 -3px;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .lnk {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 24px;
    padding: 0 8px 0 4px;
    border-radius: 6px;
    background: var(--jv-surface-sunken);
    border: 1px solid var(--jv-border);
    font-size: 12px;
    color: var(--jv-text);
    cursor: pointer;
    text-decoration: none;
    max-width: 100%;
  }
  .lnk span.tx {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lnk:hover {
    background: var(--jv-surface-raised);
  }
  .lnk .ic {
    width: 14px;
    height: 14px;
    color: var(--jv-text-muted);
  }
  .lnk .go {
    color: var(--jv-text-faint);
  }
  .list {
    display: flex;
    flex-direction: column;
  }
  .li {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    gap: 8px;
    align-items: center;
    padding: 5px 6px;
    border-radius: 6px;
    background: none;
    border: 0;
    text-align: left;
    width: 100%;
    cursor: default;
  }
  .li.act {
    cursor: pointer;
  }
  .li.act:hover {
    background: var(--jv-surface-sunken);
  }
  .li.sel {
    background: var(--jv-surface-raised);
    box-shadow: inset 2px 0 0 var(--jv-accent);
  }
  .li .m {
    overflow: hidden;
    min-width: 0;
  }
  .li .p {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .li .s {
    color: var(--jv-text-muted);
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .li .v {
    font-size: 12px;
    color: var(--jv-text-muted);
    text-align: right;
  }
  .li .lead {
    display: grid;
    place-items: center;
  }
  .lbar {
    height: 4px;
    border-radius: 2px;
    background: var(--jv-surface-sunken);
    overflow: hidden;
    margin-top: 3px;
  }
  .lbar > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #ffd166, #ff6b3d);
  }
  .grp {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 6px 3px;
    font-size: 11px;
    color: var(--jv-text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: none;
    border: 0;
    width: 100%;
    cursor: pointer;
    text-align: left;
  }
  .grp .n {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .grp .car {
    width: 10px;
    transition: transform var(--jv-motion) ease-out;
  }
  .grp.closed .car {
    transform: rotate(-90deg);
  }
  .grp .car svg {
    width: 10px;
    height: 10px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .fchip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px 0 4px;
    border-radius: 999px;
    font-size: 11.5px;
    background: var(--jv-surface-sunken);
    border: 1px solid var(--jv-border);
    cursor: pointer;
  }
  .fchip.off {
    opacity: 0.42;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ctl {
    display: grid;
    grid-template-columns: minmax(70px, auto) 1fr auto;
    align-items: center;
    gap: 8px;
  }
  .ctl .k {
    color: var(--jv-text-muted);
    font-size: 12px;
  }
  .ctl .val {
    font-size: 12px;
    color: var(--jv-text-muted);
    white-space: nowrap;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--jv-accent);
    margin: 0;
    height: 18px;
  }
  select,
  input[type='search'],
  textarea {
    font: inherit;
    color: var(--jv-text);
    background: var(--jv-surface-sunken);
    border: 1px solid var(--jv-border);
    border-radius: var(--jv-radius-ctl);
    min-height: 28px;
    padding: 0 8px;
    width: 100%;
  }
  select option {
    background: #1d222b;
  }
  textarea {
    padding: 6px 8px;
    font: 12px var(--jv-mono);
    resize: vertical;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search .ic {
    position: absolute;
    left: 9px;
    color: var(--jv-text-faint);
  }
  .search input {
    padding-left: 30px;
    height: 30px;
  }
  .search kbd {
    position: absolute;
    right: 8px;
    border: 1px solid var(--jv-border);
    border-radius: 4px;
    padding: 0 4px;
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    font-size: 12.5px;
  }
  .switch .tr {
    width: 30px;
    height: 18px;
    border-radius: 9px;
    background: var(--jv-surface-raised);
    border: 1px solid var(--jv-border);
    position: relative;
    flex: none;
    transition: background var(--jv-motion) ease-out;
  }
  .switch .tr::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--jv-text-muted);
    transition: left var(--jv-motion) ease-out;
  }
  .switch[aria-checked='true'] .tr {
    background: var(--jv-ok);
  }
  .switch[aria-checked='true'] .tr::after {
    left: 14px;
    background: #fff;
  }
  .switch:disabled {
    opacity: 0.5;
  }
  .seg {
    display: inline-flex;
    background: var(--jv-surface-sunken);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }
  .seg button {
    padding: 2px 10px;
    border-radius: 4px;
    color: var(--jv-text-muted);
    font-size: 12px;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .seg button[aria-pressed='true'] {
    background: var(--jv-surface-raised);
    color: var(--jv-text);
  }
  .meter {
    display: flex;
    align-items: flex-end;
    gap: 12px;
  }
  .meter .val {
    font-size: 26px;
    font-weight: 650;
    line-height: 1;
  }
  .meter .val small {
    font-size: 13px;
    color: var(--jv-text-muted);
    font-weight: 500;
    margin-left: 2px;
  }
  .meter svg {
    flex: 1;
    height: 34px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .callout {
    padding: 7px 9px;
    border-radius: 6px;
    font-size: 12px;
    background: color-mix(in srgb, var(--tone) 10%, transparent);
    color: color-mix(in srgb, var(--tone) 60%, white);
    border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent);
  }
  .callout button {
    color: var(--jv-accent);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    font-size: 12px;
  }
  .state {
    color: var(--jv-text-muted);
    font-size: 12.5px;
    padding: 6px 0;
  }
  .state.error {
    color: #ffaaa3;
  }
  .btns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  a {
    color: var(--jv-accent);
  }
`;
