import { expect, it } from "vitest";
import { readDaemonConfig } from "./config";

it("defaults to a free loopback port and no lab", () => {
  const config = readDaemonConfig({}, []);
  expect(config.port).toBe(0);
  expect(config.lab).toBeUndefined();
  expect(config.openBrowser).toBe(true);
});

it("takes the lab from a flag", () => {
  expect(readDaemonConfig({}, ["--lab", "https://lab.uni.edu"]).lab).toBe("https://lab.uni.edu");
});

it("takes the lab from the environment when no flag is given", () => {
  expect(readDaemonConfig({ LYKEION_LAB: "https://lab.uni.edu" }, []).lab).toBe("https://lab.uni.edu");
});

it("lets a flag beat the environment", () => {
  const config = readDaemonConfig({ LYKEION_LAB: "https://env.example" }, ["--lab", "https://flag.example"]);
  expect(config.lab).toBe("https://flag.example");
});

it("refuses a port that is not a port number", () => {
  expect(() => readDaemonConfig({}, ["--port", "notaport"])).toThrow(/LYKEION_DAEMON_PORT/);
});

it("treats an empty value as unset", () => {
  expect(readDaemonConfig({ LYKEION_LAB: "" }, []).lab).toBeUndefined();
});

it("suppresses the browser when asked", () => {
  expect(readDaemonConfig({}, ["--no-browser"]).openBrowser).toBe(false);
});

it("serves when no command is named", () => {
  expect(readDaemonConfig({}, []).command).toBe("serve");
  expect(readDaemonConfig({}, ["--lab", "https://lab.uni.edu"]).command).toBe("serve");
});

it("takes each of the commands it has", () => {
  expect(readDaemonConfig({}, ["serve", "--no-browser"]).command).toBe("serve");
  expect(readDaemonConfig({}, ["status"]).command).toBe("status");
  expect(readDaemonConfig({}, ["stop"]).command).toBe("stop");
});

it("refuses a command it does not have, saying which it does", () => {
  expect(() => readDaemonConfig({}, ["restart"])).toThrow(
    /restart is not a command.*serve, status, or stop.*--help/,
  );
});

it("answers for itself rather than serving when asked what it is", () => {
  // Both are answers about this program, and both have to come back as
  // something other than "serve": serving is how a run of this binds two
  // ports, claims a data directory and mints a machine identity, which is
  // not what somebody typing --help asked for.
  expect(readDaemonConfig({}, ["--help"]).command).toBe("help");
  expect(readDaemonConfig({}, ["-h"]).command).toBe("help");
  expect(readDaemonConfig({}, ["--version"]).command).toBe("version");
  // Wherever they appear, and whatever they appear beside.
  expect(readDaemonConfig({}, ["serve", "--lab", "https://lab.uni.edu", "--help"]).command).toBe("help");
  expect(readDaemonConfig({}, ["status", "--version"]).command).toBe("version");
});

it("refuses a flag it does not have rather than serving anyway", () => {
  // A typo in a leading flag is otherwise indistinguishable from no flag at
  // all, and reading either as serve pairs a machine nobody asked to pair.
  expect(() => readDaemonConfig({}, ["--lba", "https://lab.uni.edu"])).toThrow(/--lba is not something/);
  expect(() => readDaemonConfig({}, ["serve", "--porrt", "9000"])).toThrow(/--porrt is not something/);
  expect(() => readDaemonConfig({}, ["status", "extra"])).toThrow(/extra is not something/);
});

it("refuses a flag whose value is missing or is the next flag", () => {
  // The two shapes this goes wrong in, and neither announces itself: the
  // first would stop the daemon in the default directory rather than the one
  // that was meant, and the second would keep a machine's identity in a
  // directory called --no-browser.
  expect(() => readDaemonConfig({}, ["stop", "--data-dir"])).toThrow(/--data-dir needs a value/);
  expect(() => readDaemonConfig({}, ["--data-dir", "--no-browser"])).toThrow(
    /--data-dir needs a value, and --no-browser is another flag/,
  );
  expect(() => readDaemonConfig({}, ["--lab"])).toThrow(/--lab needs a value/);
});

it("takes a value flag written with an equals sign", () => {
  // The form a great many hands type by reflex. It names the same thing the
  // spaced form does, so it is the same thing.
  expect(readDaemonConfig({}, ["status", "--data-dir=/tmp/lyk-p1"]).dataDir).toBe("/tmp/lyk-p1");
  expect(readDaemonConfig({}, ["--lab=https://lab.uni.edu"]).lab).toBe("https://lab.uni.edu");
  expect(readDaemonConfig({}, ["serve", "--port=9000"]).port).toBe(9000);
});

