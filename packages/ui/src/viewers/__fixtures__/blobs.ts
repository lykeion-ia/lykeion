/**
 * Fixture artifact blobs for the viewer tests. The CSV/PNG/PDF/notebook are
 * the same seeded blobs the in-memory API serves (single source of truth via
 * `fixtureArtifacts`); the JSON and binary blobs exercise the text fallback
 * and the unsupported placeholder.
 */
import { fixtureArtifacts, type ArtifactBlob } from "@lykeion/api";

const seeded = fixtureArtifacts();

export const csvBlob = seeded["results/out.csv"];
export const pngBlob = seeded["results/fig.png"];
export const pdfBlob = seeded["results/report.pdf"];
export const ipynbBlob = seeded["results/analysis.ipynb"];

export const tsvBlob: ArtifactBlob = {
  path: "results/grid.tsv",
  contentType: "text/tab-separated-values",
  encoding: "utf8",
  data: "gene\tlog2fc\tpadj\nTP53\t1.8\t0.001\nKRAS\t-0.6\t0.04\n",
};

export const jsonBlob: ArtifactBlob = {
  path: "results/meta.json",
  contentType: "application/json",
  encoding: "utf8",
  data: '{\n  "neurons": 7,\n  "mean_tuning": 0.72\n}\n',
};

export const binaryBlob: ArtifactBlob = {
  path: "results/model.bin",
  contentType: "application/octet-stream",
  encoding: "base64",
  data: "AAECAwQFBgcICQ==",
};
