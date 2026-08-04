/**
 * The one way the interface posts to `/auth/`. Every one of those routes
 * requires `application/json`, and refuses anything else with a 415: the
 * type is not CORS-simple, so demanding it is what stops another site's
 * form or `no-cors` fetch from reaching a route that signs somebody out or
 * claims an unclaimed lab.
 *
 * A body is always sent, `{}` when the caller has nothing to say, because a
 * `fetch` with no body sends no content type at all — the header cannot be
 * set on a request that has nothing to describe. Routing every caller
 * through here is what keeps a route that takes no arguments from being the
 * one that is refused.
 */
export function postAuth(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}
