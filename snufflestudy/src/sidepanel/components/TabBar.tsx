import ButtonTab from "../ui/ButtonTab";
import styles from "../styles/frontend-backup/components/layout/NavigationBar.module.css";

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

// v4.2 Task 2: re-skinned as NavigationBar.tsx's markup (ButtonTab per tab), but
// NavigationBar.tsx's own <Link>/react-router-dom usage is dropped - this app has no routing -
// in favor of the onClick={() => onSelect(id)} pattern this component already used. The
// role="tablist"/role="tab"/aria-selected/aria-controls accessibility attributes already on the
// pre-v4.2 markup are preserved here on top of ButtonTab's own (accessibility-free) markup, per
// the plan's Global Constraints.
export function TabBar({ active, onSelect }: TabBarProps) {
  return (
    <div className={styles.navigationBar} role="tablist">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          id={`sp-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={id === active}
          aria-controls="sp-tabpanel"
          className={styles.tabLink}
          onClick={() => onSelect(id)}
        >
          <ButtonTab property1={id === active ? "selected" : "default"} button={label} />
        </button>
      ))}
    </div>
  );
}
