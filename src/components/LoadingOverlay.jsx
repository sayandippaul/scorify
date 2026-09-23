import "./loading-overlay.css";

function LoadingOverlay({
  message = "Loading...",
  fullScreen = false,
  inline = false,
}) {
  return (
    <div
      className={`loading-overlay${fullScreen ? " loading-overlay-full" : ""}${inline ? " loading-overlay-inline" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={message}
    >
      <div className="loading-overlay-card">
        <div className="loading-overlay-orbit" aria-hidden="true">
          <span className="loading-overlay-ball" />
          <span className="loading-overlay-seam" />
        </div>
        <div className="loading-overlay-copy">
          <strong>Scorify</strong>
          <span>{message}</span>
        </div>
      </div>
    </div>
  );
}

export default LoadingOverlay;
