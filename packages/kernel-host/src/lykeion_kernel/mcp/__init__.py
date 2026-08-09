"""How an agent reaches one of this machine's kernels.

The agent's own program speaks the Model Context Protocol over a pipe to a
relay this machine started, and the relay carries those bytes to the unix
socket bound for that Task. What answers on the far end is here: an
MCP server bound, before it reads its first message, to the one kernel the
daemon named. A tool call carries what to run and never where to run it, so
there is no message an agent can send that reaches a namespace it was not
given.
"""
