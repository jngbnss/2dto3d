export type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/**
 * Tiny element builder. `class`/`style` map to attributes, `onX` functions
 * become listeners, keys that exist as element properties (e.g. `disabled`,
 * `checked`, `value`) are assigned, and the rest become attributes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class" || key === "style" || key.startsWith("data-") || key.startsWith("aria-")) {
      el.setAttribute(key, String(value));
    } else if (key in el) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

/** Appends a cache-busting `t` parameter so re-rendered images are refetched. */
export function bust(url: string, stamp: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}t=${stamp}`;
}

/** ok / warn / bad class for a 0..1 score using the given thresholds. */
export function grade(fraction: number, ok = 0.9, warn = 0.75): "ok" | "warn" | "bad" {
  return fraction >= ok ? "ok" : fraction >= warn ? "warn" : "bad";
}
