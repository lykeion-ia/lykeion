import type { Language } from "@lykeion/api";
import {
  contextLabel,
  kernelFor,
  languageLabel,
  type NotebookContext,
} from "./notebook-model";

export function NotebookAxis({
  contexts,
  activeContext,
  onContextChange,
  languages,
  activeLanguage,
  onLanguageChange,
  sessionLabel,
}: {
  contexts: NotebookContext[];
  activeContext: string | null;
  onContextChange(name: string): void;
  languages: Language[];
  /** The language being read, or `null` for all of them. */
  activeLanguage: Language | null;
  onLanguageChange(language: Language | null): void;
  sessionLabel: string;
}): React.JSX.Element | null {
  if (contexts.length === 0) return null;

  const contextControl =
    contexts.length === 1 ? (
      <span className="nbp-context-static">{contextLabel(contexts[0].name)}</span>
    ) : (
      <div className="nbp-ctxtabs" role="tablist" aria-label="Kernel context">
        {contexts.map((context) => {
          const kernel = kernelFor(context, null);
          const active = context.name === activeContext;
          return (
            <button
              key={context.name}
              type="button"
              className={`nbp-ctxtab${active ? " is-active" : ""}`}
              role="tab"
              aria-selected={active}
              onClick={() => onContextChange(context.name)}
            >
              {kernel && (
                <span
                  className={`nbp-ctxtab-dot nbp-ctxtab-dot--${kernel.state}`}
                  aria-hidden="true"
                />
              )}
              <span className="nbp-ctxtab-label">{contextLabel(context.name)}</span>
            </button>
          );
        })}
      </div>
    );

  /* Which language the ledger is showing, and so which kernel the status line
     below it describes. `All` leads and is the resting state: a context that
     ran two languages ran them against one problem, and the order the work
     happened in is what a record of it is for — so the interleaved list is
     what the panel opens on, and a single language is something the researcher
     asks for. Offered only where there is more than one, because a lone
     language is not a choice. */
  const languageControl =
    languages.length > 1 ? (
      <div
        className="nbp-langs"
        role="radiogroup"
        aria-label="Cell language"
        data-testid="notebook-langs"
      >
        <button
          type="button"
          className={`nbp-lang${activeLanguage === null ? " is-active" : ""}`}
          role="radio"
          aria-checked={activeLanguage === null}
          onClick={() => onLanguageChange(null)}
        >
          All
        </button>
        {languages.map((language) => (
          <button
            key={language}
            type="button"
            className={`nbp-lang${language === activeLanguage ? " is-active" : ""}`}
            role="radio"
            aria-checked={language === activeLanguage}
            onClick={() => onLanguageChange(language)}
          >
            {languageLabel(language)}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="nbp-axis">
      {contextControl}
      {/* Which notebook this is. Load-bearing now that the pane can show a
          notebook belonging to a Task other than the one being read: it is the
          only thing on the panel that says whose ledger is on screen. */}
      <span className="nbp-session-label" data-testid="notebook-session-label">
        {sessionLabel}
      </span>
      {languageControl}
    </div>
  );
}
