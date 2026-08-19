import { useState } from "react";
import type { Invite, Machine, Member, Research, Task } from "@lykeion/api";
import {
  useApi,
  useDataVersion,
  useInvalidateData,
} from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { PlusIcon } from "../components/icons";
import { ColleaguesTable } from "../components/colleagues/ColleaguesTable";
import { InviteModal } from "../components/colleagues/InviteModal";
import {
  deriveColleagueRows,
  type ColleagueRow,
} from "../components/colleagues/colleague-meta";

interface ColleaguesData {
  members: Member[];
  tasks: Task[];
  researches: Research[];
  machines: Machine[];
  invites: Invite[];
  meId: string;
}

const EMPTY: ColleaguesData = {
  members: [],
  tasks: [],
  researches: [],
  machines: [],
  invites: [],
  meId: "",
};

/** Colleagues (#/colleagues) — the people in this lab, and what they are on. */
export function ColleaguesScreen() {
  const api = useApi();
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const q = usePromise<ColleaguesData>(async () => {
    const [members, tasks, researches, machines, me] = await Promise.all([
      api.listMembers(),
      // Done tasks included: the bar beside "N open" is the completed
      // proportion of everything assigned, so the done ones are the numerator.
      api.listTasks({ includeDone: true }),
      api.listResearches(),
      api.listMachines(),
      api.currentUser(),
    ]);
    // Standing has to be read before the invite list can be asked for, so
    // this one waits rather than joining the batch above. Asking as a member
    // would only ever come back refused — the server keeps it owner-only —
    // so there is nothing to gain by making the call.
    const mine = members.find((m) => m.user.id === me.id);
    const invites =
      mine?.role === "owner" ? await api.listInvites() : [];
    return { members, tasks, researches, machines, invites, meId: me.id };
  }, [api, version]);

  const data = q.data ?? EMPTY;
  const rows = deriveColleagueRows(
    data.members,
    data.tasks,
    data.researches,
    data.machines,
  );

  const role =
    data.members.find((m) => m.user.id === data.meId)?.role ?? "member";
  const owners = data.members.filter(
    (m) => m.role === "owner" && m.removedTs === undefined,
  );

  /**
   * Whether to offer Remove on a row. Beyond the obvious — a member cannot
   * offboard anyone, and somebody already gone cannot go again — this keeps
   * back the two the lab would refuse: nobody offboards themselves from a
   * surface with no way back, and the last owner cannot leave a lab with no
   * owner in it.
   */
  const canRemove = (row: ColleagueRow): boolean => {
    if (role !== "owner" || row.member.removedTs !== undefined) return false;
    if (row.member.user.id === data.meId) return false;
    return row.member.role !== "owner" || owners.length > 1;
  };

  const removeMember = async (row: ColleagueRow) => {
    setActionError(null);
    try {
      await api.removeMember(row.member.user.id);
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const mintInvite = async () => {
    setActionError(null);
    try {
      await api.createInvite("member");
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const withdrawInvite = async (code: string) => {
    setActionError(null);
    try {
      await api.revokeInvite(code);
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Colleagues"
        action={
          role === "owner" ? (
            <PrimaryButton
              onClick={() => {
                // A remove that failed a moment ago is not this dialog's
                // news; carrying it in would report it against the wrong
                // control.
                setActionError(null);
                setOpen(true);
              }}
            >
              <PlusIcon width={14} height={14} />
              Invite
            </PrimaryButton>
          ) : undefined
        }
      />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      {/* Remove is the only one of these actions taken from the screen
          itself; a mint or withdraw fails inside the dialog, which covers
          this, so it reports its own. */}
      {actionError && !open && (
        <p className="px-5 text-sub text-danger">{actionError}</p>
      )}
      <ColleaguesTable
        rows={rows}
        canRemove={canRemove}
        onRemove={(row) => void removeMember(row)}
      />
      {open && (
        <InviteModal
          invites={data.invites}
          error={actionError}
          onMint={mintInvite}
          onWithdraw={withdrawInvite}
          onClose={() => {
            // The dialog reported this failure itself; closing it dismisses
            // the failure with it. Left in state, it would surface on the
            // screen's own line, which speaks for Remove.
            setActionError(null);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export default ColleaguesScreen;
