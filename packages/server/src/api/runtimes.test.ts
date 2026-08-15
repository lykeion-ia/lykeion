import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { expectRejection } from "@lykeion/api/conformance";
import { makeServerLab } from "../test-support/test-lab";
import { isLoopbackRedirect } from "./runtimes";

function secretPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function pairInput(challenge: string, redirect = "http://127.0.0.1:7420/paired") {
  return { name: "ana-macbook", platform: "macos-aarch64", daemonVersion: "0.1.0", challenge, redirect };
}

async function exchange(base: string, code: string, verifier: string): Promise<Response> {
  return fetch(`${base}/daemon/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
}

/** A paired machine saying what it found, the way its daemon does. */
async function report(
  base: string,
  token: string,
  clis: Array<{
    id: string;
    name: string;
    command: string;
    version: string;
    available: boolean;
    sessionReady?: boolean;
    sessionReadyReason?: string;
    signedIn?: boolean;
    account?: string;
    heldBackReason?: string;
    adapterProvenance?: "vendor" | "protocol" | "community";
  }>,
): Promise<Response> {
  return fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: [],
      clis,
    }),
  });
}

it("mints a code an owner can approve, and the machine appears once exchanged", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));

  const res = await exchange(lab.base, code, verifier);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; runtimeId: string; machineName: string };
  expect(body.token).toMatch(/\S/);

  const [machine] = await lab.ownerApi.listRuntimes();
  expect(machine.name).toBe("ana-macbook");
  expect(machine.platform).toBe("macos-aarch64");
  expect(machine.health).toBe("online");
  expect(machine.capabilities).toEqual([]);
});

it("refuses a redirect that is not loopback", async () => {
  const lab = await makeServerLab();
  const { challenge } = secretPair();
  await expectRejection(
    lab.ownerApi.pairMachine(pairInput(challenge, "https://evil.example/steal")),
    "invalid",
    /loopback/,
  );
  expect(await lab.ownerApi.listRuntimes()).toEqual([]);
});

it("isLoopbackRedirect accepts only http on 127.0.0.1, localhost or [::1]", () => {
  for (const url of [
    "http://127.0.0.1:7420/paired",
    "http://localhost:7420/paired",
    "http://[::1]:7420/paired",
  ]) {
    expect(isLoopbackRedirect(url)).toBe(true);
  }
});

it("isLoopbackRedirect refuses everything that merely looks loopback", () => {
  for (const url of [
    "http://10.0.0.5:7420/paired",
    "https://127.0.0.1:7420/paired",
    "file:///etc/passwd",
    // Userinfo: a browser and `new URL` both resolve this host to
    // evil.example, not 127.0.0.1 — a prefix check reading the text before
    // the `@` would be fooled into trusting the wrong party entirely.
    "http://127.0.0.1@evil.example/",
    // Subdomain: "localhost" is one label of a longer host here, not the
    // whole of it — evil.example owns this name, not the loopback address.
    "http://localhost.evil.example/",
    "http://127.0.0.1.evil.example/",
  ]) {
    expect(isLoopbackRedirect(url)).toBe(false);
  }
});

it("accepts the loopback forms and nothing else", async () => {
  const lab = await makeServerLab();
  for (const redirect of ["http://127.0.0.1:7420/paired", "http://localhost:7420/paired"]) {
    const { challenge } = secretPair();
    await expect(lab.ownerApi.pairMachine(pairInput(challenge, redirect))).resolves.toBeDefined();
  }
  for (const redirect of ["http://10.0.0.5:7420/paired", "https://127.0.0.1:7420/paired", "file:///etc/passwd"]) {
    const { challenge } = secretPair();
    await expectRejection(lab.ownerApi.pairMachine(pairInput(challenge, redirect)), "invalid", /loopback/);
  }
});

it("refuses a code redeemed without the verifier, and spends it anyway", async () => {
  // The code travels through the address bar and into browser history. If
  // history alone could redeem it, a shared machine would be enough.
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));

  expect((await exchange(lab.base, code, "not-the-verifier")).status).toBe(400);
  expect(await lab.ownerApi.listRuntimes()).toEqual([]);

  // The verifier that actually matches this code's challenge, retried
  // against the same code a second time. It is refused too — not because
  // it is wrong, but because the first, failed attempt already spent the
  // code. A retry with the real verifier is what tells "spent" apart from
  // "mismatched": using a verifier from an unrelated pair here would be
  // refused either way, and would prove nothing about which reason it was.
  expect((await exchange(lab.base, code, verifier)).status).toBe(400);
});

it("refuses a code the second time it is used", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));

  expect((await exchange(lab.base, code, verifier)).status).toBe(200);
  expect((await exchange(lab.base, code, verifier)).status).toBe(400);
  expect(await lab.ownerApi.listRuntimes()).toHaveLength(1);
});

it("refuses to mint a second code for a request that has already been redeemed", async () => {
  // The single-approval rule, kept where it cannot be cleared: the approving
  // browser is the only thing that remembers having approved, and a second
  // browser, a second device, cleared site data or a forwarded link all
  // arrive at the lab looking like a first visit.
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  expect((await exchange(lab.base, code, verifier)).status).toBe(200);

  await expectRejection(lab.ownerApi.pairMachine(pairInput(challenge)), "conflict", /one approval/);
  // Nothing was minted, so nothing is out there to redeem into a second
  // machine standing for the same computer.
  expect(await lab.ownerApi.listRuntimes()).toHaveLength(1);
});

it("refuses a redeemed request whoever is approving it the second time", async () => {
  // The rule belongs to the request, not to the member who happened to
  // approve it. A link handed to a colleague is the path this closes, and a
  // guard scoped to the approver would leave it open.
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));
  expect((await exchange(lab.base, code, verifier)).status).toBe(200);

  await expectRejection(lab.ownerApi.pairMachine(pairInput(challenge)), "conflict", /one approval/);
  expect(await lab.ownerApi.listRuntimes()).toHaveLength(1);
});

it("still approves a request whose earlier code was never redeemed", async () => {
  // A handoff that failed before the machine exchanged anything leaves a
  // code nobody spent. The researcher trying again is making the same single
  // approval, not a second one, and refusing them would leave a machine that
  // can never be paired.
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  await lab.ownerApi.pairMachine(pairInput(challenge));

  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  // Minted, and good for the pairing the first attempt never finished.
  expect((await exchange(lab.base, code, verifier)).status).toBe(200);
  const [machine] = await lab.ownerApi.listRuntimes();
  expect(machine.name).toBe("ana-macbook");
});

it("refuses a code after five minutes", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  lab.advanceClock(301);
  expect((await exchange(lab.base, code, verifier)).status).toBe(400);
  expect(await lab.ownerApi.listRuntimes()).toEqual([]);
});

it("binds the machine to whoever approved it, not to the lab's owner", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));
  await exchange(lab.base, code, verifier);

  const [mine] = await lab.memberApi.listRuntimes();
  expect(mine.ownerId).toBe(lab.memberId);
});

it("shows a colleague's machine without saying what is installed on it", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };
  // The machine has to have said what it found before either assertion below
  // means anything: against a machine that never reported, the empty answer
  // is the only answer there is, and a reading that ignored ownership
  // entirely would give the same one.
  await report(lab.base, token, [
    { id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true },
  ]);

  const [fromOwnersView] = await lab.ownerApi.listRuntimes();
  expect(fromOwnersView.name).toBe("ana-macbook");
  // Absent, not empty: an empty list would read as "nothing installed".
  expect("clis" in fromOwnersView).toBe(false);
  expect(await lab.ownerApi.listAgentClis()).toEqual([]);

  // And the member it belongs to does see it, so the empty answer above is
  // the ownership rule refusing rather than nothing being there to find.
  expect((await lab.memberApi.listAgentClis()).map((cli) => cli.id)).toEqual(["claude"]);
});

it("lets the owning member remove their machine, and nobody else", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));
  await exchange(lab.base, code, verifier);
  const [mine] = await lab.memberApi.listRuntimes();

  await expectRejection(lab.ownerApi.removeRuntime(mine.id), "forbidden", /.+/);
  await lab.memberApi.removeRuntime(mine.id);
  expect(await lab.memberApi.listRuntimes()).toEqual([]);
});

it("revokes the token when the machine is removed", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };
  const [machine] = await lab.ownerApi.listRuntimes();

  await lab.ownerApi.removeRuntime(machine.id);

  const beat = await fetch(`${lab.base}/daemon/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  expect(beat.status).toBe(401);
});

