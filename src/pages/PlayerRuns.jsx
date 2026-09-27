import { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase/firebase";
import {
  subscribeToMatches,
  subscribeToPlayers,
} from "../services/matchService";
import "./player-runs.css";

const SHOT_REGIONS = [
  "Behind Keeper",
  "Third Man",
  "Square Off",
  "Cover",
  "Long Off",
  "Long On",
  "Midwicket",
  "Square Leg",
  "Fine Leg",
];

const playerIdOf = (player) =>
  String(player?.id ?? player?.uid ?? player?.playerId ?? player?._id ?? "").trim();

const playerNameOf = (player) =>
  String(player?.name ?? player?.playerName ?? "").trim();

const playerKey = (player) =>
  playerIdOf(player)
    ? `id:${playerIdOf(player)}`
    : `name:${playerNameOf(player).toLowerCase()}`;

const samePlayer = (left, right) => {
  const leftId = playerIdOf(left);
  const rightId = playerIdOf(right);
  if (leftId && rightId) return leftId === rightId;

  const leftName = playerNameOf(left).toLowerCase();
  return Boolean(leftName && leftName === playerNameOf(right).toLowerCase());
};

const inningsFor = (match) => {
  const savedInnings = Array.isArray(match?.testInnings)
    ? match.testInnings
    : Array.isArray(match?.innings)
      ? match.innings
      : [];

  return [
    ...savedInnings,
    match?.firstInningsData,
    match?.secondInningsData,
    match?.scoringState,
  ].filter(Boolean);
};

const playersInMatch = (match) => {
  const entries = [
    ...(match?.teamA?.players || match?.teamAPlayers || []),
    ...(match?.teamB?.players || match?.teamBPlayers || []),
  ];

  inningsFor(match).forEach((innings) => {
    Object.entries(innings?.battingStats || {}).forEach(([id, stats]) => {
      entries.push({
        id: stats?.id || stats?.playerId || id,
        name: stats?.name || stats?.playerName || id,
      });
    });
    Object.entries(innings?.bowlingStats || {}).forEach(([id, stats]) => {
      entries.push({
        id: stats?.id || stats?.playerId || id,
        name: stats?.name || stats?.playerName || id,
      });
    });
    (innings?.deliveries || []).forEach((delivery) => {
      if (delivery?.strikerId || delivery?.strikerName || delivery?.batterName) {
        entries.push({
          id: delivery.strikerId || delivery.batterId,
          name: delivery.strikerName || delivery.batterName,
        });
      }
      if (delivery?.bowlerId || delivery?.bowlerName) {
        entries.push({
          id: delivery.bowlerId,
          name: delivery.bowlerName,
        });
      }
    });
  });

  return entries;
};

const matchTitle = (match) => {
  const teams = [
    match?.teamAName || match?.teamA?.name || "Team A",
    match?.teamBName || match?.teamB?.name || "Team B",
  ].join(" vs ");
  const date = match?.date || match?.matchDate || match?.createdAt;
  const parsedDate = date ? new Date(date) : null;
  const dateLabel =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleDateString()
      : "";
  return dateLabel ? `${teams} · ${dateLabel}` : teams;
};

const deliveryRuns = (delivery) => {
  const recordedRuns = delivery?.batterRuns ?? delivery?.batsmanRuns;
  if (recordedRuns !== undefined && recordedRuns !== null) {
    return Number(recordedRuns) || 0;
  }

  const extraType = String(delivery?.type || delivery?.extraType || "").toUpperCase();
  return ["WD", "WIDE", "BYE", "B", "LB", "LEG_BYE"].includes(extraType)
    ? 0
    : Number(delivery?.runs ?? delivery?.totalRuns ?? 0) || 0;
};

const regionOf = (delivery) => {
  if (delivery?.shotRegion) return String(delivery.shotRegion);
  const position = Number(delivery?.shotPosition);
  return Number.isInteger(position) ? SHOT_REGIONS[position - 1] || "" : "";
};

const deliveryPlayer = (delivery) => ({
  id: delivery?.strikerId || delivery?.batterId || delivery?.playerId,
  name: delivery?.strikerName || delivery?.batterName || delivery?.playerName,
});

const bowlerOf = (delivery) => ({
  id: delivery?.bowlerId || delivery?.bowlerPlayerId,
  name: delivery?.bowlerName,
});

const bowlerConcededRuns = (delivery) => {
  const directRuns = delivery?.bowlerRuns ?? delivery?.runsConceded;
  if (directRuns !== undefined && directRuns !== null) {
    return Math.max(0, Number(directRuns) || 0);
  }

  const type = String(delivery?.type || delivery?.extraType || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (["BYE", "LEG_BYE", "LB"].includes(type)) return 0;
  if (["NB", "NO_BALL"].includes(type)) {
    const batterRuns = Number(delivery?.batterRuns ?? delivery?.batsmanRuns ?? 0) || 0;
    const totalRuns = Number(delivery?.runs ?? delivery?.totalRuns ?? 0) || 0;
    return Math.max(1 + batterRuns, totalRuns);
  }
  if (["WD", "WIDE"].includes(type)) {
    return Math.max(
      1,
      Number(delivery?.wideRuns ?? delivery?.runs ?? delivery?.totalRuns ?? 0) || 0
    );
  }
  return Math.max(0, Number(delivery?.runs ?? delivery?.totalRuns ?? 0) || 0);
};

const isLegalDelivery = (delivery) => {
  if (delivery?.validBall !== undefined) return delivery.validBall === true;
  if (delivery?.legalBall !== undefined) return delivery.legalBall === true;
  const type = String(delivery?.type || delivery?.extraType || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return !["NB", "NO_BALL", "WD", "WIDE", "DEAD"].includes(type);
};

const wicketCreditsBowler = (delivery) => {
  const type = String(delivery?.wicket?.type || delivery?.wicketType || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return Boolean(type) && ![
    "runout",
    "retiredhurt",
    "retiredout",
    "obstructingthefield",
    "timedout",
  ].includes(type);
};

const deliveryLabel = (delivery, index) => {
  const over = Number(delivery?.over ?? delivery?.overNumber);
  const ball = Number(delivery?.ball ?? delivery?.ballNumber);
  if (Number.isFinite(over) && Number.isFinite(ball) && ball > 0) {
    return `${Math.max(1, Math.floor(over))}.${ball}`;
  }
  return `Ball ${index + 1}`;
};

const sumBattingStats = (statsEntries) => {
  if (!statsEntries.length) return null;
  return statsEntries.reduce(
    (total, stats) => ({
      runs: total.runs + (Number(stats?.runs) || 0),
      balls: total.balls + (Number(stats?.balls) || 0),
      fours: total.fours + (Number(stats?.fours) || 0),
      sixes: total.sixes + (Number(stats?.sixes) || 0),
    }),
    { runs: 0, balls: 0, fours: 0, sixes: 0 }
  );
};

const sumBowlingStats = (statsEntries) => {
  if (!statsEntries.length) return null;
  return statsEntries.reduce(
    (total, stats) => ({
      runs: total.runs + (Number(stats?.runsConceded ?? stats?.runs) || 0),
      legalBalls: total.legalBalls + (Number(stats?.legalBalls ?? stats?.balls) || 0),
      wickets: total.wickets + (Number(stats?.wickets) || 0),
      maidens: total.maidens + (Number(stats?.maidens) || 0),
      dotBalls: total.dotBalls + (Number(stats?.dotBalls) || 0),
    }),
    { runs: 0, legalBalls: 0, wickets: 0, maidens: 0, dotBalls: 0 }
  );
};

function PlayerRuns({ embedded = false }) {
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [selectedPlayerKey, setSelectedPlayerKey] = useState("");
  const [selectedMatchId, setSelectedMatchId] = useState("");
  const [loadingLists, setLoadingLists] = useState(true);
  const [listError, setListError] = useState("");
  const [matchData, setMatchData] = useState(null);
  const [loadingMatchData, setLoadingMatchData] = useState(false);
  const [matchDataError, setMatchDataError] = useState("");

  useEffect(() => {
    let playersLoaded = false;
    let matchesLoaded = false;
    const finishLoading = () => {
      if (playersLoaded && matchesLoaded) setLoadingLists(false);
    };
    const failLoading = (error) => {
      console.error("Unable to load player run selectors:", error);
      setListError("Could not load players and matches. Please refresh and try again.");
      setLoadingLists(false);
    };

    const unsubscribePlayers = subscribeToPlayers((loadedPlayers) => {
      setPlayers(loadedPlayers);
      playersLoaded = true;
      finishLoading();
    }, failLoading);
    const unsubscribeMatches = subscribeToMatches((loadedMatches) => {
      setMatches(loadedMatches);
      matchesLoaded = true;
      finishLoading();
    }, failLoading);

    return () => {
      unsubscribePlayers();
      unsubscribeMatches();
    };
  }, []);

  const playerOptions = useMemo(() => {
    const unique = new Map();
    [...players, ...matches.flatMap(playersInMatch)].forEach((player) => {
      const name = playerNameOf(player);
      if (!name || name === "Unknown Player") return;
      const key = playerKey(player);
      if (!unique.has(key)) unique.set(key, { ...player, name });
    });
    return [...unique.entries()]
      .map(([key, player]) => ({ key, player }))
      .sort((left, right) =>
        left.player.name.localeCompare(right.player.name)
      );
  }, [matches, players]);

  const selectedPlayer = playerOptions.find(
    ({ key }) => key === selectedPlayerKey
  )?.player;

  const playerMatches = useMemo(() => {
    if (!selectedPlayer) return [];
    return matches
      .filter((match) =>
        playersInMatch(match).some((player) => samePlayer(player, selectedPlayer))
      )
      .sort((left, right) => {
        const leftDate = new Date(left.date || left.matchDate || left.createdAt || 0).getTime();
        const rightDate = new Date(right.date || right.matchDate || right.createdAt || 0).getTime();
        return rightDate - leftDate;
      });
  }, [matches, selectedPlayer]);

  useEffect(() => {
    if (!playerMatches.some((match) => String(match.id) === selectedMatchId)) {
      setSelectedMatchId("");
    }
  }, [playerMatches, selectedMatchId]);

  useEffect(() => {
    if (!selectedPlayer || !selectedMatchId) {
      setMatchData(null);
      setMatchDataError("");
      return undefined;
    }

    let cancelled = false;
    const loadPlayerMatch = async () => {
      setLoadingMatchData(true);
      setMatchData(null);
      setMatchDataError("");
      try {
        const [deliveriesSnapshot, battingSnapshot, bowlingSnapshot] = await Promise.all([
          getDocs(
            query(
              collection(db, "deliveries"),
              where("matchId", "==", String(selectedMatchId))
            )
          ),
          getDocs(
            query(
              collection(db, "battingStats"),
              where("matchId", "==", String(selectedMatchId))
            )
          ),
          getDocs(
            query(
              collection(db, "bowlingStats"),
              where("matchId", "==", String(selectedMatchId))
            )
          ),
        ]);

        if (cancelled) return;

        const match = matches.find(
          (item) => String(item.id) === String(selectedMatchId)
        );
        const storedDeliveries = deliveriesSnapshot.docs.map((item) => ({
          ...item.data(),
          deliveryId: item.id,
        }));
        const fallbackDeliveries = inningsFor(match).flatMap((innings, index) =>
          (Array.isArray(innings?.deliveries) ? innings.deliveries : []).map(
            (delivery) => ({
              ...delivery,
              inningsNumber: delivery.inningsNumber || index + 1,
            })
          )
        );
        const allDeliveries = storedDeliveries.length
          ? storedDeliveries
          : fallbackDeliveries;
        const playerDeliveries = allDeliveries
          .filter((delivery) => samePlayer(deliveryPlayer(delivery), selectedPlayer))
          .sort((left, right) => {
            const inningsDifference =
              Number(left.inningsNumber || 1) - Number(right.inningsNumber || 1);
            if (inningsDifference) return inningsDifference;
            const overDifference =
              Number(left.over ?? left.overNumber ?? 0) -
              Number(right.over ?? right.overNumber ?? 0);
            if (overDifference) return overDifference;
            return (
              Number(left.ball ?? left.ballNumber ?? 0) -
              Number(right.ball ?? right.ballNumber ?? 0)
            );
          });

        const playerBowlingDeliveries = allDeliveries
          .filter((delivery) => samePlayer(bowlerOf(delivery), selectedPlayer))
          .sort((left, right) => {
            const inningsDifference =
              Number(left.inningsNumber || 1) - Number(right.inningsNumber || 1);
            if (inningsDifference) return inningsDifference;
            const overDifference =
              Number(left.over ?? left.overNumber ?? 0) -
              Number(right.over ?? right.overNumber ?? 0);
            if (overDifference) return overDifference;
            return (
              Number(left.ball ?? left.ballNumber ?? 0) -
              Number(right.ball ?? right.ballNumber ?? 0)
            );
          });

        const playerStats = sumBattingStats(battingSnapshot.docs
          .map((item) => item.data())
          .filter((stats) => samePlayer({
            id: stats?.playerId,
            name: stats?.playerName || stats?.name,
          }, selectedPlayer)));
        const embeddedStats = sumBattingStats(inningsFor(match)
          .flatMap((innings) => Object.entries(innings?.battingStats || {}))
          .map(([id, stats]) => ({
            ...stats,
            id: stats?.id || stats?.playerId || id,
            name: stats?.name || stats?.playerName || id,
          }))
          .filter((stats) => samePlayer(stats, selectedPlayer)));

        const playerBowlingStats = sumBowlingStats(bowlingSnapshot.docs
          .map((item) => item.data())
          .filter((stats) => samePlayer({
            id: stats?.playerId,
            name: stats?.playerName || stats?.name,
          }, selectedPlayer)));
        const embeddedBowlingStats = sumBowlingStats(inningsFor(match)
          .flatMap((innings) => Object.entries(innings?.bowlingStats || {}))
          .map(([id, stats]) => ({
            ...stats,
            id: stats?.id || stats?.playerId || id,
            name: stats?.name || stats?.playerName || id,
          }))
          .filter((stats) => samePlayer(stats, selectedPlayer)));

        setMatchData({
          match,
          deliveries: playerDeliveries,
          stats: playerStats || embeddedStats || null,
          bowlingDeliveries: playerBowlingDeliveries,
          bowlingStats: playerBowlingStats || embeddedBowlingStats || null,
        });
      } catch (error) {
        console.error("Unable to load the selected player's match runs:", error);
        if (!cancelled) {
          setMatchDataError(
            "Could not load this player's score details. Please try selecting the match again."
          );
        }
      } finally {
        if (!cancelled) setLoadingMatchData(false);
      }
    };

    loadPlayerMatch();
    return () => {
      cancelled = true;
    };
  }, [matches, selectedMatchId, selectedPlayer]);

  const summary = useMemo(() => {
    if (!matchData) return null;
    const deliveries = matchData.deliveries;
    const stats = matchData.stats;
    const bowlingStats = matchData.bowlingStats;
    const bowlingDeliveries = matchData.bowlingDeliveries;
    const runsFromDeliveries = deliveries.reduce(
      (total, delivery) => total + deliveryRuns(delivery),
      0
    );
    const locations = new Map();

    deliveries.forEach((delivery) => {
      const runs = deliveryRuns(delivery);
      if (runs <= 0) return;
      const region = regionOf(delivery) || "Location not recorded";
      const current = locations.get(region) || { runs: 0, scoringBalls: 0 };
      current.runs += runs;
      current.scoringBalls += 1;
      locations.set(region, current);
    });

    const runs = stats ? Number(stats.runs || 0) : runsFromDeliveries;
    const balls = stats ? Number(stats.balls || 0) : deliveries.length;
    const fours = stats ? Number(stats.fours || 0) : deliveries.filter(
      (delivery) => deliveryRuns(delivery) === 4
    ).length;
    const sixes = stats ? Number(stats.sixes || 0) : deliveries.filter(
      (delivery) => deliveryRuns(delivery) === 6
    ).length;
    const bowlingBalls = bowlingDeliveries.filter(isLegalDelivery).length;
    const fallbackBowling = bowlingDeliveries.length
      ? {
          runs: bowlingDeliveries.reduce(
            (total, delivery) => total + bowlerConcededRuns(delivery),
            0
          ),
          legalBalls: bowlingBalls,
          wickets: bowlingDeliveries.filter(wicketCreditsBowler).length,
          maidens: 0,
          dotBalls: bowlingDeliveries.filter(
            (delivery) => bowlerConcededRuns(delivery) === 0
          ).length,
        }
      : null;

    return {
      batting: Boolean(stats || deliveries.length),
      runs,
      balls,
      fours,
      sixes,
      bowling: bowlingStats || fallbackBowling,
      bowlingDeliveries,
      locations: [...locations.entries()]
        .map(([region, values]) => ({ region, ...values }))
        .sort((left, right) => right.runs - left.runs),
    };
  }, [matchData]);

  return (
    <section className={`player-runs-page${embedded ? " player-runs-embedded" : ""}`}>
      <header className="player-runs-header">
        <div>
          <span className="player-runs-eyebrow">PLAYER PERFORMANCE</span>
          {embedded ? (
            <h2>Player Analysis Match by Match</h2>
          ) : (
            <h1>Player Analysis Match by Match</h1>
          )}
          <p>Choose a player and match to review their batting and bowling performance.</p>
        </div>
        <span className="player-runs-header-icon" aria-hidden="true">🏏</span>
      </header>

      {listError ? (
        <div className="player-runs-notice player-runs-error" role="alert">
          {listError}
        </div>
      ) : (
        <>
          <div className="player-runs-selectors">
            <label>
              <span>1. Choose a player</span>
              <select
                value={selectedPlayerKey}
                onChange={(event) => {
                  setSelectedPlayerKey(event.target.value);
                  setSelectedMatchId("");
                }}
                disabled={loadingLists}
              >
                <option value="">
                  {loadingLists ? "Loading players..." : "Select a player"}
                </option>
                {playerOptions.map(({ key, player }) => (
                  <option key={key} value={key}>{player.name}</option>
                ))}
              </select>
            </label>

            <label>
              <span>2. Choose a match</span>
              <select
                value={selectedMatchId}
                onChange={(event) => setSelectedMatchId(event.target.value)}
                disabled={!selectedPlayer || loadingLists || !playerMatches.length}
              >
                <option value="">
                  {!selectedPlayer
                    ? "Choose a player first"
                    : playerMatches.length
                      ? "Select a match"
                      : "No matches found for this player"}
                </option>
                {playerMatches.map((match) => (
                  <option key={match.id} value={match.id}>
                    {matchTitle(match)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {loadingLists && (
            <p className="player-runs-notice" role="status">Loading players and matches...</p>
          )}

          {selectedPlayer && !loadingLists && playerMatches.length === 0 && (
            <div className="player-runs-empty">
              <span aria-hidden="true">📋</span>
              <h2>No matches found</h2>
              <p>This player is not listed in any available match squads.</p>
            </div>
          )}

          {loadingMatchData && (
            <p className="player-runs-notice" role="status">Loading this player's score...</p>
          )}

          {matchDataError && (
            <div className="player-runs-notice player-runs-error" role="alert">
              {matchDataError}
            </div>
          )}

          {summary && !loadingMatchData && (
            <>
              <div className="player-runs-match-heading">
                <div>
                  <span>SELECTED PLAYER</span>
                  <h2>{playerNameOf(selectedPlayer)}</h2>
                </div>
                <p>{matchTitle(matchData.match)}</p>
              </div>

              {summary.batting && (
                <>
                  <div className="player-runs-role-heading">
                    <span>BATTING ANALYSIS</span>
                    <h2>{playerNameOf(selectedPlayer)} · Batting</h2>
                  </div>
                  <div className="player-runs-stat-grid">
                    <article className="player-runs-stat player-runs-stat-featured">
                      <span>RUNS</span>
                      <strong>{summary.runs}</strong>
                      <small>from {summary.balls} balls</small>
                    </article>
                    <article className="player-runs-stat">
                      <span>FOURS</span>
                      <strong>{summary.fours}</strong>
                    </article>
                    <article className="player-runs-stat">
                      <span>SIXES</span>
                      <strong>{summary.sixes}</strong>
                    </article>
                    <article className="player-runs-stat">
                      <span>STRIKE RATE</span>
                      <strong>
                        {summary.balls
                          ? ((summary.runs / summary.balls) * 100).toFixed(1)
                          : "—"}
                      </strong>
                    </article>
                  </div>

                  <section className="player-runs-card" aria-labelledby="runs-by-area-title">
                    <div className="player-runs-card-heading">
                      <div>
                        <span>SHOT BREAKDOWN</span>
                        <h2 id="runs-by-area-title">Runs scored by area</h2>
                      </div>
                      <p>Based on recorded shot locations</p>
                    </div>
                    {summary.locations.length ? (
                      <div className="player-runs-area-list">
                        {summary.locations.map((location) => (
                          <div className="player-runs-area" key={location.region}>
                            <span className="player-runs-area-name">{location.region}</span>
                            <div className="player-runs-area-track" aria-hidden="true">
                              <span
                                style={{
                                  width: `${Math.max(
                                    6,
                                    (location.runs / Math.max(...summary.locations.map((item) => item.runs))) * 100
                                  )}%`,
                                }}
                              />
                            </div>
                            <strong>{location.runs}</strong>
                            <small>{location.scoringBalls} scoring {location.scoringBalls === 1 ? "shot" : "shots"}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="player-runs-empty-inline">
                        No shot locations were recorded for this player's runs in this match.
                      </p>
                    )}
                  </section>
                </>
              )}

              {summary.bowling && (
                <>
                  <div className="player-runs-role-heading">
                    <span>BOWLING ANALYSIS</span>
                    <h2>{playerNameOf(selectedPlayer)} · Bowling</h2>
                  </div>
                  <div className="player-runs-stat-grid player-runs-bowling-grid">
                    <article className="player-runs-stat player-runs-stat-featured">
                      <span>OVERS</span>
                      <strong>
                        {Math.floor(summary.bowling.legalBalls / 6)}.
                        {summary.bowling.legalBalls % 6}
                      </strong>
                      <small>{summary.bowling.runs} runs conceded</small>
                    </article>
                    <article className="player-runs-stat">
                      <span>WICKETS</span>
                      <strong>{summary.bowling.wickets}</strong>
                    </article>
                    <article className="player-runs-stat">
                      <span>MAIDENS</span>
                      <strong>{summary.bowling.maidens}</strong>
                    </article>
                    <article className="player-runs-stat">
                      <span>ECONOMY</span>
                      <strong>
                        {summary.bowling.legalBalls
                          ? (summary.bowling.runs * 6 / summary.bowling.legalBalls).toFixed(2)
                          : "—"}
                      </strong>
                      <small>{summary.bowling.dotBalls} dot balls</small>
                    </article>
                  </div>

                  <section className="player-runs-card" aria-labelledby="bowler-deliveries-title">
                    <div className="player-runs-card-heading">
                      <div>
                        <span>BALL BY BALL</span>
                        <h2 id="bowler-deliveries-title">This player's bowling</h2>
                      </div>
                      <p>
                        {summary.bowling.legalBalls} legal balls · {summary.bowling.wickets} wickets
                      </p>
                    </div>
                    {matchData.bowlingDeliveries.length ? (
                      <div className="player-runs-table-wrap">
                        <table className="player-runs-table">
                          <thead>
                            <tr>
                              <th>Innings</th>
                              <th>Over · ball</th>
                              <th>Runs conceded</th>
                              <th>Extras</th>
                              <th>Wicket</th>
                              <th>Batter</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matchData.bowlingDeliveries.map((delivery, index) => {
                              const batterRuns = deliveryRuns(delivery);
                              const totalRuns = Number(
                                delivery.runs ?? delivery.totalRuns ?? batterRuns
                              ) || 0;
                              const type = String(
                                delivery.type || delivery.extraType || ""
                              ).toUpperCase();
                              const extras = Math.max(
                                0,
                                Number(delivery.extras ?? (totalRuns - batterRuns)) || 0
                              );
                              const wicketType =
                                delivery.wicket?.type || delivery.wicketType || "";
                              return (
                                <tr key={delivery.deliveryId || `bowl-${delivery.inningsNumber}-${index}`}>
                                  <td>Innings {delivery.inningsNumber || 1}</td>
                                  <td>{deliveryLabel(delivery, index)}</td>
                                  <td>
                                    <strong>{bowlerConcededRuns(delivery)}</strong>
                                    {!isLegalDelivery(delivery) && <small> · {type || "extra"}</small>}
                                  </td>
                                  <td>{extras ? `${extras} (${type || "extra"})` : "—"}</td>
                                  <td>
                                    {wicketType
                                      ? `${wicketType}${wicketCreditsBowler(delivery) ? "" : " (not credited)"}`
                                      : "—"}
                                  </td>
                                  <td>{delivery.strikerName || delivery.batterName || "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="player-runs-empty-inline">
                        Bowling figures are available, but ball-by-ball bowling records were not saved for this match.
                      </p>
                    )}
                  </section>
                </>
              )}

              {summary.batting && (
              <section className="player-runs-card" aria-labelledby="player-deliveries-title">
                <div className="player-runs-card-heading">
                  <div>
                    <span>BALL BY BALL</span>
                    <h2 id="player-deliveries-title">This player's deliveries</h2>
                  </div>
                  <p>{summary.balls} balls faced</p>
                </div>
                {matchData.deliveries.length ? (
                  <div className="player-runs-table-wrap">
                    <table className="player-runs-table">
                      <thead>
                        <tr>
                          <th>Innings</th>
                          <th>Over · ball</th>
                          <th>Runs</th>
                          <th>Scored where</th>
                          <th>Bowler</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matchData.deliveries.map((delivery, index) => {
                          const runs = deliveryRuns(delivery);
                          const extraRuns = Number(
                            delivery.extras ?? ((delivery.totalRuns ?? delivery.runs ?? 0) - runs)
                          ) || 0;
                          return (
                            <tr key={delivery.deliveryId || `${delivery.inningsNumber}-${index}`}>
                              <td>Innings {delivery.inningsNumber || 1}</td>
                              <td>{deliveryLabel(delivery, index)}</td>
                              <td>
                                <strong>{runs}</strong>
                                {extraRuns > 0 && <small> + {extraRuns} extras</small>}
                              </td>
                              <td>{runs > 0 ? regionOf(delivery) || "Location not recorded" : "—"}</td>
                              <td>{delivery.bowlerName || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="player-runs-empty-inline">
                    A batting summary is available, but ball-by-ball scoring locations were not saved for this match.
                  </p>
                )}
              </section>
              )}
            </>
          )}

          {selectedPlayer && selectedMatchId && !loadingMatchData && !matchDataError && !summary && (
            <div className="player-runs-empty">
              <span aria-hidden="true">🏏</span>
              <h2>No batting record found</h2>
              <p>There are no saved batting runs for this player in the selected match.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default PlayerRuns;
