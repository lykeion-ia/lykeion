import { afterAll } from "vitest";
import type { LykeionApi } from "@lykeion/api";
import {
  conversationWritesConformance,
  pairingUnsupportedConformance,
  runContractConformance,
  taskChatRunConformance,
  type ConformanceLab,
} from "@lykeion/api/conformance";
import { makeServerApi } from "./test-support/server-api";
import { makeServerLab } from "./test-support/test-lab";

const cleanups: Array<() => Promise<void>> = [];

async function makeApi(): Promise<LykeionApi> {
  const handle = await makeServerApi();
  cleanups.push(handle.close);
  return handle.api;
}

async function makeLab(): Promise<ConformanceLab> {
  const lab = await makeServerLab();
  cleanups.push(lab.close);
  return { owner: lab.ownerApi, member: lab.memberApi };
}

afterAll(async () => {
  for (const done of cleanups.splice(0)) await done();
});

/**
 * Every area of the contract this server can satisfy, from the one list the
 * in-memory implementation is held to — so an area that exists and is not
 * run shows up as a drop in the count rather than as silence.
 *
 * Three areas are skipped, for two different reasons. Completing a turn needs
 * a machine, which this server answers `unsupported` for, honestly, the same
 * way every kernel method does. Keeping a thread and its messages needs
 * somewhere to put them and nothing yet stores one — the conversation READS
 * are still held here, because a server with no threads can still answer
 * "you have none" correctly.
 *
 * Pairing is skipped for the opposite reason to both. It is the one thing
 * this server can really do that `pairingUnsupportedConformance` asserts
 * every implementation refuses: this server is the implementation that
 * capability exists for, so holding it to an area written for one that
 * categorically lacks a lab would assert the opposite of what it does.
 * `runtimes.test.ts` holds the real behavior to account instead.
 */
runContractConformance("workspace server", makeApi, {
  skip: [
    taskChatRunConformance,
    conversationWritesConformance,
    pairingUnsupportedConformance,
  ],
  makeLab,
});
