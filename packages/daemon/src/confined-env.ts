import { isolationFor, lykeionHomeFor } from "./agent-registry";

/**
 * Everything a confined process is given, and nothing else.
 *
 * An allowlist rather than a denylist, and the difference is the whole point.
 * `ambientAuthEnv` named the two variables that were known to authenticate
 * Claude Code, which answered for Claude Code and for nothing else: eleven
 * more rows are arriving, each with its own, and a list of what is dangerous
 * is only ever as current as the last time somebody thought about it. A list
 * of what is *needed* does not have that property — a credential nobody has
 * heard of is dropped for the same reason `AWS_SECRET_ACCESS_KEY` is.
 *
 * The proxy and certificate entries are here because a researcher behind a
 * corporate proxy has a CLI that cannot reach its vendor without them, and a
 * run that silently fails to authenticate on a managed network is
 * indistinguishable from a broken row.
 *
 * `HOME` is here, and that is a residual. A CLI ignoring its `homeEnv` and
 * reading `$HOME` directly would find the researcher's own installation —
 * which is exactly what rung 5 catches, by asking from a home created empty
 * a moment ago. Redirecting `HOME` itself has its own failure modes (a shell
 * that cannot find its profile, a tool that writes a cache where nothing
 * expects one) and is future work rather than something to do quietly here.
 */
export const CONFINED_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The environment for a confined run of `agent`.
 *
 * `extra` is what a call site set deliberately — a scratch `TMPDIR`, a config
 * path — and is applied last so it wins. That is the rule this module exists
 * to make true: a variable reaches a confined process because a named line of
 * Lykeion put it there, never because it happened to be in the environment
 * this daemon was started from.
 */
export function confinedEnv(
  agent: string | undefined,
  extra: Record<string, string> = {},
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CONFINED_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  const isolation = agent === undefined ? undefined : isolationFor(agent);
  if (isolation !== undefined && agent !== undefined)
    env[isolation.homeEnv] = lykeionHomeFor(agent);
  return { ...env, ...extra };
}
