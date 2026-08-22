import { useState } from "react";

// Stub data - no backend exists for bunny stats yet (confirmed during planning). Local
// component state only; nothing here is persisted or sent via sendMessage.
const STUB_METERS = [
  { label: "Happiness", percent: 85 },
  { label: "Productivity", percent: 62 },
  { label: "Friendliness", percent: 79 },
];

export function BunnyTab() {
  const [bunnyName, setBunnyName] = useState("Snuffles");
  const [humanName, setHumanName] = useState("Hooman");
  const [showBunny, setShowBunny] = useState(true);

  return (
    <div className="sp-tab-content sp-bunny-tab">
      <section className="sp-card sp-bunny-tab__about">
        <h2 className="sp-card__title">About the Bun</h2>
        <div className="sp-field">
          <label htmlFor="bunny-name">Bunny Name:</label>
          <input
            id="bunny-name"
            value={bunnyName}
            onChange={(e) => setBunnyName(e.target.value)}
          />
        </div>
        <div className="sp-field">
          <label htmlFor="human-name">Human Name:</label>
          <input
            id="human-name"
            value={humanName}
            onChange={(e) => setHumanName(e.target.value)}
          />
        </div>
        <div className="sp-field sp-field--checkbox">
          <input
            id="show-bunny"
            type="checkbox"
            checked={showBunny}
            onChange={(e) => setShowBunny(e.target.checked)}
            aria-label="Show Bunny"
          />
          <label htmlFor="show-bunny">Show Bunny</label>
        </div>
      </section>

      <section className="sp-card sp-bunny-tab__status">
        <h2 className="sp-card__title">Status</h2>
        {STUB_METERS.map(({ label, percent }) => (
          <div key={label} className="sp-meter">
            <span className="sp-meter__label">{label}</span>
            <div className="sp-meter__track">
              <div className="sp-meter__fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
