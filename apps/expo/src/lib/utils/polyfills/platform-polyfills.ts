/* eslint-disable @typescript-eslint/unbound-method */

import "fast-text-encoding";
import "react-native-url-polyfill/auto";

import {
  EventTarget as EventTargetPolyfill,
} from "event-target-shim";
import Graphemer from "graphemer";

export {};

class EventPolyfill {
  readonly bubbles = false;
  readonly cancelable = false;
  readonly composed = false;
  readonly defaultPrevented = false;

  constructor(readonly type: string) {}

  preventDefault() {}

  stopPropagation() {}

  stopImmediatePropagation() {}
}

if (!globalThis.EventTarget) {
  Object.assign(globalThis, { EventTarget: EventTargetPolyfill });
}
if (!globalThis.Event) {
  Object.assign(globalThis, { Event: EventPolyfill });
}

const splitter = new Graphemer();
globalThis.Intl = globalThis.Intl || {};

// @ts-expect-error we're polyfilling -prf
globalThis.Intl.Segmenter =
  globalThis.Intl.Segmenter ||
  class Segmenter {
    constructor() {}
    // NOTE
    // this is not a precisely correct polyfill but it's sufficient for our needs
    // -prf
    segment = splitter.iterateGraphemes;
  };