it("takes an equals value at its word even when it looks like a flag", () => {
  // Nothing is ambiguous about this line: the value is joined to the flag
  // that takes it, so a directory named like a flag is a directory named
  // like a flag, and --no-browser was never given.
  const config = readDaemonConfig({}, ["--data-dir=--no-browser"]);
  expect(config.dataDir).toBe("--no-browser");
  expect(config.openBrowser).toBe(true);
});

it("refuses an equals form with nothing after the sign", () => {
  expect(() => readDaemonConfig({}, ["--lab="])).toThrow(
    /--lab needs a value, and nothing followed the =/,
  );
  expect(() => readDaemonConfig({}, ["stop", "--data-dir="])).toThrow(/--data-dir needs a value/);
});

it("refuses a value handed to a flag that does not take one", () => {
  expect(() => readDaemonConfig({}, ["--no-browser=true"])).toThrow(
    /--no-browser does not take a value/,
  );
});

it("reads a flag written before the command", () => {
  // `status` is one of the three commands wherever it appears on the line,
  // and a flag ahead of it does not make it something this program does not
  // take.
  const spaced = readDaemonConfig({}, ["--data-dir", "/tmp/lyk-p1", "status"]);
  expect(spaced.command).toBe("status");
  expect(spaced.dataDir).toBe("/tmp/lyk-p1");
  const joined = readDaemonConfig({}, ["--data-dir=/tmp/lyk-p1", "stop"]);
  expect(joined.command).toBe("stop");
  expect(joined.dataDir).toBe("/tmp/lyk-p1");
  expect(readDaemonConfig({}, ["--no-browser", "serve"]).command).toBe("serve");
});

it("still reads the rest of the command line after a command", () => {
  const config = readDaemonConfig({}, ["serve", "--lab", "https://lab.uni.edu", "--detached"]);
  expect(config.lab).toBe("https://lab.uni.edu");
  expect(config.detached).toBe(true);
});

it("keeps its state where it is told to", () => {
  expect(readDaemonConfig({}, ["status", "--data-dir", "/tmp/somewhere"]).dataDir).toBe("/tmp/somewhere");
  expect(readDaemonConfig({ LYKEION_DAEMON_DATA_DIR: "/tmp/elsewhere" }, []).dataDir).toBe("/tmp/elsewhere");
  expect(
    readDaemonConfig({ LYKEION_DAEMON_DATA_DIR: "/tmp/elsewhere" }, ["--data-dir", "/tmp/somewhere"]).dataDir,
  ).toBe("/tmp/somewhere");
});

it("falls back to a platform-conventional place for its state", () => {
  expect(readDaemonConfig({}, []).dataDir).not.toBe("");
});

it("defaults the work directory to the data directory", () => {
  expect(readDaemonConfig({}, ["--data-dir", "/tmp/lyk-p1"]).workDir).toBe("/tmp/lyk-p1");
});

it("takes the work directory from a flag, independent of the data directory", () => {
  const config = readDaemonConfig({}, ["--data-dir", "/tmp/lyk-state", "--work-dir", "/tmp/lyk-work"]);
  expect(config.dataDir).toBe("/tmp/lyk-state");
  expect(config.workDir).toBe("/tmp/lyk-work");
});

it("takes the work directory from the environment when no flag is given", () => {
  expect(readDaemonConfig({ LYKEION_DAEMON_WORK_DIR: "/tmp/lyk-work" }, []).workDir).toBe("/tmp/lyk-work");
});

it("lets a work-dir flag beat the environment", () => {
  const config = readDaemonConfig(
    { LYKEION_DAEMON_WORK_DIR: "/tmp/env-work" },
    ["--work-dir", "/tmp/flag-work"],
  );
  expect(config.workDir).toBe("/tmp/flag-work");
});

it("treats an empty work-dir environment value as unset", () => {
  const config = readDaemonConfig({ LYKEION_DAEMON_WORK_DIR: "", LYKEION_DAEMON_DATA_DIR: "/tmp/lyk-p1" }, []);
  expect(config.workDir).toBe("/tmp/lyk-p1");
});

it("refuses --work-dir with no value the same way --data-dir does", () => {
  expect(() => readDaemonConfig({}, ["--work-dir"])).toThrow(/--work-dir needs a value/);
});
