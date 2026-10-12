import type { KeyboardEvent } from "react";

export type WorkspaceTab = "decision" | "claims" | "debate" | "evidence";

const tabs: ReadonlyArray<{ id: WorkspaceTab; label: string }> = [
  { id: "decision", label: "Decision" },
  { id: "claims", label: "Claims" },
  { id: "debate", label: "Debate" },
  { id: "evidence", label: "Evidence" },
];

export function WorkspaceTabs({
  active,
  onChange,
}: {
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + offset + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  }

  return (
    <div className="workspace-tabs" role="tablist" aria-label="Analysis views">
      {tabs.map((tab, index) => (
        <button
          id={`tab-${tab.id}`}
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`view-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
