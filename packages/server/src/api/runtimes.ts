import {
  LykeionError,
  type AgentCli,
  type LykeionApi,
  type PairMachineInput,
  type Runtime,
  type RuntimeCapability,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Row, Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { hashSecret, newToken } from "../auth";
import { healthFor } from "../runtime-health";

export type RuntimesApi = Pick<
  LykeionApi,
  "listRuntimes" | "listAgentClis" | "pairMachine" | "removeRuntime"
>;

/** Long enough for an approving browser to be handed off to the daemon and
 *  redirected back; short enough that a code left sitting in history is not
 *  a standing door into the lab. */
const PAIR_CODE_TTL_SECONDS = 5 * 60;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a redirect is safe to hand a pairing code to. Checked here, not
 * on the approval screen: a crafted link must fail to mint a code at all,
 * rather than depend on a UI declining to navigate to it.
 */
export function isLoopbackRedirect(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

function toAgentCli(row: Row): AgentCli {
  return {
    id: row.cli_id as string,
    name: row.name as string,
    command: row.command as string,
    version: row.version as string,
    available: row.available === 1,
    runtimeId: row.runtime_id as string,
  };
}

function toRuntime(row: Row, now: number, clis: AgentCli[] | undefined): Runtime {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerId: row.owner_id as string,
    platform: row.platform as string,
    daemonVersion: row.daemon_version as string,
    health: healthFor(row.last_seen_ts as number, now),
    lastSeenTs: row.last_seen_ts as number,
    capabilities: JSON.parse(row.capabilities as string) as RuntimeCapability[],
    ...(clis === undefined ? {} : { clis }),
  };
}

function requireOwnedRuntime(store: Store, runtimeId: string, callerId: string): Row {
  const row = store.get(`SELECT owner_id, removed_ts FROM runtimes WHERE id = ?`, [runtimeId]);
  if (!row) throw new LykeionError("not-found", `no such machine: ${runtimeId}`);
  if (row.owner_id !== callerId)
    throw new LykeionError("forbidden", "only the member who paired a machine may remove it");
  return row;
}

export function runtimesApi(deps: Deps): RuntimesApi {
  const { store, actor, now } = deps;
  const { record } = deps.changes;
  return {
    async listRuntimes() {
      const nowTs = now();
      return store
        .all(`SELECT * FROM runtimes WHERE removed_ts IS NULL`)
        .sort(
          (a, b) =>
            (a.name as string).localeCompare(b.name as string) || (a.seq as number) - (b.seq as number),
        )
        .map((row) => {
          const mine = row.owner_id === actor.userId;
          const clis = mine
            ? store
                .all(`SELECT * FROM runtime_clis WHERE runtime_id = ? ORDER BY seq ASC`, [row.id as string])
                .map(toAgentCli)
            : undefined;
          return toRuntime(row, nowTs, clis);
        });
    },

    async listAgentClis() {
      return store
        .all(
          `SELECT c.* FROM runtime_clis c
             JOIN runtimes r ON r.id = c.runtime_id
            WHERE r.owner_id = ? AND r.removed_ts IS NULL
            ORDER BY c.seq ASC`,
          [actor.userId],
        )
        .map(toAgentCli);
    },

    async pairMachine(input: PairMachineInput) {
      if (!isLoopbackRedirect(input.redirect))
        throw new LykeionError(
          "invalid",
          `pairing must redirect to a loopback address (127.0.0.1, localhost, or [::1]), not "${input.redirect}"`,
        );
      return store.tx(() => {
        // One approval per pairing request, decided here rather than by the
        // browser that did the approving. A link carries its challenge in
        // the address bar, so the same one opens in a second browser, on a
        // second device, or in the hands of a colleague it was forwarded to
        // — and every one of those is a first visit as far as anything the
        // approving browser remembers is concerned.
        //
        // A code that was minted and then went nowhere is not an approval:
        // a handoff can fail before the machine ever exchanges anything, and
        // a researcher approving a second time after that is doing the same
        // single approval again. What closes a request is its code being
        // spent — traded at the exchange for a machine identity, burned by
        // an exchange that arrived without the right verifier, or swept away
        // when the member who minted it left the lab. Nothing is minted
        // against a request once one of those has happened to it.
        const spent = store.get(
          `SELECT spent_ts FROM pair_requests WHERE challenge = ? AND spent_ts IS NOT NULL`,
          [input.challenge],
        );
        if (spent)
          throw new LykeionError(
            "conflict",
            "a pairing link is good for exactly one approval, and this one is spent — " +
              "the machine it names may already be paired, and if it is not, restarting the daemon " +
              "on it offers a fresh link",
          );
        const ts = now();
        const code = newToken();
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO pair_requests
             (code_hash, challenge, owner_id, name, platform, daemon_version, redirect, created_ts, expires_ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            hashSecret(code),
            input.challenge,
            actor.userId,
            input.name,
            input.platform,
            input.daemonVersion,
            input.redirect,
            ts,
            ts + PAIR_CODE_TTL_SECONDS,
            seq,
          ],
        );
        return { code };
      });
    },

    async removeRuntime(runtimeId) {
      store.tx(() => {
        const row = requireOwnedRuntime(store, runtimeId, actor.userId);
        // Removing an already-removed machine is not an error, the same way
        // withdrawing a withdrawn invite is not: the state the caller asked
        // for already holds.
        if (row.removed_ts !== null) return;
        const ts = now();
        store.run(`UPDATE runtimes SET removed_ts = ? WHERE id = ?`, [ts, runtimeId]);
        store.run(
          `UPDATE machine_tokens SET revoked_ts = ? WHERE runtime_id = ? AND revoked_ts IS NULL`,
          [ts, runtimeId],
        );
        record("runtime-removed", {});
      });
    },
  };
}
