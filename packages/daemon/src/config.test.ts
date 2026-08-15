import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readDaemonConfig } from "./config";

it("defaults to no lab and a browser", () => {
  const config = readDaemonConfig({}, []);
  expect(config.lab).toBeUndefined();
  expect(config.openBrowser).toBe(true);
});

it("binds a port somebody can forward without looking it up first", () => {
  expect(readDaemonConfig({}, []).port).toBe(1421);
});

it("still takes zero when a caller wants whatever is free", () => {
  expect(readDaemonConfig({}, ["--port", "0"]).port).toBe(0);
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

it("takes the commands that mint and read links", () => {
  for (const word of ["open", "url", "logs"])
    expect(readDaemonConfig({}, [word]).command).toBe(word);
});

it("refuses a command it does not have, saying which it does", () => {
  expect(() => readDaemonConfig({}, ["restart"])).toThrow(
    /restart is not a command.*serve, status, stop, open, url, logs or pair.*--help/,
  );
});

it("takes a code carried back by hand", () => {
  const config = readDaemonConfig({}, ["pair", "--code", "one-time-code"]);
  expect(config.command).toBe("pair");
  expect(config.code).toBe("one-time-code");
});

it("takes the code either way round, the way every other value flag reads", () => {
  expect(readDaemonConfig({}, ["pair", "--code=one-time-code"]).code).toBe("one-time-code");
});

it("refuses pair with no code, rather than asking a daemon to redeem nothing", () => {
  // The command exists only to carry one value. Without it there is nothing
  // to do, and a daemon told to redeem the empty string would spend a round
  // trip to the lab finding that out.
  expect(() => readDaemonConfig({}, ["pair"])).toThrow(/pair needs the code/i);
});

it("refuses a code given to something that is not pair", () => {
  // Not pedantry: `serve --code` is somebody who meant `pair --code` and got
  // a daemon that ignored the code and started pairing from scratch instead.
  expect(() => readDaemonConfig({}, ["status", "--code", "one-time-code"])).toThrow(
    /--code.*pair/i,
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

it("defaults Task workspaces to the researcher's Documents folder", () => {
  expect(readDaemonConfig({}, ["--data-dir", "/tmp/lyk-p1"]).workDir).toBe(
    join(homedir(), "Documents", "Lykeion"),
  );
});

it("refuses a work directory inside the data directory, naming the conflict", () => {
  expect(() =>
    readDaemonConfig({}, ["--data-dir", "/tmp/lyk-p1", "--work-dir", "/tmp/lyk-p1/work"]),
  ).toThrow(/inside --data-dir/);
  expect(() =>
    readDaemonConfig({}, ["--data-dir", "/tmp/lyk-p1", "--work-dir", "/tmp/lyk-p1"]),
  ).toThrow(/inside --data-dir/);
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
  expect(config.workDir).toBe(join(homedir(), "Documents", "Lykeion"));
});

it("refuses --work-dir with no value the same way --data-dir does", () => {
  expect(() => readDaemonConfig({}, ["--work-dir"])).toThrow(/--work-dir needs a value/);
});

it("takes --lab-only and starts no machine", () => {
  expect(readDaemonConfig({}, ["--lab-only"]).labOnly).toBe(true);
});

it("leaves --lab-only off when nobody asks for it", () => {
  expect(readDaemonConfig({}, []).labOnly).toBe(false);
});

it("refuses --lab-only together with a lab to join, which cannot both be meant", () => {
  expect(() => readDaemonConfig({}, ["--lab-only", "--lab", "https://lab.example.edu"])).toThrow(
    /--lab-only serves a lab here/,
  );
});

it("lets --lab-only override a standing LYKEION_LAB rather than refusing it", () => {
  const config = readDaemonConfig({ LYKEION_LAB: "https://lab.example.edu" }, ["--lab-only"]);
  expect(config.labOnly).toBe(true);
});

it("refuses --lab-only together with --detached, which would hand back nothing to find", () => {
  expect(() => readDaemonConfig({}, ["--lab-only", "--detached"])).toThrow(
    /--lab-only serves a lab, which is not something --detached can hand back/,
  );
});

it("refuses --lab-only a value, since it is either given or it is not", () => {
  expect(() => readDaemonConfig({}, ["--lab-only=yes"])).toThrow(/--lab-only does not take a value/);
});
