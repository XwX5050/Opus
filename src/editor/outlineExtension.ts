import { forceParsing } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
  type EditorView,
  type ViewUpdate,
  ViewPlugin,
} from "@codemirror/view";
import { extractOutline, type OutlineHeading } from "./outline";

export interface OutlinePublisherOptions {
  readonly debounceMs?: number;
  readonly parseSliceMs?: number;
}

type IdleWork =
  | { readonly kind: "idle"; readonly handle: number }
  | { readonly kind: "timeout"; readonly handle: ReturnType<typeof setTimeout> };

class OutlinePublisher {
  readonly #view: EditorView;
  readonly #publish: (headings: ReadonlyArray<OutlineHeading>) => void;
  readonly #debounceMs: number;
  readonly #parseSliceMs: number;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #idleWork: IdleWork | null = null;
  #destroyed = false;

  constructor(
    view: EditorView,
    publish: (headings: ReadonlyArray<OutlineHeading>) => void,
    options: OutlinePublisherOptions,
  ) {
    this.#view = view;
    this.#publish = publish;
    this.#debounceMs = options.debounceMs ?? 120;
    this.#parseSliceMs = options.parseSliceMs ?? 20;
    this.#schedule(0);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.#schedule(this.#debounceMs);
  }

  #clearScheduledWork(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#idleWork?.kind === "idle") {
      globalThis.cancelIdleCallback(this.#idleWork.handle);
    } else if (this.#idleWork?.kind === "timeout") {
      clearTimeout(this.#idleWork.handle);
    }
    this.#idleWork = null;
  }

  #schedule(delay: number): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#clearScheduledWork();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#parse(generation);
    }, delay);
  }

  #scheduleIdle(generation: number): void {
    if (typeof globalThis.requestIdleCallback === "function") {
      const handle = globalThis.requestIdleCallback(() => {
        this.#idleWork = null;
        this.#parse(generation);
      });
      this.#idleWork = { kind: "idle", handle };
      return;
    }
    const handle = setTimeout(() => {
      this.#idleWork = null;
      this.#parse(generation);
    }, 0);
    this.#idleWork = { kind: "timeout", handle };
  }

  #parse(generation: number): void {
    if (this.#destroyed || generation !== this.#generation) return;
    const complete = forceParsing(
      this.#view,
      this.#view.state.doc.length,
      this.#parseSliceMs,
    );
    if (!complete) {
      this.#scheduleIdle(generation);
      return;
    }
    if (this.#destroyed || generation !== this.#generation) return;
    this.#publish(extractOutline(this.#view.state));
  }

  destroy(): void {
    this.#destroyed = true;
    this.#generation += 1;
    this.#clearScheduledWork();
  }
}

export const outlinePublisherExtension = (
  publish: (headings: ReadonlyArray<OutlineHeading>) => void,
  options: OutlinePublisherOptions = {},
): Extension =>
  ViewPlugin.define(
    (view) => new OutlinePublisher(view, publish, options),
  );
