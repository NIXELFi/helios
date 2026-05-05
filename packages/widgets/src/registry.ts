import type { Widget } from "./types";

class Registry {
  #widgets = new Map<string, Widget<unknown>>();

  register<C>(w: Widget<C>): void {
    if (this.#widgets.has(w.type)) {
      throw new Error(`widget type ${w.type} already registered`);
    }
    this.#widgets.set(w.type, w as unknown as Widget<unknown>);
  }

  get<C = unknown>(type: string): Widget<C> {
    const w = this.#widgets.get(type);
    if (!w) throw new Error(`unknown widget type ${type}`);
    return w as Widget<C>;
  }

  has(type: string): boolean { return this.#widgets.has(type); }
  list(): string[] { return Array.from(this.#widgets.keys()); }
}

export const widgetRegistry = new Registry();
