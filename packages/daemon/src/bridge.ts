import { connect, type Socket } from "node:net";

/**
 * The relay an agent's own program reaches this machine's kernels through.
 *
 * The agent's CLI starts this and speaks the Model Context Protocol to it
 * over a pipe. It carries those bytes, unread and unchanged, to the unix
 * socket this machine bound for the Task, where the tools themselves are
 * published. It is a relay and nothing else: it publishes no tool, holds no
 * state, and has no opinion about any message that crosses it.
 *
 * The one thing it contributes is the first line, which says which kernel
 * this conversation is for. That line is built from the arguments this
 * machine wrote when it named the relay to the agent — so which kernel an
 * agent reaches is decided here, on this side, and no message the agent sends
 * afterwards carries a kernel at all.
 *
 * It ships inside the daemon's own program because it is the daemon's half of
 * that arrangement: a relay written in the same place that decided the
 * boundary, rather than a second program a machine would have to install,
 * find and keep in step.
 */

/** Which kernel a relay is for, as this machine wrote it. */
export interface BridgeArguments {
  socket: string;
  session: string;
  task: string;
  name: string;
  /** Which agent is running the cells, so a cell says who ran it. */
  agent: string;
  /** What makes this relay the one that session's kernels were given to. One
   *  socket answers for every session of a Task, so naming a session is not
   *  by itself a claim to it — holding what this machine minted for that
   *  session is. */
  token: string;
}

const REQUIRED = ["--socket", "--session", "--task", "--name", "--agent", "--token"] as const;

/**
 * The relay's own command line. Every argument is required and none has a
 * default: a relay that guessed at the kernel it was for would reach one
 * nobody named, and there is no kernel it would be right to fall back to.
 */
export function readBridgeArguments(argv: string[]): BridgeArguments {
  const given = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const sign = arg.indexOf("=");
    const flag = sign === -1 ? arg : arg.slice(0, sign);
    if (!(REQUIRED as readonly string[]).includes(flag))
      throw new Error(`${flag} is not something this relay takes`);
    const value = sign === -1 ? argv[++index] : arg.slice(sign + 1);
    if (value === undefined || value === "") throw new Error(`${flag} needs a value`);
    given.set(flag, value);
  }
  for (const flag of REQUIRED) if (!given.has(flag)) throw new Error(`this relay needs ${flag}`);
  return {
    socket: given.get("--socket")!,
    session: given.get("--session")!,
    task: given.get("--task")!,
    name: given.get("--name")!,
    agent: given.get("--agent")!,
    token: given.get("--token")!,
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one relay until either end of it goes, and answers with the status
 * this process should exit on.
 *
 * A relay that cannot reach the socket says so on its error stream and ends,
 * rather than standing there answering nothing: the agent's own program reads
 * that as a tool server that failed to start, which is what happened, and
 * says so where a researcher can see it.
 */
export function runBridge(argv: string[]): Promise<number> {
  let named: BridgeArguments;
  try {
    named = readBridgeArguments(argv);
  } catch (err) {
    process.stderr.write(`${reason(err)}\n`);
    return Promise.resolve(2);
  }

  return new Promise<number>((resolve) => {
    const socket: Socket = connect(named.socket);
    socket.setEncoding("utf8");
    // Everything read before this end knows whether it was let in. The host
    // answers the opening line with one of its own, so a refusal is a message
    // rather than a socket that closes for no stated reason.
    let carry = "";
    let relaying = false;
    let done = false;
    const end = (status: number, why?: string): void => {
      if (done) return;
      done = true;
      if (why !== undefined) process.stderr.write(`${why}\n`);
      socket.destroy();
      resolve(status);
    };

    socket.on("error", (err) =>
      end(1, `this machine's kernels could not be reached over ${named.socket}: ${reason(err)}`),
    );
    socket.on("close", () => end(relaying ? 0 : 1, relaying ? undefined : "this machine's kernels stopped answering"));

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          session: named.session,
          task: named.task,
          name: named.name,
          agent: named.agent,
          token: named.token,
        })}\n`,
      );
    });

    const opening = (chunk: string): void => {
      carry += chunk;
      const newline = carry.indexOf("\n");
      if (newline === -1) return;
      const line = carry.slice(0, newline);
      const rest = carry.slice(newline + 1);
      let answer: { error?: { message?: string } };
      try {
        answer = JSON.parse(line) as { error?: { message?: string } };
      } catch {
        return end(1, `this machine's kernels answered with something this relay cannot read: ${line}`);
      }
      if (answer.error) return end(1, answer.error.message ?? "this relay was not let in");
      // Both switched in one turn, so nothing this socket has already
      // delivered can arrive between the listener going and the pipe
      // arriving. Whatever came after the opening line in the same chunk is
      // written on before either is attached, because it is already read and
      // no pipe will ever deliver it again.
      relaying = true;
      socket.off("data", opening);
      if (rest.length > 0) process.stdout.write(rest);
      socket.pipe(process.stdout);
      process.stdin.pipe(socket);
    };
    socket.on("data", opening);
  });
}
