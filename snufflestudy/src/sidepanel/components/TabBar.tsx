import { ButtonTab } from "./ui/ButtonTab";

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

// design-specs/frames/nagivation-bar.json (component 173:1609) - composes the button-tab
// primitive built in Phase 1.
export function TabBar({ active, onSelect }: TabBarProps) {
  return (
    <div className="sp-tabbar" role="tablist">
      {TABS.map(({ id, label }) => (
        <ButtonTab
          key={id}
          id={`sp-tab-${id}`}
          aria-controls="sp-tabpanel"
          selected={id === active}
          onClick={() => onSelect(id)}
        >
          {label}
        </ButtonTab>
      ))}
    </div>
  );
}
