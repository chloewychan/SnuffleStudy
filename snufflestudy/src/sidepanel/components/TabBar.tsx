export type SidePanelTab = "bunny" | "study" | "friends" | "settings";

const TABS: { id: SidePanelTab; label: string }[] = [
  { id: "bunny", label: "Bunny" },
  { id: "study", label: "Study" },
  { id: "friends", label: "Friends" },
  { id: "settings", label: "Settings" },
];

interface TabBarProps {
  active: SidePanelTab;
  onSelect: (tab: SidePanelTab) => void;
}

export function TabBar({ active, onSelect }: TabBarProps) {
  return (
    <div className="sp-tabbar" role="tablist">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          id={`sp-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={id === active}
          aria-controls="sp-tabpanel"
          className={`sp-tabbar__tab${id === active ? " sp-tabbar__tab--active" : ""}`}
          onClick={() => onSelect(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
