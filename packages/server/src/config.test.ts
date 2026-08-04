import { describe, expect, it } from "vitest";
import { assertBindable, readConfig } from "./config";

describe("readConfig", () => {
  it("defaults to loopback on 1421 with no environment at all", () => {
    const cfg = readConfig({});
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(1421);
    expect(cfg.dataDir).not.toBe("");
  });

  it("takes the port as a number, not the string it arrives as", () => {
    expect(readConfig({ LYKEION_PORT: "8443" }).port).toBe(8443);
  });

  it("rejects a port that is not a number, rather than listening on NaN", () => {
    expect(() => readConfig({ LYKEION_PORT: "https" })).toThrow(
      /LYKEION_PORT/,
    );
  });

  it("rejects a port above 65535, which no process can bind", () => {
    expect(() => readConfig({ LYKEION_PORT: "70000" })).toThrow(/LYKEION_PORT/);
  });

  it("defaults change-log retention to a window wide enough to matter", () => {
    // Pinned so the default can't drift to something that discards history
    // on the first prune without a single test noticing.
    expect(readConfig({}).changeLogRetention).toBe(1000);
  });

  it("treats an empty-string environment variable as unset, not as the value", () => {
    // A `.env` file or a systemd unit blanks a setting by assigning it
    // nothing; `??` alone would take that empty string as a real dataDir
    // and resolve the database against the working directory instead.
    const cfg = readConfig({ LYKEION_HOST: "", LYKEION_DATA_DIR: "" });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.dataDir).not.toBe("");
  });
});

describe("assertBindable", () => {
  const base = readConfig({});

  it("allows loopback without certificates", () => {
    expect(() => assertBindable({ ...base, host: "127.0.0.1" })).not.toThrow();
    expect(() => assertBindable({ ...base, host: "::1" })).not.toThrow();
    expect(() => assertBindable({ ...base, host: "localhost" })).not.toThrow();
  });

  it("refuses a routable address with no certificate, naming both", () => {
    // The message has to carry the address and the missing piece: an
    // operator reading a startup failure needs to know which of the two
    // to change.
    expect(() => assertBindable({ ...base, host: "192.168.1.40" })).toThrow(
      /192\.168\.1\.40.*LYKEION_TLS_CERT/s,
    );
  });

  it("refuses 0.0.0.0, which is every interface rather than the local one", () => {
    expect(() => assertBindable({ ...base, host: "0.0.0.0" })).toThrow(
      /0\.0\.0\.0/,
    );
  });

  it("allows a routable address once a certificate and key are configured", () => {
    expect(() =>
      assertBindable({
        ...base,
        host: "192.168.1.40",
        tlsCertPath: "/etc/lykeion/cert.pem",
        tlsKeyPath: "/etc/lykeion/key.pem",
      }),
    ).not.toThrow();
  });

  it("refuses a certificate with no key — half a TLS setup is not one", () => {
    expect(() =>
      assertBindable({
        ...base,
        host: "192.168.1.40",
        tlsCertPath: "/etc/lykeion/cert.pem",
      }),
    ).toThrow(/LYKEION_TLS_KEY/);
  });
});
