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
  activeLanguage: Language | null;
  onLanguageChange(language: Language): void;
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

  const languageControl =
    languages.length > 1 ? (
      <div
        className="nbp-langs"
        role="radiogroup"
        aria-label="Kernel language"
        data-testid="notebook-langs"
      >
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
      <span className="nbp-session-label">{sessionLabel}</span>
      {languageControl}
    </div>
  );
}
