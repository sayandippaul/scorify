import { useEffect, useState } from "react";
import "./offline-screen.css";

const CRICKET_FACTS = [
  "The longest cricket match in history lasted for nine days, but it still ended in a dramatic draw because the team had to catch their boat home.",
  "Cricket balls are crafted with a thick cork core wrapped tightly in heavy string, then finished with a polished, hand-stitched leather cover.",
  "The term \"Hat-Trick\" originally comes from cricket, where fans used to buy a brand-new hat for any bowler who took three wickets in a row.",
  "The iconic cricket pitch is exactly 22 yards long, a precise historical measurement that equals the length of one traditional surveyor's chain.",
  "Early cricket bats were shaped like hockey sticks with a heavy curved bottom, designed specifically to sweep balls bowled along the ground.",
];

function OfflineScreen({ onRetry }) {
  const [cricketFact] = useState(
    () => CRICKET_FACTS[Math.floor(Math.random() * CRICKET_FACTS.length)]
  );

  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    document.documentElement.setAttribute(
      "data-theme",
      savedTheme === "light" ? "light" : "dark"
    );
  }, []);

  return (
    <main className="offline-screen" role="alert" aria-live="assertive">
      <div className="offline-screen-orbit offline-screen-orbit-one" aria-hidden="true" />
      <div className="offline-screen-orbit offline-screen-orbit-two" aria-hidden="true" />

      <section className="offline-screen-card">
        <div className="offline-screen-illustration" aria-hidden="true">
          <span className="offline-screen-cloud offline-screen-cloud-back" />
          <span className="offline-screen-cloud offline-screen-cloud-front" />
          <span className="offline-screen-ball">
            <span />
          </span>
          <span className="offline-screen-signal">×</span>
        </div>

        <p className="offline-screen-eyebrow">MATCH DAY PAUSE</p>
        <h1>Looks like you’re offline</h1>
        <p className="offline-screen-message">
          Your internet connection is disconnected. Scorify will be ready to
          play as soon as you’re back online.
        </p>

        <div className="offline-screen-status">
          <span className="offline-screen-status-dot" />
          <span>Waiting for your connection</span>
        </div>

        <aside className="offline-screen-fact">
          <span className="offline-screen-fact-icon" aria-hidden="true">
            🏏
          </span>
          <div>
            <p>CRICKET FACT</p>
            <blockquote>{cricketFact}</blockquote>
          </div>
        </aside>

        <button
          className="offline-screen-retry"
          onClick={onRetry}
          type="button"
        >
          <span aria-hidden="true">↻</span>
          Check connection
        </button>
      </section>
    </main>
  );
}

export default OfflineScreen;