it("revokes every machine a member owned when they are offboarded", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };

  await lab.ownerApi.removeMember(lab.memberId);

  expect(await lab.ownerApi.listRuntimes()).toEqual([]);
  const beat = await fetch(`${lab.base}/daemon/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  expect(beat.status).toBe(401);
});

it("refuses a still-outstanding code once the member who minted it is offboarded", async () => {
  // A code nobody has redeemed yet is not a machine `removeMember` can find
  // by walking `runtimes` — it names no runtime until it is exchanged. The
  // sweep has to reach `pair_requests` directly, or the code outlives the
  // membership that was ever going to vouch for it.
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));

  await lab.ownerApi.removeMember(lab.memberId);

  expect((await exchange(lab.base, code, verifier)).status).toBe(400);
  expect(await lab.ownerApi.listRuntimes()).toEqual([]);
});

it("carries a CLI's sessionReady through the report, with the reason absent once it is ready", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };

  await report(lab.base, token, [
    { id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true, sessionReady: true },
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      version: "1.0.0",
      available: true,
      sessionReady: false,
      sessionReadyReason: "the codex-acp adapter is not installed — install it to run codex sessions",
    },
  ]);

  const clis = await lab.ownerApi.listAgentClis();
  const claude = clis.find((c) => c.id === "claude")!;
  const codex = clis.find((c) => c.id === "codex")!;
  expect(claude.sessionReady).toBe(true);
  expect("sessionReadyReason" in claude).toBe(false);
  expect(codex.sessionReady).toBe(false);
  expect(codex.sessionReadyReason).toBe(
    "the codex-acp adapter is not installed — install it to run codex sessions",
  );
});

it("puts sessions in a machine's capabilities once one of its CLIs is session-ready", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };

  const [before] = await lab.ownerApi.listRuntimes();
  expect(before!.capabilities).toEqual([]);

  await report(lab.base, token, [
    { id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true, sessionReady: false },
  ]);
  const [stillBlocked] = await lab.ownerApi.listRuntimes();
  expect(stillBlocked!.capabilities).toEqual([]);

  await report(lab.base, token, [
    { id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true, sessionReady: true },
  ]);
  const [after] = await lab.ownerApi.listRuntimes();
  expect(after!.capabilities).toEqual(["sessions"]);
});

it("shows a colleague's capabilities without showing which CLI produced them", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.memberApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };

  await report(lab.base, token, [
    { id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true, sessionReady: true },
  ]);

  const [fromOwnersView] = await lab.ownerApi.listRuntimes();
  expect(fromOwnersView!.capabilities).toEqual(["sessions"]);
  expect("clis" in fromOwnersView!).toBe(false);
});

// ---------------------------------------------------------------------------
// Auth state, and who may read it.
//
// Whether an agent is signed in — and as whom — is the researcher's own
// account with a third party. It travels because the machine's own page has
// to show it; it travels no further than the member who paired that machine.
// ---------------------------------------------------------------------------

it("tells the member who paired a machine whether each agent is signed in", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };

  await report(lab.base, token, [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      version: "2.1.231",
      available: true,
      sessionReady: true,
      signedIn: true,
      account: "ana@uni.edu",
      adapterProvenance: "protocol",
    },
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      version: "0.58.0",
      available: true,
      sessionReady: false,
      sessionReadyReason: "not signed in",
      signedIn: false,
    },
    {
      id: "qoder",
      name: "Qoder",
      command: "qoder",
      version: "1.0.0",
      available: true,
      sessionReady: false,
      sessionReadyReason: "isolation unverified",
      heldBackReason:
        "answered as signed in from a home created empty a moment ago, so Lykeion cannot keep its runs separate from yours",
    },
  ]);

  const clis = await lab.ownerApi.listAgentClis();
  expect(clis.find((c) => c.id === "claude")).toMatchObject({
    signedIn: true,
    account: "ana@uni.edu",
    adapterProvenance: "protocol",
  });
  // False, not absent. "Signed out" is a fact a row acts on — it is what puts
  // a Sign in control there — and it must not read the same as an agent whose
  // sign-in was never asked about.
  expect(clis.find((c) => c.id === "codex")).toMatchObject({ signedIn: false });
  expect("account" in clis.find((c) => c.id === "codex")!).toBe(false);
  expect(clis.find((c) => c.id === "qoder")).toMatchObject({
    heldBackReason:
      "answered as signed in from a home created empty a moment ago, so Lykeion cannot keep its runs separate from yours",
  });
  expect("signedIn" in clis.find((c) => c.id === "qoder")!).toBe(false);
});

it("tells nobody else", async () => {
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };
  await report(lab.base, token, [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      version: "2.1.231",
      available: true,
      sessionReady: true,
      signedIn: true,
      account: "ana@uni.edu",
    },
  ]);

  // The owner paired it, so the member sees nothing — the same `WHERE
  // r.owner_id = ?` that has always guarded this, standing between somebody
  // else's colleague and the address they signed in to Claude with.
  await expect(lab.memberApi.listAgentClis()).resolves.toEqual([]);
});

