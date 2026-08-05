/**
 * Test support: a workspace server with a second, non-owner member already
 * admitted beside the owner — what the membership tests need and the
 * single-owner harness in `server-api.ts` does not build. Built on the same
 * `startTestServer`/`apiFor` this shares with that harness, so both start a
 * server the same way and differ only in who is signed in when they hand
 * control back.
 */
import type { ServerConfig } from "../config";
import type { LykeionApi } from "@lykeion/api";
import { createHash, randomBytes } from "node:crypto";
import { apiFor, signUpOwner, startTestServer } from "./server-api";

export interface Lab {
  base: string;
  /** The owner's session cookie, for the pre-auth routes and the stream. */
  cookie: string;
  /** The member's, for the same reasons — and for showing what a member can
   *  reach on a surface the contract does not run through. */
  memberCookie: string;
  ownerApi: LykeionApi;
  memberApi: LykeionApi;
  memberId: string;
  /** Move the server's clock forward, in seconds. Expiry is time rather
   *  than state, and a test that waits for it is a test nobody runs. */
  advanceClock(seconds: number): void;
  close(): Promise<void>;
}

async function redeemInvite(
  base: string,
  code: string,
  email: string,
  displayName: string,
): Promise<string> {
  const res = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, email, displayName, password: "a good long password" }),
  });
  if (!res.ok) throw new Error(`redeem-invite answered ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/**
 * A fresh lab with an owner and one member, both signed in, and a clock the
 * test controls. `overrides` reaches `startTestServer` unchanged, for a
 * test that needs a non-default `ServerConfig` field.
 */
export async function makeServerLab(overrides?: Partial<ServerConfig>): Promise<Lab> {
  let clock = Math.floor(Date.now() / 1000);
  const server = await startTestServer(overrides, () => clock);

  const cookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, cookie);

  const invite = await ownerApi.createInvite("member");
  const memberCookie = await redeemInvite(server.base, invite.code, "member@lab.example", "Member");
  const memberApi = apiFor(server.base, memberCookie);
  const memberId = (await memberApi.currentUser()).id;

  return {
    base: server.base,
    cookie,
    memberCookie,
    ownerApi,
    memberApi,
    memberId,
    advanceClock(seconds: number) {
      clock += seconds;
    },
    close: server.close,
  };
}

/** A conformance lab with one real paired runtime reported for its owner.
 *  No daemon is simulated: the decision cases only need a durable live run
 *  to address, not an adapter response. */
export async function makeRunnableServerLab(): Promise<Lab> {
  const lab = await makeServerLab();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { code } = await lab.ownerApi.pairMachine({
    name: "conformance-machine",
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    challenge,
    redirect: "http://127.0.0.1:7420/paired",
  });
  const exchanged = await fetch(`${lab.base}/daemon/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  if (!exchanged.ok) throw new Error(`pair exchange answered ${exchanged.status}`);
  const { token } = (await exchanged.json()) as { token: string };
  const reported = await fetch(`${lab.base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: ["sessions"],
      clis: [
        {
          id: "claude",
          name: "Claude Code",
          command: "claude",
          version: "2.1.220",
          available: true,
          sessionReady: true,
        },
      ],
    }),
  });
  if (!reported.ok) throw new Error(`runtime report answered ${reported.status}`);
  return lab;
}
