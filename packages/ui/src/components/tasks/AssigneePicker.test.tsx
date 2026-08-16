import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Assignee } from "@lykeion/api";
import { createInMemoryApi } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { AssigneePicker } from "./AssigneePicker";

afterEach(cleanup);

function mount(value: Assignee[], onChange = vi.fn()) {
  const api = createInMemoryApi();
  render(
    <ApiProvider api={api}>
      <AssigneePicker value={value} onChange={onChange} />
    </ApiProvider>,
  );
  return onChange;
}

/**
 * Puts the picker inside an ancestor that clips its overflow and scrolls —
 * the shape of both dialogs it is mounted in.
 */
function mountInClippingBox(onChange = vi.fn()) {
  const api = createInMemoryApi();
  render(
    <ApiProvider api={api}>
      <div data-testid="clip" style={{ overflow: "hidden", height: "40px" }}>
        <AssigneePicker value={[]} onChange={onChange} />
      </div>
    </ApiProvider>,
  );
  return { onChange, clip: () => screen.getByTestId("clip") };
}

/** Gives the trigger a place in the viewport, which jsdom does not lay out. */
function placeTrigger(top: number): HTMLElement {
  const trigger = screen.getByRole("button", { name: /assignees/i });
  trigger.getBoundingClientRect = () => new DOMRect(120, top, 80, 24);
  return trigger;
}

describe("AssigneePicker", () => {
  it("offers members and experts in separate groups", async () => {
    mount([]);
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));
    expect(await screen.findByText("People")).toBeInTheDocument();
    expect(screen.getByText("Experts")).toBeInTheDocument();
  });

  it("adds a person", async () => {
    const onChange = mount([]);
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Amara" }));
    expect(onChange).toHaveBeenCalledWith([
      { kind: "user", userId: "u_amara" },
    ]);
  });

  it("removes an assignee that is already on", async () => {
    const onChange = mount([{ kind: "user", userId: "u_amara" }]);
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Amara" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("does not offer an offboarded member", async () => {
    const api = createInMemoryApi();
    await api.removeMember("u_amara");
    render(
      <ApiProvider api={api}>
        <AssigneePicker value={[]} onChange={vi.fn()} />
      </ApiProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));
    await screen.findByText("Experts");
    expect(screen.queryByRole("option", { name: "Amara" })).toBeNull();
  });

  it("reads the roster from the shared directory, not a fetch of its own", async () => {
    const api = createInMemoryApi();
    const spy = vi.spyOn(api, "listMembers");
    render(
      <ApiProvider api={api}>
        <AssigneePicker value={[]} onChange={vi.fn()} />
        <AssigneePicker value={[]} onChange={vi.fn()} />
      </ApiProvider>,
    );
    const [first] = screen.getAllByRole("button", { name: /assignees/i });
    await userEvent.click(first);
    expect(await screen.findByRole("option", { name: "Amara" })).toBeInTheDocument();
    // One read for the provider's directory; two pickers add nothing.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shows an empty Experts group when the expert read fails", async () => {
    const api = createInMemoryApi();
    vi.spyOn(api, "listAgents").mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ApiProvider api={api}>
        <AssigneePicker value={[]} onChange={vi.fn()} />
      </ApiProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));

    // People still render; the Experts group is present and empty, and the
    // rejection was reported rather than left unhandled.
    expect(await screen.findByRole("option", { name: "Amara" })).toBeInTheDocument();
    expect(screen.getByText("Experts")).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Statistician" }),
    ).toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("closes the popover on outside click, but only while open", async () => {
    mount([]);
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);

    await userEvent.click(outside);
    expect(screen.queryByRole("listbox")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));
    expect(await screen.findByText("People")).toBeInTheDocument();

    await userEvent.click(outside);
    expect(screen.queryByRole("listbox")).toBeNull();

    document.body.removeChild(outside);
  });

  it("offers every option from inside an ancestor that clips its overflow", async () => {
    const { onChange } = mountInClippingBox();
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));

    // Out of flow and resolved against the viewport, so no ancestor's clip
    // reaches it. In flow the list is cut off at the container's edge and
    // only the first option can be picked.
    const listbox = await screen.findByRole("listbox");
    expect(listbox.style.position).toBe("fixed");

    // The whole roster, not just whatever happens to fall inside the box:
    // the second person, and an agent from the group below them.
    await userEvent.click(screen.getByRole("option", { name: "Amara" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "user", userId: "u_amara" },
    ]);
    await userEvent.click(screen.getByRole("option", { name: "Lit-scout" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "agent", name: "lit-scout" },
    ]);
  });

  it("anchors the popover under the trigger's place in the viewport", async () => {
    mount([]);
    await userEvent.click(placeTrigger(300));

    const listbox = await screen.findByRole("listbox");
    expect(listbox.style.left).toBe("120px");
    expect(listbox.style.top).toBe("328px");
  });

  it("re-anchors when a scrolling ancestor moves the trigger", async () => {
    const { clip } = mountInClippingBox();
    const trigger = placeTrigger(300);
    await userEvent.click(trigger);

    const listbox = await screen.findByRole("listbox");
    expect(listbox.style.top).toBe("328px");

    trigger.getBoundingClientRect = () => new DOMRect(120, 210, 80, 24);
    fireEvent.scroll(clip());
    expect(listbox.style.top).toBe("238px");
  });

  it("anchors above the trigger when the popover would not fit below", async () => {
    const height = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(200);
    mount([]);
    // 724 + 200 runs past jsdom's 768px viewport, and a fixed box cannot be
    // scrolled into view, so the list goes above instead.
    await userEvent.click(placeTrigger(700));

    const listbox = await screen.findByRole("listbox");
    expect(listbox.style.top).toBe("496px");
    height.mockRestore();
  });

  it("keys agents and members into separate namespaces", async () => {
    const onChange = mount([]);
    await userEvent.click(screen.getByRole("button", { name: /assignees/i }));
    // "Statistician" (agent) must render even though it shares no identity
    // with any member — a distinct namespace, not a name collision check.
    const agentOption = await screen.findByRole("option", {
      name: "Statistician",
    });
    await userEvent.click(agentOption);
    expect(onChange).toHaveBeenCalledWith([
      { kind: "agent", name: "statistician" },
    ]);
  });
});
