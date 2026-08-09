import { useState, type FormEvent } from "react";
import type { Skill } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { CapabilityList } from "../components/library/CapabilityList";
import { ActionMenu, type ActionMenuItem } from "../components/ui/ActionMenu";
import { primaryActionClass } from "../components/ui/PrimaryButton";
import { SettingsSectionHeader } from "../components/settings/SettingsSection";
import {
  ChatIcon,
  ChevronDownIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
  UploadIcon,
} from "../components/icons";

/**
 * Skills — reusable SKILL.md instruction packs. Rendered as the Settings ›
 * Capabilities › Skills tab (and by the `#/skills` alias, which redirects
 * there).
 *
 * Leads with `SettingsSectionHeader` rather than the section screens'
 * `ScreenHeader`, so its title sits on exactly the same baseline as Memory /
 * Compute / Network. The gutter and the scroll come from the settings pane —
 * this panel adds neither.
 */
export function SkillsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  const skills = usePromise(() => api.listSkills(), [api, nonce]);
  const [creating, setCreating] = useState(false);

  const rows = skills.data ?? [];

  // The "Add skill" dropdown: inert paths, except "Write from scratch" which
  // opens the real create form (so skill creation is preserved).
  const addMenu: ActionMenuItem[] = [
    {
      id: "chat",
      icon: ChatIcon,
      label: "Chat with Daemon",
      detail: "Describe it in a new task",
    },
    {
      id: "scratch",
      icon: PencilIcon,
      label: "Write from scratch",
      detail: "Open the skill creator",
      onSelect: () => setCreating(true),
    },
    {
      id: "upload",
      icon: UploadIcon,
      label: "Upload a skill",
      detail: "Drop a .zip or SKILL.md",
      separatorBefore: true,
    },
    {
      id: "github",
      icon: GitBranchIcon,
      label: "Import from GitHub",
      detail: "Add skills from a repo",
    },
  ];

  return (
    <div>
      <SettingsSectionHeader
        title="Skills"
        action={
          <ActionMenu
            items={addMenu}
            align="end"
            width="w-72"
            className="shrink-0"
          >
            {({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                className={primaryActionClass}
              >
                <PlusIcon width={14} height={14} />
                Add skill
                <ChevronDownIcon
                  width={14}
                  height={14}
                  className="text-white/80"
                />
              </button>
            )}
          </ActionMenu>
        }
      />

      {creating && (
        <div className="mx-auto w-full max-w-[820px]">
          <NewSkillForm
            onCancel={() => setCreating(false)}
            onCreate={async (skill) => {
              await api.createSkill(skill);
              setCreating(false);
              reload();
            }}
          />
        </div>
      )}

      {skills.error && (
        <p className="text-ui text-danger">{skills.error}</p>
      )}

      <CapabilityList
        items={rows.map((s) => ({
          name: s.name,
          detail: s.description,
          enabled: s.enabled,
        }))}
        searchPlaceholder="Search skills…"
        sectionTitle="Featured"
        sectionSubtitle="Research skills available in this workspace"
        emptyLabel="No skills yet — add one to start."
        loading={skills.loading}
        onToggle={async (item, next) => {
          await api.setSkillEnabled(item.name, next);
          reload();
        }}
      />
    </div>
  );
}

/** Inline create form (name, description, Markdown body). */
function NewSkillForm({
  onCreate,
  onCancel,
}: {
  onCreate: (skill: Skill) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        body,
      });
    } finally {
      setBusy(false);
    }
  };

  const input =
    "w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong";

  return (
    <form
      onSubmit={submit}
      className="mb-3 flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
    >
      <input
        className={input}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. gsea"
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      <input
        className={input}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What the agent should do"
        autoComplete="off"
      />
      <textarea
        className={`${input} resize-none`}
        value={body}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        placeholder="# Title&#10;&#10;Instructions the agent should follow…"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-ui text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Create skill
        </button>
      </div>
    </form>
  );
}

export default SkillsScreen;
