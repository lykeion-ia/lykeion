import { describe, expect, it } from "vitest";
import type { Member } from "@lykeion/api";
import {
  agentAvatar,
  assigneeAvatar,
  assigneeKey,
  directoryOf,
  displayName,
  pendingDirectory,
} from "./assignee";

const members: Member[] = [
  {
    user: {
      id: "u_amara",
      email: "amara@lab.example",
      displayName: "Amara",
      createdTs: 0,
    },
    role: "owner",
    joinedTs: 0,
  },
];
const dir = directoryOf(members);

describe("assignee", () => {
  it("names a person from the directory", () => {
    expect(displayName({ kind: "user", userId: "u_amara" }, dir)).toBe(
      "Amara",
    );
  });

  it("names an agent from the assignee itself", () => {
    expect(displayName({ kind: "agent", name: "statistician" }, dir)).toBe(
      "Statistician",
    );
  });

  it("names an unknown user without crashing the row", () => {
    expect(displayName({ kind: "user", userId: "u_gone" }, dir)).toBe(
      "Unknown member",
    );
  });

  it("renders a pending lookup as blank, not 'Unknown member', before the directory loads", () => {
    expect(
      displayName({ kind: "user", userId: "u_amara" }, pendingDirectory()),
    ).toBe("");
  });

  it("gives an agent its own avatar without a directory", () => {
    expect(agentAvatar("statistician").label).toBe("Statistician");
  });

  it("keys people and agents into separate namespaces", () => {
    expect(assigneeKey({ kind: "user", userId: "vega" })).not.toBe(
      assigneeKey({ kind: "agent", name: "vega" }),
    );
  });

  it("gives a stable initial and gradient", () => {
    const a = assigneeAvatar({ kind: "user", userId: "u_amara" }, dir);
    const b = assigneeAvatar({ kind: "user", userId: "u_amara" }, dir);
    expect(a.initial).toBe("A");
    expect(a.gradient).toEqual(b.gradient);
  });
});
