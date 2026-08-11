import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

/**
 * `findBy*` and `waitFor` carry their own one-second budget, independent of
 * the runner's per-test limit. The suites that drive an agent turn through
 * plan, approval and permission wait on real timers at each step, and on a
 * loaded machine a single step can pass a second — reporting "unable to find
 * role=button" for an element that simply had not been rendered yet. Waiting
 * longer costs a passing test nothing, because it resolves as soon as the
 * element appears.
 */
configure({ asyncUtilTimeout: 5000 });

// Everything below patches gaps in jsdom, and this file runs for every suite
// in the package — including the rare one that asks for the node environment
// because what it tests is not a component (`dev-proxy.test.ts` reads the
// Vite config, which will not load under jsdom's `TextEncoder`). Reaching for
// `window` there is a crash during setup, before that suite runs a line, so
// the patches are skipped where there is no DOM to patch.
if (typeof window !== "undefined") {
  // jsdom lacks matchMedia; the app queries prefers-color-scheme. Stub it.
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  // jsdom lacks scrollIntoView; some list navigation calls it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  // jsdom lacks ResizeObserver, and has no layout to feed one anyway. The
  // breadcrumb's tab band watches itself to know whether its tabs still fit;
  // under test the geometry is stated outright and the band is nudged with a
  // scroll event, so a no-op observer is the whole of what is needed here.
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  // jsdom lacks Blob.text(); importing a JSON file reads the picked file with
  // it. FileReader is implemented, so read through that.
  if (!Blob.prototype.text) {
    Blob.prototype.text = function (this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
}
