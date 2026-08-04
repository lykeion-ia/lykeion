import { afterEach, expect, it } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { RouterProvider } from "./router";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", window.location.pathname);
});

/** Move the address bar the way something outside the router would. */
function setHash(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
}

it("takes its own fragment with it when it goes", () => {
  window.location.hash = "#/studies";
  const view = render(
    <RouterProvider>
      <p>the workbench</p>
    </RouterProvider>,
  );

  view.unmount();

  expect(window.location.hash).toBe("");
});

it("leaves an invite fragment alone on the way out", () => {
  // The workbench unmounts when the session behind it turns out to be gone,
  // and an invite link is a common reason to find that out — somebody opens
  // one in a tab that has been sitting signed in. The code in the address
  // bar is a working credential and the only copy of it they have; the
  // router passes it through on its way to the gate above, and passing
  // through is not the same as owning it.
  window.location.hash = "#/studies";
  const view = render(
    <RouterProvider>
      <p>the workbench</p>
    </RouterProvider>,
  );

  setHash("#/join/inv_still_good");
  view.unmount();

  expect(window.location.hash).toBe("#/join/inv_still_good");
});

it("leaves a pairing fragment alone on the way out", () => {
  // Same reasoning as the invite link above: a pairing URL is a link the
  // daemon printed, handed to a browser that may already have been sitting
  // signed in. If the session behind it turns out to be gone, the workbench
  // unmounts to show sign-in — and the pairing parameters must survive that
  // round trip, or approving after signing back in has nothing left to show.
  window.location.hash = "#/studies";
  const view = render(
    <RouterProvider>
      <p>the workbench</p>
    </RouterProvider>,
  );

  setHash("#/pair?name=demo-machine&redirect=http%3A%2F%2F127.0.0.1%3A9999%2Fpaired");
  view.unmount();

  expect(window.location.hash).toBe(
    "#/pair?name=demo-machine&redirect=http%3A%2F%2F127.0.0.1%3A9999%2Fpaired",
  );
});

it("still clears a fragment it navigated to itself", () => {
  window.location.hash = "#/studies";
  const view = render(
    <RouterProvider>
      <p>the workbench</p>
    </RouterProvider>,
  );

  setHash("#/settings/members");
  view.unmount();

  expect(window.location.hash).toBe("");
});
