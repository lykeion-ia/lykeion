import type { Language, NotebookCell, RunningKernel } from "@lykeion/api";

export interface NotebookContext {
  name: string;
  kernels: RunningKernel[];
  cells: NotebookCell[];
}

export function buildNotebookContexts(
  kernels: RunningKernel[],
  cells: NotebookCell[],
): NotebookContext[] {
  const names = new Set<string>();
  for (const kernel of kernels) names.add(kernel.name);
  for (const cell of cells) names.add(cell.name);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      kernels: kernels.filter((kernel) => kernel.name === name),
      cells: cells.filter((cell) => cell.name === name),
    }));
}

export function contextLabel(name: string): string {
  return name === "main" ? "Main agent" : name;
}

export function languagesOf(context: NotebookContext): Language[] {
  const seen = new Set<Language>();
  for (const kernel of context.kernels) seen.add(kernel.language);
  for (const cell of context.cells) seen.add(cell.language);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function kernelFor(
  context: NotebookContext,
  language: Language | null,
): RunningKernel | undefined {
  const ordered = [...context.kernels].sort(
    (a, b) => a.language.localeCompare(b.language) || a.id.localeCompare(b.id),
  );
  if (language === null) return ordered[0];
  return ordered.find((kernel) => kernel.language === language);
}

export function languageLabel(language: Language): string {
  return language === "r" ? "R" : "Python";
}
