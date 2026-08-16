import { forceParsing } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import {
  type EditorView,
  type ViewUpdate,
  ViewPlugin,
} from "@codemirror/view";
import { extractOutline, type OutlineHeading } from "./outline";

export const DEFAULT_PARSE_SLICE_MS = 20;

/**
 * Published alongside the outline tree: the `Text` value is the exact doc
 * revision the offsets were extracted from. Consumers compare it against
 * their current doc to reject stale navigation requests.
 */
export type OutlinePublish = (
  headings: ReadonlyArray<OutlineHeading>,
  doc: Text,
) => void;

export interface OutlinePublisherOptions {
  readonly debounceMs?: number;
  readonly parseSliceMs?: number;
}

type IdleWork =
  | { readonly kind: "idle"; readonly handle: number }
  | { readonly kind: "timeout"; readonly handle: ReturnType<typeof setTimeout> };

class OutlinePublisher {
  readonly #view: EditorView;
  readonly #publish: OutlinePublish;
  readonly #debounceMs: number;
  readonly #parseSliceMs: number;
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #idleWork: IdleWork | null = null;
  #destroyed = false;

  constructor(
    view: EditorView,
    publish: OutlinePublish,
    options: OutlinePublisherOptions,
  ) {
    this.#view = view;
    this.#publish = publish;
    this.#debounceMs = options.debounceMs ?? 120;
    this.#parseSliceMs = options.parseSliceMs ?? DEFAULT_PARSE_SLICE_MS;
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
    this.#publish(extractOutline(this.#view.state), this.#view.state.doc);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#generation += 1;
    this.#clearScheduledWork();
  }
}

export const outlinePublisherExtension = (
  publish: OutlinePublish,
  options: OutlinePublisherOptions = {},
): Extension =>
  ViewPlugin.define(
    (view) => new OutlinePublisher(view, publish, options),
  );
