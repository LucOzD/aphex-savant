// Tiny DOM helpers to keep the UI code readable without a framework.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Format the displayed value. */
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

/** A labelled range slider that shows its live value. */
export function slider(opts: SliderOpts): HTMLElement {
  const fmt = opts.format ?? ((v) => String(v));
  const valEl = el("span", { class: "val" }, [fmt(opts.value)]);
  const input = el("input", {
    type: "range",
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
  }) as HTMLInputElement;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    valEl.textContent = fmt(v);
    opts.onInput(v);
  });
  return el("label", { class: "field" }, [
    el("span", {}, [opts.label]),
    input,
    valEl,
  ]);
}
