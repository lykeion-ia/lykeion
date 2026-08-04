/**
 * Open a URL in a new tab instead of navigating the current one — a link
 * clicked inside an agent's reply must never replace the app itself.
 *
 * `noopener` stops the opened page from reaching back through `window.opener`.
 * A popup blocker can refuse the call and return `null`; opening a link is
 * fire-and-forget, so there is nothing to recover.
 */
export function openExternal(url: string): void {
  window.open(url, "_blank", "noopener");
}
