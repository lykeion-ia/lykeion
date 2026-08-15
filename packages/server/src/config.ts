import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything the server reads about its environment, resolved once at
 * startup. Every field has a default, so a lab that runs the server with no
 * configuration at all gets a working single-machine install.
 */
export interface ServerConfig {
  host: string;
  port: number;
  /** Where the database file lives. */
  dataDir: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** How many change entries to keep. A client whose cursor falls outside
   *  this window is told to resynchronise rather than served a gap. */
  changeLogRetention: number;
  /** The built UI to serve. */
  uiDir: string;
}

/**
 * An unset environment variable and one set to the empty string mean the
 * same thing here: absent. A `.env` file or a systemd unit blanks a setting
 * by assigning it nothing, and `??` alone treats that empty string as a
 * real value — which for `dataDir` resolves the database against whatever
 * the process's working directory happens to be, silently.
 */
function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

/** The platform's conventional home for application data. */
function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Lykeion");
  if (process.platform === "win32")
    return join(nonEmpty(env.APPDATA) ?? join(homedir(), "AppData", "Roaming"), "Lykeion");
  return join(
    nonEmpty(env.XDG_DATA_HOME) ?? join(homedir(), ".local", "share"),
    "lykeion",
  );
}

/**
 * `0` is a port here, and the one the daemon asks for: a lab started behind
 * a front door is reached only through it, and taking whatever is free is
 * what keeps two labs on one computer from racing for a number neither of
 * them needs. The startup line then says which port it actually took, which
 * is how the daemon learns where to forward.
 *
 * Which is why the caller passes this through `nonEmpty` first, as every
 * other setting here already was. A unit file or `.env` that blanks a
 * setting assigns it the empty string, `Number("")` is `0`, and without that
 * the one spelling of "I meant to say nothing" would have become the one
 * spelling of "put this lab wherever you like" — a lab that quietly leaves
 * 1421 and prints where it went.
 */
function readPort(raw: string | undefined): number {
  if (raw === undefined) return 1421;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`LYKEION_PORT must be a port number, not ${raw}`);
  return port;
}

function readRetention(raw: string | undefined): number {
  if (raw === undefined) return 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`LYKEION_CHANGE_RETENTION must be a positive whole number, not ${raw}`);
  return n;
}

/**
 * The built UI, found relative to this module rather than to the working
 * directory. A path built from `process.cwd()` resolves differently
 * depending on where the operator happened to run the command from, and
 * the failure is an ENOENT at startup that names a directory nobody meant.
 * This holds whether the module is running from source or from the bundle.
 */
function defaultUiDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: nonEmpty(env.LYKEION_HOST) ?? "127.0.0.1",
    port: readPort(nonEmpty(env.LYKEION_PORT)),
    dataDir: nonEmpty(env.LYKEION_DATA_DIR) ?? defaultDataDir(env),
    tlsCertPath: nonEmpty(env.LYKEION_TLS_CERT),
    tlsKeyPath: nonEmpty(env.LYKEION_TLS_KEY),
    changeLogRetention: readRetention(env.LYKEION_CHANGE_RETENTION),
    uiDir: nonEmpty(env.LYKEION_UI_DIR) ?? defaultUiDir(),
  };
}

/**
 * Addresses that never leave the machine. `0.0.0.0` and `::` are absent
 * deliberately: they mean every interface, which is the case this rule
 * exists to catch.
 */
function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Refuse to serve passwords in cleartext across a network. A lab that can
 * bind the department's interface over plain HTTP is a lab that will, so the
 * only two configurations that start are loopback, and TLS.
 */
/**
 * Serving the data directory would publish the database — password hashes
 * and live session tokens — to anyone who can reach the port, because
 * static files are served with no authentication at all. It can only happen
 * by misconfiguration, and it is cheap to refuse.
 */
export function assertServable(cfg: ServerConfig): void {
  const ui = resolve(cfg.uiDir);
  const data = resolve(cfg.dataDir);
  // Only one direction is dangerous. A UI directory *inside* the data
  // directory is fine — the database sits in the parent, which no served
  // path can reach. A data directory inside the UI directory publishes it.
  if (ui === data || data.startsWith(ui + sep))
    throw new Error(
      `refusing to serve ${cfg.uiDir} as the UI: the data directory ` +
        `${cfg.dataDir} sits inside it, so the database — password hashes ` +
        `and live session tokens — would be downloadable by anyone. Point ` +
        `LYKEION_UI_DIR and LYKEION_DATA_DIR at separate places.`,
    );
}

export function assertBindable(cfg: ServerConfig): void {
  if (isLoopback(cfg.host)) return;
  const missing: string[] = [];
  if (!cfg.tlsCertPath) missing.push("LYKEION_TLS_CERT");
  if (!cfg.tlsKeyPath) missing.push("LYKEION_TLS_KEY");
  if (missing.length === 0) return;
  throw new Error(
    `refusing to bind ${cfg.host} without TLS: it is not a loopback address, ` +
      `and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
      `Either bind 127.0.0.1, or configure a certificate and key.`,
  );
}