it("announces a sign-in even when nothing else about the agent changed", async () => {
  // The gate that decides whether a change is worth telling anybody about
  // compares a fixed set of fields. A researcher signing in mid-session
  // changes `signedIn` and `account` — and, on a machine whose adapter was
  // already resolved and ready, nothing else. Left out of that comparison,
  // the row is rewritten and no page is told, so the screen that exists to
  // show this goes on showing the opposite until a reload nobody knows to do.
  const lab = await makeServerLab();
  const { verifier, challenge } = secretPair();
  const { code } = await lab.ownerApi.pairMachine(pairInput(challenge));
  const { token } = (await (await exchange(lab.base, code, verifier)).json()) as { token: string };

  const base = {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    version: "2.1.231",
    available: true,
    sessionReady: true,
  };
  await report(lab.base, token, [{ ...base, signedIn: false }]);
  const before = await lab.ownerApi.listRuntimes();

  await report(lab.base, token, [{ ...base, signedIn: true, account: "ana@uni.edu" }]);

  const [after] = await lab.ownerApi.listRuntimes();
  expect(after.clis?.find((c) => c.id === "claude")).toMatchObject({
    signedIn: true,
    account: "ana@uni.edu",
  });
  expect(before[0]!.clis?.find((c) => c.id === "claude")).toMatchObject({ signedIn: false });
});
