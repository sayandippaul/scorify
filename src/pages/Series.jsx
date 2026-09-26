import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";
import {
  calculateSeriesProgress,
  deleteSeriesCascade,
  loadSeriesStatistics,
  subscribeToAllSeriesMatches,
  subscribeToSeries,
} from "../services/seriesService";
import "./series.css";

function Series() {
  const navigate = useNavigate();
  const [series, setSeries] = useState([]);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [seriesName, setSeriesName] = useState("");
  const [numberOfMatches, setNumberOfMatches] = useState(2);
  const [statisticsSeries, setStatisticsSeries] = useState(null);
  const [statistics, setStatistics] = useState(null);
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [seriesAwardsById, setSeriesAwardsById] = useState({});
  const [deletingSeriesId, setDeletingSeriesId] = useState("");
  const isAdmin =
    Boolean(ADMIN_UID) &&
    String(auth.currentUser?.uid || "") === String(ADMIN_UID);

  useEffect(() => {
    const subscriptions = [
      subscribeToSeries(
        (items) => {
          setSeries(items);
          setLoading(false);
        },
        (loadError) => {
          console.error("Unable to load series:", loadError);
          setError("Unable to load series. Please try again.");
          setLoading(false);
        }
      ),
      subscribeToAllSeriesMatches(
        setMatches,
        (loadError) => {
          console.error("Unable to load series matches:", loadError);
          setError("Unable to load series match updates.");
        }
      ),
    ];
    return () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const matchesBySeries = useMemo(() => {
    const grouped = new Map();
    matches.forEach((match) => {
      const id = String(match?.seriesId || "");
      if (!id) return;
      grouped.set(id, [...(grouped.get(id) || []), match]);
    });
    grouped.forEach((items) =>
      items.sort(
        (left, right) =>
          Number(left.seriesMatchNumber || 0) -
          Number(right.seriesMatchNumber || 0)
      )
    );
    return grouped;
  }, [matches]);

  const sortedSeries = useMemo(
    () =>
      [...series].sort(
        (left, right) =>
          new Date(right.createdAt || 0).getTime() -
          new Date(left.createdAt || 0).getTime()
      ),
    [series]
  );

  const selectedStatisticsMatches = useMemo(
    () =>
      statisticsSeries
        ? matchesBySeries.get(String(statisticsSeries.id)) || []
        : [],
    [statisticsSeries, matchesBySeries]
  );

  useEffect(() => {
    let cancelled = false;
    const eligibleSeries = sortedSeries.filter((item) =>
      (matchesBySeries.get(String(item.id)) || []).some((match) =>
        ["finished", "completed"].includes(
          String(match?.status || "").toLowerCase()
        )
      )
    );
    setSeriesAwardsById({});

    Promise.all(
      eligibleSeries.map(async (item) => {
        const itemMatches = matchesBySeries.get(String(item.id)) || [];
        const result = await loadSeriesStatistics(itemMatches);
        return [String(item.id), result.playerOfCompetition];
      })
    )
      .then((entries) => {
        if (!cancelled) {
          setSeriesAwardsById(Object.fromEntries(entries));
        }
      })
      .catch((loadError) => {
        console.error("Unable to calculate series player awards:", loadError);
        if (!cancelled) {
          setError("Unable to calculate the Player of the Series award.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sortedSeries, matchesBySeries]);

  useEffect(() => {
    if (!statisticsSeries) return undefined;
    let cancelled = false;
    setStatistics(null);
    setStatisticsLoading(true);
    loadSeriesStatistics(selectedStatisticsMatches)
      .then((result) => {
        if (!cancelled) setStatistics(result);
      })
      .catch((loadError) => {
        console.error("Unable to load series statistics:", loadError);
        if (!cancelled) {
          setError("Unable to load series statistics. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled) setStatisticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [statisticsSeries, selectedStatisticsMatches]);

  const openCreate = () => {
    setError("");
    setSeriesName("");
    setNumberOfMatches(2);
    setCreating(true);
  };

  const continueToTeamSetup = (event) => {
    event.preventDefault();
    const cleanName = seriesName.trim();
    if (!cleanName) {
      setError("Enter a series name.");
      return;
    }
    const count = Number(numberOfMatches);
    if (!Number.isInteger(count) || count < 2 || count > 10) {
      setError("Choose between 2 and 10 matches.");
      return;
    }
    setError("");
    setCreating(false);
    navigate(
      `/matches?seriesCreate=true&seriesName=${encodeURIComponent(cleanName)}&numberOfMatches=${count}`
    );
  };

  const removeSeries = async (item) => {
    if (!isAdmin || deletingSeriesId) return;
    const confirmed = window.confirm(
      `Delete "${item.name}" and all matches and records belonging to this series? Reusable teams and players will not be deleted.`
    );
    if (!confirmed) return;
    setDeletingSeriesId(item.id);
    setError("");
    try {
      await deleteSeriesCascade(item.id);
    } catch (deleteError) {
      console.error("Unable to delete series:", deleteError);
      setError("Unable to delete the series. Please try again.");
    } finally {
      setDeletingSeriesId("");
    }
  };

  const showStatistics = (item) => {
    setError("");
    setStatisticsSeries(item);
  };

  const dismissStatistics = () => {
    setStatisticsSeries(null);
    setStatistics(null);
  };

  const seriesCard = (item) => {
    const itemMatches = matchesBySeries.get(String(item.id)) || [];
    const progress = calculateSeriesProgress(item, itemMatches);
    const seriesTeams = (item.teamNames || []).filter(Boolean);
    const seriesWasDecided = progress.status === "COMPLETED";
    const seriesIsDrawn =
      seriesWasDecided &&
      progress.results.A.wins === progress.results.B.wins;
    return (
      <article className="series-card" key={item.id}>
        <div className="series-card-top">
          <div className="series-card-title">
            <span aria-hidden="true">👑</span>
            <h3 title={item.name}>{item.name}</h3>
          </div>
          <span
            className={`series-status series-status-${progress.status.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {progress.status}
          </span>
        </div>
        <p className="series-card-teams" title={seriesTeams.join(" vs ")}>
          <strong>{seriesTeams[0] || "Team A"}</strong>
          <span>vs</span>
          <strong>{seriesTeams[1] || "Team B"}</strong>
        </p>
        <div className="series-card-meta">
          <span>
            Matches <strong>{item.numberOfMatches || itemMatches.length}</strong>
          </span>
          <span>
            Completed <strong>{progress.completedMatches}</strong>
          </span>
        </div>
        <div
          className={`series-result ${
            seriesWasDecided
              ? seriesIsDrawn
                ? "series-result-drawn"
                : "series-result-winner"
              : ""
          }`}
          aria-live="polite"
        >
          <span className="series-result-icon" aria-hidden="true">
            {seriesWasDecided ? (seriesIsDrawn ? "🤝" : "🏆") : "📊"}
          </span>
          <span>{progress.resultLabel}</span>
        </div>
        {progress.completedMatches > 0 &&
          seriesAwardsById[String(item.id)] && (
            <div className="series-player-award">
              <span aria-hidden="true">🌟</span>
              <span>
                <small>
                  {seriesWasDecided
                    ? "Player of the Series"
                    : "Current Player of the Series"}
                </small>
                <strong>
                  {seriesAwardsById[String(item.id)].playerName}
                </strong>
                <small>
                  {seriesAwardsById[String(item.id)].averagePoints.toFixed(2)} average points ·{" "}
                  {seriesAwardsById[String(item.id)].matchesPlayed} matches
                </small>
              </span>
            </div>
          )}
        <div className="series-card-actions">
          <button
            type="button"
            onClick={() =>
              navigate(`/matches?seriesId=${encodeURIComponent(item.id)}`)
            }
          >
            View Matches
          </button>
          <button
            type="button"
            onClick={() =>
              navigate(`/teams?seriesId=${encodeURIComponent(item.id)}`)
            }
          >
            View Teams
          </button>
          <button type="button" onClick={() => showStatistics(item)}>
            View Statistics
          </button>
          {isAdmin && (
            <button
              type="button"
              className="series-delete-button"
              disabled={Boolean(deletingSeriesId)}
              onClick={() => removeSeries(item)}
            >
              {deletingSeriesId === item.id ? "Deleting…" : "Delete Series"}
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="page series-page">
      <header className="series-header">
        <div>
          <p className="series-eyebrow">SCORIFY COMPETITIONS</p>
          <h2>👑 Series</h2>
          <p className="series-subtitle">
            Manage and follow your cricket series.
          </p>
        </div>
        <button
          type="button"
          className="series-primary-button"
          onClick={openCreate}
        >
          ＋ Create Series
        </button>
      </header>

      {error && (
        <div className="series-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="series-empty-state" role="status">
          Loading series…
        </div>
      ) : sortedSeries.length ? (
        <section className="series-grid" aria-label="Cricket series">
          {sortedSeries.map(seriesCard)}
        </section>
      ) : (
        <section className="series-empty-state">
          <span className="series-empty-icon" aria-hidden="true">👑</span>
          <h3>No Series Yet</h3>
          <p>Create your first cricket series.</p>
          <button
            type="button"
            className="series-primary-button"
            onClick={openCreate}
          >
            ＋ Create Series
          </button>
        </section>
      )}

      {creating && (
        <div
          className="series-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCreating(false);
            }
          }}
        >
          <form
            className="series-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="series-create-title"
            onSubmit={continueToTeamSetup}
          >
            <div className="series-modal-heading">
              <div>
                <p className="series-eyebrow">NEW COMPETITION</p>
                <h3 id="series-create-title">Create Series</h3>
              </div>
              <button
                type="button"
                className="series-icon-button"
                aria-label="Close create series"
                onClick={() => setCreating(false)}
              >
                ×
              </button>
            </div>
            <label className="series-field">
              <span>Series Name</span>
              <input
                autoFocus
                required
                maxLength={80}
                value={seriesName}
                onChange={(event) => setSeriesName(event.target.value)}
                placeholder="e.g. Paytm Cup"
              />
            </label>
            <label className="series-field">
              <span>Number of Matches</span>
              <select
                value={numberOfMatches}
                onChange={(event) =>
                  setNumberOfMatches(Number(event.target.value))
                }
              >
                {Array.from({ length: 9 }, (_, index) => index + 2).map(
                  (count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  )
                )}
              </select>
            </label>
            <div className="series-modal-actions">
              <button
                type="button"
                className="series-secondary-button"
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="series-primary-button"
              >
                Continue to Team Setup
              </button>
            </div>
          </form>
        </div>
      )}

      {statisticsSeries && (
        <div
          className="series-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismissStatistics();
          }}
        >
          <section
            className="series-modal series-statistics-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="series-statistics-title"
          >
            <div className="series-modal-heading">
              <div>
                <p className="series-eyebrow">SERIES STATISTICS</p>
                <h3 id="series-statistics-title" title={statisticsSeries.name}>
                  {statisticsSeries.name}
                </h3>
              </div>
              <button
                type="button"
                className="series-icon-button"
                aria-label="Close series statistics"
                onClick={dismissStatistics}
              >
                ×
              </button>
            </div>
            {statisticsLoading ? (
              <p className="series-form-note" role="status">
                Loading statistics…
              </p>
            ) : !statistics?.completedInnings ? (
              <p className="series-form-note">
                No statistics available yet.
              </p>
            ) : (
              <div className="series-statistics-grid">
                <article className="series-stat-card">
                  <span>🏏 Highest Run Scorer</span>
                  <strong>
                    {statistics.highestRunScorer?.playerName || "—"}
                  </strong>
                  <small>
                    {statistics.highestRunScorer?.value ?? 0} runs
                  </small>
                </article>
                <article className="series-stat-card">
                  <span>🎯 Highest Wicket Taker</span>
                  <strong>
                    {statistics.highestWicketTaker?.playerName || "—"}
                  </strong>
                  <small>
                    {statistics.highestWicketTaker?.value ?? 0} wickets
                  </small>
                </article>
                <article className="series-stat-card">
                  <span>🔥 Highest Innings Score</span>
                  <strong>
                    {statistics.highestInningsScore?.team || "—"}
                  </strong>
                  <small>
                    {statistics.highestInningsScore?.runs ?? 0} runs ·{" "}
                    {statistics.highestInningsScore?.match || "Match"} ·{" "}
                    {statistics.highestInningsScore?.inningsNumber}
                    {statistics.highestInningsScore?.inningsNumber === 1
                      ? "st"
                      : statistics.highestInningsScore?.inningsNumber === 2
                        ? "nd"
                        : statistics.highestInningsScore?.inningsNumber === 3
                          ? "rd"
                          : "th"}{" "}
                    innings
                  </small>
                </article>
                <article className="series-stat-card">
                  <span>📈 Average Innings Score</span>
                  <strong>
                    {Number(statistics.averageInningsScore || 0).toFixed(2)}
                  </strong>
                  <small>
                    Across {statistics.completedInnings} completed innings
                  </small>
                </article>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default Series;
