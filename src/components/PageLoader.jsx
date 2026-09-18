import { useEffect, useState } from "react";
import "./page-loader.css";

const LOADER_DURATION_MS = 1400;

function PageLoader({ onComplete }) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const exitTimer = window.setTimeout(
      () => setIsExiting(true),
      LOADER_DURATION_MS - 280
    );
    const completeTimer = window.setTimeout(
      onComplete,
      LOADER_DURATION_MS
    );

    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <div
      className={`page-loader${isExiting ? " page-loader-exiting" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Loading Scorify"
    >
      <div className="page-loader-glow" />
      <div className="page-loader-content">
        <div className="page-loader-ball" aria-hidden="true">
          <span className="page-loader-seam" />
        </div>
        <div className="page-loader-brand">
          <strong>Scorify</strong>
          <span>Local Cricket</span>
        </div>
        <div className="page-loader-progress" aria-hidden="true">
          <span />
        </div>
        <p>Preparing your match day</p>
      </div>
    </div>
  );
}

export default PageLoader;
