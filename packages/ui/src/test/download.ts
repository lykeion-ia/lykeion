import { onTestFinished } from "vitest";

/**
 * jsdom cannot download: it has no object URLs, and clicking an anchor
 * navigates instead of honouring `download`. Stand in for both, and hand back
 * the file a browser would have saved. Restores itself when the test ends.
 */
export function captureDownload() {
  const url = URL as unknown as Record<string, unknown>;
  const nativeClick = HTMLAnchorElement.prototype.click;
  let blob: Blob | undefined;
  let name: string | undefined;

  url.createObjectURL = (b: Blob) => {
    blob = b;
    return "blob:export";
  };
  url.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    name = this.download;
  };
  onTestFinished(() => {
    HTMLAnchorElement.prototype.click = nativeClick;
    delete url.createObjectURL;
    delete url.revokeObjectURL;
  });

  return {
    /** The saved file: its download name, and its parsed JSON document. */
    async saved() {
      return { name, doc: JSON.parse(await blob!.text()) };
    },
  };
}
