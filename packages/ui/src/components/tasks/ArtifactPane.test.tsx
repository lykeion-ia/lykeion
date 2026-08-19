import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import {
  createInMemoryApi,
  type ArtifactBlob,
  type LykeionApi,
} from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { ArtifactPane } from "./ArtifactPane";

afterEach(cleanup);

it("fetches an artifact and dispatches it to a content-type viewer", async () => {
  const blob: ArtifactBlob = {
    path: "notes/summary.txt",
    contentType: "text/plain",
    encoding: "utf8",
    data: "the reconciled kinome table is ready",
  };
  const api: LykeionApi = {
    ...createInMemoryApi(),
    readArtifact: async () => blob,
  };

  render(
    <ApiProvider api={api}>
      <ArtifactPane researchId="st_1" path="notes/summary.txt" />
    </ApiProvider>,
  );

  // The fetched blob reaches the text viewer (via ArtifactViewer's dispatch).
  await waitFor(() =>
    expect(
      screen.getByText("the reconciled kinome table is ready"),
    ).toBeInTheDocument(),
  );
  // The header names the artifact by its basename.
  expect(screen.getByTestId("artifact-pane")).toHaveTextContent("summary.txt");
});

it("surfaces a read error instead of a blank pane", async () => {
  const api: LykeionApi = {
    ...createInMemoryApi(),
    readArtifact: async () => {
      throw new Error("no such artifact");
    },
  };
  render(
    <ApiProvider api={api}>
      <ArtifactPane researchId="st_1" path="missing.csv" />
    </ApiProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText(/no such artifact/i)).toBeInTheDocument(),
  );
});
