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

// jsdom lacks Blob.text(); importing a JSON file reads the picked file with it.
// FileReader is implemented, so read through that.
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
