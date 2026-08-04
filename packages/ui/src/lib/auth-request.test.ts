import { afterEach, expect, it, vi } from "vitest";
import { postAuth } from "./auth-request";

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("{}", { status: 200 });
  });
  return calls;
}

it("declares JSON, which is what the auth routes require", async () => {
  const calls = captureFetch();

  await postAuth("/auth/signin", { email: "ana@lab.example", password: "hunter22" });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.init.method).toBe("POST");
  expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    email: "ana@lab.example",
    password: "hunter22",
  });
});

it("sends a body even where there is nothing to say", async () => {
  // Sign-out carries no arguments, and a fetch with no body sends no content
  // type — so the route that needs the fewest fields is the one that would
  // be refused. An empty object is what keeps the header on the request.
  const calls = captureFetch();

  await postAuth("/auth/signout");

  expect(calls[0]!.init.body).toBe("{}");
  expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
});
