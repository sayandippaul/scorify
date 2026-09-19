import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  getDocs,
} from "firebase/firestore";
import "./matches.css";
import { calculateWinPrediction, getPredictionForDelivery } from "../services/winPrediction";
import { db } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";
import {
  saveMatch,
  saveTeam,
  subscribeToMatches,
  subscribeToPlayers,
  subscribeToTeams,
  subscribeToTeamPlayers,
  getCurrentUserId,
  deleteMatchCascade,
} from "../services/matchService";

const PLAYER_STORAGE_KEY = "cricket_players";
const MATCH_STORAGE_KEY = "cricket_matches";
const TEAM_STORAGE_KEY = "cricket_teams";

const emptyTeam = {
  name: "",
  captain: null,
  players: [],
};

const TOSS_FLIP_MS = 2000;

function CoinFlip({ result, spinning = false }) {
  const normalizedResult = result === "Heads" ? "Heads" : result === "Tails" ? "Tails" : null;
  const stateClass = normalizedResult
    ? `coin-stage-result coin-stage-${normalizedResult.toLowerCase()}`
    : spinning
      ? "coin-stage-spin"
      : "coin-stage-spin";

  return (
    <div className={`coin-stage ${stateClass}`}>
      <div className="coin-3d">
        <div className="coin-face coin-heads">H</div>
        <div className="coin-face coin-tails">T</div>
      </div>
      {normalizedResult ? (
        <p className="coin-side-label">{normalizedResult}</p>
      ) : (
        <p className="coin-side-label">Flipping...</p>
      )}
    </div>
  );
}

const scorecardPlayerId = (player) =>
  String(
    player?.id ??
      player?._id ??
      player?.playerId ??
      player?.name ??
      ""
  );

const scorecardPlayerName = (player) =>
  player?.name || player?.playerName || "Unknown Player";

const scorecardOvers = (balls = 0) =>
  `${Math.floor(Number(balls || 0) / 6)}.${Number(balls || 0) % 6}`;

const scorecardStrikeRate = (runs = 0, balls = 0) =>
  balls ? ((Number(runs) / Number(balls)) * 100).toFixed(2) : "0.00";

const scorecardEconomy = (runs = 0, balls = 0) =>
  balls ? ((Number(runs) / Number(balls)) * 6).toFixed(2) : "0.00";

const getTossWinnerTeamId = (match) => {
  const winner = match?.secondTossWinner;
  const winnerId = winner?.id ?? winner?.playerId;

  if (!winnerId) return null;

  const teams = [match.teamA, match.teamB].filter(Boolean);
  return teams.find((team) =>
    (team.players || []).some(
      (player) => String(scorecardPlayerId(player)) === String(winnerId)
    )
  )?.id || null;
};

function LiveWinPredictionCard({ prediction, title = "LIVE WIN PREDICTION" }) {
  if (!prediction) return null;

  const teamA = Math.round(Number(prediction.A || 0));
  const teamB = Math.round(Number(prediction.B || 0));
  const phaseLabel = prediction.phase === "pre-match" ? "PRE-MATCH" : prediction.phase === "finished" ? "FINAL" : "LIVE";

  return (
    <section className="win-prediction-card" aria-label={title}>
      <div className="win-prediction-header">
        <div>
          <p className="win-prediction-eyebrow">{title}</p>
          <small>{phaseLabel}{prediction.h2hIncluded ? " • H2H included" : ""}</small>
        </div>
        <span className="win-prediction-live-dot" />
      </div>

      <div className="win-prediction-team">
        <div className="win-prediction-label">
          <strong>{prediction.teamA}</strong>
          <b>{teamA}%</b>
        </div>
        <div className="win-prediction-track" aria-hidden="true">
          <span className="win-prediction-fill win-prediction-fill-a" style={{ width: `${teamA}%` }} />
        </div>
      </div>

      <div className="win-prediction-team">
        <div className="win-prediction-label">
          <strong>{prediction.teamB}</strong>
          <b>{teamB}%</b>
        </div>
        <div className="win-prediction-track" aria-hidden="true">
          <span className="win-prediction-fill win-prediction-fill-b" style={{ width: `${teamB}%` }} />
        </div>
      </div>

      {prediction.metrics && (
        <div className="win-prediction-metrics">
          {prediction.metrics.runsRequired != null && (
            <span><small>Required</small><b>{prediction.metrics.runsRequired}</b></span>
          )}
          <span><small>Current RR</small><b>{Number(prediction.metrics.currentRR || 0).toFixed(2)}</b></span>
          {prediction.metrics.runsRequired != null && (
            <span><small>Required RR</small><b>{Number.isFinite(prediction.metrics.requiredRR) ? Number(prediction.metrics.requiredRR).toFixed(2) : "—"}</b></span>
          )}
          <span><small>Recent 6</small><b>{prediction.metrics.recentSixRuns}</b></span>
        </div>
      )}
    </section>
  );
}

const predictionHistoryMatch = (match) => ({
  ...(match || {}),
  // Historical rows must be calculated as if the match were live. The
  // actual result is intentionally used only for the final "After match"
  // row so a finished match does not turn every past over into 100/0.
  status: "live",
  winner: null,
  result: null,
  resultText: "",
});

const deliveryHistoryTotals = (deliveries = []) =>
  deliveries.reduce(
    (totals, delivery) => ({
      runs: totals.runs + Number(delivery?.runs ?? delivery?.batterRuns ?? 0),
      wickets:
        totals.wickets +
        (delivery?.wicket ? 1 : Number(delivery?.wickets ?? 0)),
      legalBalls:
        totals.legalBalls +
        (delivery?.validBall === false
          ? 0
          : delivery?.validBall === true
            ? 1
            : ["NB", "WD", "DEAD", "NO_BALL", "WIDE"].includes(
                String(delivery?.type || "").toUpperCase()
              )
              ? 0
              : 1),
    }),
    { runs: 0, wickets: 0, legalBalls: 0 }
  );

const scorecardHistoryInnings = ({ match, scoringState }) => {
  const teams = {
    A: match?.teamA || {
      id: "A",
      name: match?.teamAName || "Team A",
      players: match?.teamAPlayers || [],
    },
    B: match?.teamB || {
      id: "B",
      name: match?.teamBName || "Team B",
      players: match?.teamBPlayers || [],
    },
  };

  const firstSaved = match?.firstInningsData || null;
  const secondSaved = match?.secondInningsData || null;
  const firstTeamId =
    firstSaved?.teamId === "B" || match?.firstInningsTeamId === "B"
      ? "B"
      : "A";
  const secondTeamId = firstTeamId === "A" ? "B" : "A";

  const fromScoringState = () => {
    if (!scoringState || typeof scoringState !== "object") return null;

    const inningsIndex = Number(scoringState.inningsIndex) === 1 ? 1 : 0;
    const teamId = inningsIndex === 1 ? secondTeamId : firstTeamId;
    const team = teams[teamId];
    const deliveries = Array.isArray(scoringState.deliveries)
      ? scoringState.deliveries
      : [];

    return {
      teamId,
      teamName: team?.name,
      runs: Number(scoringState.inningsRuns || 0),
      wickets: Number(scoringState.inningsWickets || 0),
      balls: Number(scoringState.legalBalls || 0),
      battingStats: scoringState.battingStats || {},
      bowlingStats: scoringState.bowlingStats || {},
      extras: scoringState.extras,
      deliveries,
      fallOfWickets: scoringState.fallOfWickets,
      completedOvers: scoringState.completedOvers,
    };
  };

  const first =
    firstSaved ||
    (Number(scoringState?.inningsIndex) === 0 ? fromScoringState() : null);
  const second =
    secondSaved ||
    (Number(scoringState?.inningsIndex) === 1 ? fromScoringState() : null);

  return [first, second].map((innings, index) => {
    if (!innings) return null;

    const teamId = innings.teamId === "B" || innings.teamId === "A"
      ? innings.teamId
      : index === 0
        ? firstTeamId
        : secondTeamId;
    const fallbackTeam = teams[teamId];
    const deliveries = Array.isArray(innings.deliveries)
      ? innings.deliveries
      : [];

    return {
      ...innings,
      teamId,
      teamName: innings.teamName || fallbackTeam?.name,
      deliveries,
      battingStats: innings.battingStats || {},
      bowlingStats: innings.bowlingStats || {},
    };
  });
};

const getLastRecordedPredictionByOver = ({ match, innings, inningsIndex }) => {
  const deliveries = Array.isArray(innings?.deliveries)
    ? innings.deliveries
    : [];
  if (!deliveries.length) return [];

  const groups = [];
  deliveries.forEach((delivery, deliveryIndex) => {
    const rawOver = Number(delivery?.over);
    const over = Number.isFinite(rawOver)
      ? Math.max(1, Math.floor(rawOver))
      : Math.floor(deliveryIndex / 6) + 1;

    const existing = groups.findIndex((item) => item.over === over);
    if (existing >= 0) {
      groups[existing].lastIndex = deliveryIndex;
    } else {
      groups.push({ over, lastIndex: deliveryIndex });
    }
  });

  const historyMatch = predictionHistoryMatch(match);

  return groups.map(({ over, lastIndex }) => {
    const deliveriesUptoOver = deliveries.slice(0, lastIndex + 1);
    const totals = deliveryHistoryTotals(deliveriesUptoOver);
    const lastDelivery = deliveriesUptoOver[deliveriesUptoOver.length - 1] || {};
    const historyState = {
      ...(innings || {}),
      inningsIndex,
      inningsRuns: totals.runs,
      inningsWickets: totals.wickets,
      legalBalls: totals.legalBalls,
      deliveries: deliveriesUptoOver,
      battingStats: innings?.battingStats || {},
      bowlingStats: innings?.bowlingStats || {},
      strikerId: lastDelivery?.strikerId || "",
      nonStrikerId: lastDelivery?.nonStrikerId || "",
      currentBowlerId: lastDelivery?.bowlerId || "",
    };

    const prediction = getPredictionForDelivery({
      match: historyMatch,
      scoringState: historyState,
      deliveryIndex: deliveriesUptoOver.length - 1,
    });

    return {
      over,
      index: lastIndex,
      prediction,
      score: `${totals.runs}/${totals.wickets}`,
    };
  }).filter((item) => item.prediction);
};

const buildPredictionHistory = ({ match, scoringState }) => {
  const historyMatch = predictionHistoryMatch(match);
  const innings = scorecardHistoryInnings({ match, scoringState });

  const preMatchPrediction = calculateWinPrediction({
    match: historyMatch,
    scoringState: null,
  });

  const records = preMatchPrediction
    ? [{
        key: "before-match",
        label: "BEFORE MATCH",
        subLabel: "Pre-match probability",
        prediction: preMatchPrediction,
      }]
    : [];

  innings.forEach((inningsData, inningsIndex) => {
    if (!inningsData) return;

    const overRecords = getLastRecordedPredictionByOver({
      match,
      innings: inningsData,
      inningsIndex,
    });

    overRecords.forEach((record) => {
      records.push({
        key: `${inningsIndex + 1}-${record.over}-${record.index}`,
        label: `${inningsIndex === 0 ? "1ST INNINGS" : "2ND INNINGS"} • OVER ${record.over}`,
        subLabel: `${inningsData.teamName || `Team ${inningsData.teamId}`} • ${record.score}`,
        prediction: record.prediction,
      });
    });
  });

  const matchFinished =
    String(match?.status || "").toLowerCase() === "finished" ||
    String(match?.status || "").toLowerCase() === "completed" ||
    match?.winner !== undefined && match?.winner !== null ||
    match?.result?.winner !== undefined && match?.result?.winner !== null;

  if (matchFinished) {
    const finalPrediction = calculateWinPrediction({
      match,
      scoringState,
    });

    if (finalPrediction) {
      records.push({
        key: "after-match",
        label: "AFTER MATCH",
        subLabel: "Final recorded result",
        prediction: finalPrediction,
      });
    }
  }

  return records;
};

function PredictionOverHistory({ match, scoringState }) {
  const records = buildPredictionHistory({ match, scoringState });

  if (!records.length) return null;

  return (
    <section className="win-prediction-history">
      <div className="section-title">
        <span>WIN PREDICTION BY OVER</span>
        <small>Before match, every recorded over of both innings, and after match</small>
      </div>

      <div className="win-prediction-history-list">
        {records.map((record) => {
          const prediction = record.prediction;
          const teamA = Math.round(Number(prediction.A || 0));
          const teamB = Math.round(Number(prediction.B || 0));

          return (
            <div className="win-prediction-history-record" key={record.key}>
              <div className="win-prediction-history-record-head">
                <div>
                  <strong>{record.label}</strong>
                  <small>{record.subLabel}</small>
                </div>
                <span>{prediction.phase === "pre-match" ? "PRE-MATCH" : prediction.phase === "finished" ? "FINAL" : "LIVE"}</span>
              </div>

              <div className="win-prediction-history-probabilities">
                <strong>{prediction.teamA} {teamA}%</strong>
                <div className="win-prediction-mini-track" aria-hidden="true">
                  <span style={{ width: `${teamA}%` }} />
                </div>
                <strong>{prediction.teamB} {teamB}%</strong>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const recordedPlayerPerformances = ({ match }) => {
  const teams = [
    match?.teamA || {
      id: "A",
      name: match?.teamAName || "Team A",
      players: match?.teamAPlayers || [],
    },
    match?.teamB || {
      id: "B",
      name: match?.teamBName || "Team B",
      players: match?.teamBPlayers || [],
    },
  ];

  const innings = [match?.firstInningsData, match?.secondInningsData].filter(Boolean);
  const map = new Map();

  const ensurePlayer = (playerId, name, team) => {
    const key = String(playerId || name || "").trim();
    if (!key) return null;
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        name: name || "Unknown Player",
        teamName: team?.name || "Team",
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        wickets: 0,
        legalBalls: 0,
        runsConceded: 0,
      });
    }
    return map.get(key);
  };

  teams.forEach((team) => {
    (team?.players || []).forEach((player) => {
      const id = scorecardPlayerId(player);
      ensurePlayer(id, scorecardPlayerName(player), team);
    });
  });

  innings.forEach((inning) => {
    const battingTeam = teams.find((team) => team?.id === inning?.teamId);
    const bowlingTeam = teams.find((team) => team?.id !== inning?.teamId);
    const battingStats = inning?.battingStats || {};
    const bowlingStats = inning?.bowlingStats || {};

    Object.entries(battingStats).forEach(([id, stats]) => {
      const player = ensurePlayer(
        id,
        stats?.name || stats?.playerName,
        battingTeam
      );
      if (!player) return;
      player.runs += Number(stats?.runs || 0);
      player.balls += Number(stats?.balls || 0);
      player.fours += Number(stats?.fours || 0);
      player.sixes += Number(stats?.sixes || 0);
    });

    Object.entries(bowlingStats).forEach(([id, stats]) => {
      const player = ensurePlayer(
        id,
        stats?.name || stats?.playerName,
        bowlingTeam
      );
      if (!player) return;
      player.wickets += Number(stats?.wickets || 0);
      player.legalBalls += Number((stats?.legalBalls ?? stats?.balls) || 0);
      player.runsConceded += Number(stats?.runs || stats?.runsConceded || 0);
    });
  });

  return [...map.values()].map((player) => {
    const strikeRate = player.balls > 0 ? (player.runs / player.balls) * 100 : 0;
    const economy = player.legalBalls > 0
      ? (player.runsConceded / player.legalBalls) * 6
      : null;

    const battingImpact =
      player.runs +
      player.fours * 0.5 +
      player.sixes * 1.5 +
      (player.balls > 0 ? Math.max(-4, Math.min(4, (strikeRate - 100) * 0.04)) : 0);

    const bowlingImpact =
      player.wickets * 30 +
      (economy == null ? 0 : Math.max(-8, Math.min(8, (6.5 - economy) * 2)));

    return {
      ...player,
      strikeRate,
      economy,
      impact: battingImpact + bowlingImpact,
    };
  });
};

const getPlayerOfTheMatch = (match) => {
  if (!match) return null;

  const finished =
    String(match?.status || "").toLowerCase() === "finished" ||
    String(match?.status || "").toLowerCase() === "completed";
  if (!finished) return null;

  const performances = recordedPlayerPerformances({ match })
    .filter((player) => player.runs > 0 || player.wickets > 0 || player.balls > 0 || player.legalBalls > 0)
    .sort((a, b) => b.impact - a.impact);

  return performances[0] || null;
};

const describeTurningPointDelivery = (delivery) => {
  const wicket = delivery?.wicket;
  if (wicket) {
    const dismissed = wicket?.batterName || "a batter";
    return `${dismissed} dismissed (${wicket?.type || "wicket"})`;
  }

  const runs = Number(delivery?.runs ?? delivery?.batterRuns ?? 0);
  const type = String(delivery?.type || "").toUpperCase();
  if (type === "NB") return `No-ball sequence added ${runs} run${runs === 1 ? "" : "s"}`;
  if (type === "WD") return `Wide added ${runs} run${runs === 1 ? "" : "s"}`;
  if (runs >= 6) return "Six";
  if (runs === 4) return "Four";
  if (runs > 0) return `${runs} run${runs === 1 ? "" : "s"}`;
  return "Dot ball";
};

const getTurningPoint = ({ match, scoringState }) => {
  const historyMatch = predictionHistoryMatch(match);
  const innings = scorecardHistoryInnings({ match, scoringState });
  let best = null;

  innings.forEach((inningsData, inningsIndex) => {
    let previousA = null;
    const deliveries = Array.isArray(inningsData?.deliveries)
      ? inningsData.deliveries
      : [];

    deliveries.forEach((delivery, deliveryIndex) => {
      const upto = deliveries.slice(0, deliveryIndex + 1);
      const totals = deliveryHistoryTotals(upto);
      const state = {
        ...(inningsData || {}),
        inningsIndex,
        inningsRuns: totals.runs,
        inningsWickets: totals.wickets,
        legalBalls: totals.legalBalls,
        deliveries: upto,
        battingStats: inningsData?.battingStats || {},
        bowlingStats: inningsData?.bowlingStats || {},
        strikerId: delivery?.strikerId || "",
        nonStrikerId: delivery?.nonStrikerId || "",
        currentBowlerId: delivery?.bowlerId || "",
      };

      const prediction = getPredictionForDelivery({
        match: historyMatch,
        scoringState: state,
        deliveryIndex,
      });
      if (!prediction) return;

      const currentA = Number(prediction.A || 0);
      const change = previousA == null ? 0 : Math.abs(currentA - previousA);

      if (previousA != null && (!best || change > best.change)) {
        best = {
          innings: inningsIndex + 1,
          over: Number(delivery?.over || Math.floor(deliveryIndex / 6) + 1),
          ball: Number(delivery?.ball || (deliveryIndex % 6) + 1),
          change,
          from: previousA,
          to: currentA,
          delivery,
          summary: describeTurningPointDelivery(delivery),
        };
      }

      previousA = currentA;
    });
  });

  return best;
};

function MatchMatchImpactSections({ match, scoringState }) {
  const player = getPlayerOfTheMatch(match);
  const turningPoint = getTurningPoint({ match, scoringState });
  const finished =
    String(match?.status || "").toLowerCase() === "finished" ||
    String(match?.status || "").toLowerCase() === "completed";

  return (
    <div className="match-impact-sections">
      <section className="match-impact-card">
        <div className="section-title">
          <span>PLAYER OF THE MATCH</span>
          <small>{finished ? "Calculated from the recorded scorecard" : "Available after the match is finished"}</small>
        </div>

        {player ? (
          <div className="match-impact-content">
            <strong>{player.name}</strong>
            <span>{player.teamName}</span>
            <div className="match-impact-stats">
              {player.runs > 0 && <small>{player.runs} runs</small>}
              {player.wickets > 0 && <small>{player.wickets} wicket{player.wickets === 1 ? "" : "s"}</small>}
              {player.balls > 0 && <small>SR {player.strikeRate.toFixed(1)}</small>}
              {player.legalBalls > 0 && player.economy != null && <small>Eco {player.economy.toFixed(2)}</small>}
            </div>
          </div>
        ) : (
          <p className="match-impact-empty">Player of the match will appear here after a completed match with recorded player statistics.</p>
        )}
      </section>

      <section className="match-impact-card">
        <div className="section-title">
          <span>TURNING POINT OF THE MATCH</span>
          <small>{turningPoint ? "Largest recorded change in win probability" : "Built from recorded deliveries"}</small>
        </div>

        {turningPoint ? (
          <div className="match-impact-content">
            <strong>{turningPoint.summary}</strong>
            <span>{turningPoint.innings === 1 ? "1st innings" : "2nd innings"} • Over {turningPoint.over} • Ball {turningPoint.ball}</span>
            <div className="match-turning-point-probability">
              <small>{match?.teamA?.name || match?.teamAName || "Team A"} {turningPoint.from.toFixed(1)}% → {turningPoint.to.toFixed(1)}%</small>
              <small>Change {turningPoint.change.toFixed(1)}%</small>
            </div>
          </div>
        ) : (
          <p className="match-impact-empty">The turning point will appear here after recorded deliveries are available.</p>
        )}
      </section>
    </div>
  );
}

function MatchInningsScorecard({ innings, battingTeam, bowlingTeam }) {
  if (!battingTeam) return null;

  const data = innings || {};
  const battingStats = data.battingStats || {};
  const bowlingStats = data.bowlingStats || {};
  const extras = data.extras || { nb: 0, wd: 0, bye: 0, lb: 0 };
  const fallOfWickets = Array.isArray(data.fallOfWickets)
    ? data.fallOfWickets
    : [];

  const batters = (battingTeam.players || []).map((player, index) => {
    const stats = battingStats[scorecardPlayerId(player)] || {};

    return {
      id: scorecardPlayerId(player),
      name: stats.name || scorecardPlayerName(player),
      battingOrder: stats.battingOrder || index + 1,
      runs: Number(stats.runs || 0),
      balls: Number(stats.balls || 0),
      fours: Number(stats.fours || 0),
      sixes: Number(stats.sixes || 0),
      status: stats.status || "yet",
      dismissal: stats.dismissal || "",
      fielder: stats.fielder || "",
      bowler: stats.bowler || "",
    };
  });

  const played = batters.filter(
    (batter) =>
      batter.status !== "yet" ||
      batter.balls > 0 ||
      batter.runs > 0
  );

  const yetToBat = batters.filter(
    (batter) => batter.status === "yet" && !batter.balls && !batter.runs
  );

  const bowlers = (bowlingTeam?.players || [])
    .map((player) => {
      const stats = bowlingStats[scorecardPlayerId(player)] || {};

      return {
        id: scorecardPlayerId(player),
        name: stats.name || scorecardPlayerName(player),
        legalBalls: Number(stats.legalBalls || 0),
        runs: Number(stats.runs || 0),
        maidens: Number(stats.maidens || 0),
        wickets: Number(stats.wickets || 0),
      };
    })
    .filter(
      (bowler) =>
        bowler.legalBalls || bowler.runs || bowler.wickets
    );

  const totalExtras =
    Number(extras.nb || 0) +
    Number(extras.wd || 0) +
    Number(extras.bye || 0) +
    Number(extras.lb || 0);

  return (
    <section className="match-innings-scorecard">
      <div className="match-innings-heading">
        <div>
          <p className="eyebrow">INNINGS</p>
          <small>{battingTeam.name}</small>
        </div>
        <strong>
          {Number(data.runs ?? 0)}/{Number(data.wickets ?? 0)}
        </strong>
      </div>

      <div className="match-scorecard-block">
        <h4>Batting</h4>
        <div className="match-scorecard-table-wrap">
          <table className="match-scorecard-table">
            <thead>
              <tr>
                <th>Batter</th>
                <th>R</th>
                <th>B</th>
                <th>4s</th>
                <th>6s</th>
                <th>SR</th>
              </tr>
            </thead>
            <tbody>
              {played.length ? played.map((batter) => (
                <tr key={batter.id}>
                  <td>
                    <strong>{batter.name}</strong>
                    <small>
                      {batter.status === "out"
                        ? `out • ${batter.dismissal}${batter.fielder ? ` • ${batter.fielder}` : ""}`
                        : batter.status === "retired hurt"
                          ? "Retired hurt"
                          : "not out"}
                      {batter.bowler ? ` • Bowler: ${batter.bowler}` : ""}
                    </small>
                  </td>
                  <td>{batter.runs}</td>
                  <td>{batter.balls}</td>
                  <td>{batter.fours}</td>
                  <td>{batter.sixes}</td>
                  <td>{scorecardStrikeRate(batter.runs, batter.balls)}</td>
                </tr>
              )) : (
                <tr><td colSpan="6" className="match-scorecard-empty">No batting data saved</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="match-scorecard-block">
        <h4>Yet to Bat</h4>
        <p className="match-scorecard-note">
          {yetToBat.length ? yetToBat.map((batter) => batter.name).join(", ") : "None"}
        </p>
      </div>

      <div className="match-scorecard-block">
        <h4>Fall of Wickets</h4>
        {fallOfWickets.length ? (
          <div className="match-fow-list">
            {fallOfWickets.map((item) => (
              <span key={`${item.wicket}-${item.score}-${item.batter}`}>
                {item.wicket}-{item.score} ({item.batter}, {item.over})
              </span>
            ))}
          </div>
        ) : <p className="match-scorecard-note">No wickets</p>}
      </div>

      <div className="match-scorecard-block">
        <h4>Extras</h4>
        <p className="match-scorecard-note">
          NB {extras.nb || 0}, WD {extras.wd || 0}, BYE {extras.bye || 0}, LB {extras.lb || 0} • Total {totalExtras}
        </p>
      </div>

      <div className="match-scorecard-block">
        <h4>Bowling</h4>
        <div className="match-scorecard-table-wrap">
          <table className="match-scorecard-table">
            <thead>
              <tr>
                <th>Bowler</th>
                <th>O</th>
                <th>M</th>
                <th>R</th>
                <th>W</th>
                <th>Econ</th>
              </tr>
            </thead>
            <tbody>
              {bowlers.length ? bowlers.map((bowler) => (
                <tr key={bowler.id}>
                  <td><strong>{bowler.name}</strong></td>
                  <td>{scorecardOvers(bowler.legalBalls)}</td>
                  <td>{bowler.maidens}</td>
                  <td>{bowler.runs}</td>
                  <td>{bowler.wickets}</td>
                  <td>{scorecardEconomy(bowler.runs, bowler.legalBalls)}</td>
                </tr>
              )) : (
                <tr><td colSpan="6" className="match-scorecard-empty">No bowling data saved</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}



/* =========================================================
   FINISHED MATCH ANALYSIS GRAPHS
   ---------------------------------------------------------
   1. Match prediction throughout the match
   2. Batter performance - both teams
   3. Bowler performance - both teams

   Only displayed after the match is finished.
========================================================= */

function FinishedMatchAnalysisGraphs({ match }) {
  if (!match) return null;

  const finished =
    String(match?.status || "").toLowerCase() === "finished" ||
    String(match?.status || "").toLowerCase() === "completed";

  if (!finished) return null;


  const teamA =
    match.teamA || {
      id: "A",
      name: match.teamAName || "Team A",
      players: match.teamAPlayers || [],
    };

  const teamB =
    match.teamB || {
      id: "B",
      name: match.teamBName || "Team B",
      players: match.teamBPlayers || [],
    };


  /* =======================================================
     TEAM HELPERS
  ======================================================= */

  const getTeamName = (team) =>
    team?.name ||
    "Team";


  const getTeamId = (team) =>
    String(
      team?.id ??
      team?.teamId ??
      ""
    );


  const teamAName =
    getTeamName(teamA);

  const teamBName =
    getTeamName(teamB);


  /* =======================================================
     INNINGS
  ======================================================= */

  const innings = [
    match.firstInningsData,
    match.secondInningsData,
  ].filter(Boolean);


  /* =======================================================
     1. MATCH PREDICTION DATA
     -------------------------------------------------------
     One point after every recorded delivery.

     Team A and Team B are kept in the same graph.
  ======================================================= */

  const predictionPoints = [];


  innings.forEach(
    (inningsData, inningsIndex) => {
      const deliveries =
        Array.isArray(
          inningsData?.deliveries
        )
          ? inningsData.deliveries
          : [];


      deliveries.forEach(
        (delivery, deliveryIndex) => {
          if (!deliveries.length) {
            return;
          }


          const upto =
            deliveries.slice(
              0,
              deliveryIndex + 1
            );


          const totals =
            deliveryHistoryTotals(
              upto
            );


          const state = {
            ...(inningsData || {}),

            inningsIndex,

            inningsRuns:
              totals.runs,

            inningsWickets:
              totals.wickets,

            legalBalls:
              totals.legalBalls,

            deliveries:
              upto,

            battingStats:
              inningsData?.battingStats ||
              {},

            bowlingStats:
              inningsData?.bowlingStats ||
              {},

            strikerId:
              delivery?.strikerId ||
              "",

            nonStrikerId:
              delivery?.nonStrikerId ||
              "",

            currentBowlerId:
              delivery?.bowlerId ||
              "",
          };


          const prediction =
            getPredictionForDelivery({
              match:
                predictionHistoryMatch(
                  match
                ),

              scoringState:
                state,

              deliveryIndex,
            });


          if (!prediction) {
            return;
          }


          const globalIndex =
            predictionPoints.length;


          predictionPoints.push({
            index:
              globalIndex + 1,

            innings:
              inningsIndex + 1,

            over:
              Number(
                delivery?.over ||
                Math.floor(
                  deliveryIndex / 6
                ) + 1
              ),

            ball:
              Number(
                delivery?.ball ||
                (deliveryIndex % 6) + 1
              ),

            teamA:
              Number(
                prediction.A || 0
              ),

            teamB:
              Number(
                prediction.B || 0
              ),
          });
        }
      );
    }
  );


  /* =======================================================
     2. BATTER PERFORMANCE DATA
     -------------------------------------------------------
     Uses the same recorded scorecard statistics already
     used by the existing Player of the Match section.
  ======================================================= */

  const performances =
    recordedPlayerPerformances({
      match,
    });


  const teamAPlayers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamAName)
      )
      .filter(
        (player) =>
          player.runs > 0 ||
          player.balls > 0
      )
      .sort(
        (a, b) =>
          b.runs - a.runs
      );


  const teamBPlayers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamBName)
      )
      .filter(
        (player) =>
          player.runs > 0 ||
          player.balls > 0
      )
      .sort(
        (a, b) =>
          b.runs - a.runs
      );


  /*
   * Keep every recorded batter.
   *
   * The graph container becomes horizontally scrollable
   * on very small screens instead of hiding players.
   */

  const batterPlayers = [
    ...teamAPlayers.map(
      (player) => ({
        ...player,
        graphTeam: "A",
      })
    ),

    ...teamBPlayers.map(
      (player) => ({
        ...player,
        graphTeam: "B",
      })
    ),
  ];


  /* =======================================================
     3. BOWLER PERFORMANCE DATA
     -------------------------------------------------------
     Primary metric = wickets.

     Economy is retained for tooltip information.
  ======================================================= */

  const teamABowlers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamAName)
      )
      .filter(
        (player) =>
          player.wickets > 0 ||
          player.legalBalls > 0
      )
      .sort(
        (a, b) => {
          if (
            b.wickets !==
            a.wickets
          ) {
            return (
              b.wickets -
              a.wickets
            );
          }

          return (
            (a.economy ?? 999) -
            (b.economy ?? 999)
          );
        }
      );


  const teamBBowlers =
    performances
      .filter(
        (player) =>
          String(
            player.teamName
          ) ===
          String(teamBName)
      )
      .filter(
        (player) =>
          player.wickets > 0 ||
          player.legalBalls > 0
      )
      .sort(
        (a, b) => {
          if (
            b.wickets !==
            a.wickets
          ) {
            return (
              b.wickets -
              a.wickets
            );
          }

          return (
            (a.economy ?? 999) -
            (b.economy ?? 999)
          );
        }
      );


  const bowlerPlayers = [
    ...teamABowlers.map(
      (player) => ({
        ...player,
        graphTeam: "A",
      })
    ),

    ...teamBBowlers.map(
      (player) => ({
        ...player,
        graphTeam: "B",
      })
    ),
  ];


  /* =======================================================
     EMPTY GRAPH HANDLER
  ======================================================= */

  const GraphEmpty = ({
    message,
  }) => (
    <div className="match-analysis-empty">
      {message}
    </div>
  );


  /* =======================================================
     GRAPH POINT GENERATOR
  ======================================================= */

  const createPoints = (
    values,
    maxValue,
    width,
    height,
    padding
  ) => {
    if (!values.length) {
      return [];
    }


    const usableWidth =
      width -
      padding.left -
      padding.right;


    const usableHeight =
      height -
      padding.top -
      padding.bottom;


    const step =
      values.length === 1
        ? 0
        : usableWidth /
          (values.length - 1);


    return values.map(
      (value, index) => {
        const safeValue =
          Math.max(
            0,
            Number(value) || 0
          );


        const x =
          padding.left +
          index * step;


        const y =
          padding.top +
          usableHeight -
          (safeValue /
            Math.max(
              maxValue,
              1
            )) *
            usableHeight;


        return {
          x,
          y,
          value:
            safeValue,
        };
      }
    );
  };


  /* =======================================================
     LINE PATH
  ======================================================= */

  const createLinePath = (
    points
  ) => {
    if (!points.length) {
      return "";
    }


    return points
      .map(
        (point, index) =>
          `${
            index === 0
              ? "M"
              : "L"
          } ${point.x} ${point.y}`
      )
      .join(" ");
  };


  /* =======================================================
     GRAPH CONSTANTS
  ======================================================= */

  const chartWidth = 1000;
  const chartHeight = 300;

  const chartPadding = {
    left: 48,
    right: 24,
    top: 25,
    bottom: 45,
  };


  /* =======================================================
     PREDICTION GRAPH
  ======================================================= */

  const predictionMax = 100;

  const predictionA =
    createPoints(
      predictionPoints.map(
        (point) =>
          point.teamA
      ),
      predictionMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  const predictionB =
    createPoints(
      predictionPoints.map(
        (point) =>
          point.teamB
      ),
      predictionMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  /* =======================================================
     BATTER GRAPH
  ======================================================= */

  const batterMax =
    Math.max(
      ...batterPlayers.map(
        (player) =>
          Number(
            player.runs || 0
          )
      ),
      10
    );


  const batterPoints =
    createPoints(
      batterPlayers.map(
        (player) =>
          Number(
            player.runs || 0
          )
      ),
      batterMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  /* =======================================================
     BOWLER GRAPH
  ======================================================= */

  const bowlerMax =
    Math.max(
      ...bowlerPlayers.map(
        (player) =>
          Number(
            player.wickets || 0
          )
      ),
      1
    );


  const bowlerPoints =
    createPoints(
      bowlerPlayers.map(
        (player) =>
          Number(
            player.wickets || 0
          )
      ),
      bowlerMax,
      chartWidth,
      chartHeight,
      chartPadding
    );


  /* =======================================================
     Y-AXIS LABELS
  ======================================================= */

  const PredictionYAxis = () => (
    <>
      <text
        x="15"
        y="31"
        className="match-analysis-axis-label"
      >
        100%
      </text>

      <text
        x="23"
        y="150"
        className="match-analysis-axis-label"
      >
        50%
      </text>

      <text
        x="30"
        y="272"
        className="match-analysis-axis-label"
      >
        0%
      </text>
    </>
  );


  /* =======================================================
     PERFORMANCE Y AXIS
  ======================================================= */

  const PerformanceYAxis = ({
    max,
    suffix = "",
  }) => (
    <>
      <text
        x="18"
        y="31"
        className="match-analysis-axis-label"
      >
        {max}
        {suffix}
      </text>

      <text
        x="23"
        y="150"
        className="match-analysis-axis-label"
      >
        {Math.round(
          max / 2
        )}
        {suffix}
      </text>

      <text
        x="30"
        y="272"
        className="match-analysis-axis-label"
      >
        0{suffix}
      </text>
    </>
  );


  return (
    <section className="finished-match-analysis">

  <div className="finished-match-analysis-header">

    <div>
      <p className="finished-match-analysis-eyebrow">
        MATCH ANALYSIS
      </p>

      <h3>
        Match Performance Graphs
      </h3>

      <small>
        Detailed visual analysis from the completed scorecard
      </small>
    </div>

    <span className="finished-analysis-badge">
      COMPLETED
    </span>

  </div>


  {/* =================================================
      GRAPH 1
  ================================================== */}

  <div className="match-analysis-chart-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Win Prediction Throughout Match
        </strong>

        <small>
          Probability movement after each recorded delivery
        </small>
      </div>

      <div className="match-analysis-legend">

        <span>
          <i className="legend-team-a" />
          {teamAName}
        </span>

        <span>
          <i className="legend-team-b" />
          {teamBName}
        </span>

      </div>

    </div>


    {predictionPoints.length ? (
      <div className="match-analysis-chart-scroll">

        <svg
          className="match-analysis-svg"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Match win prediction graph"
        >

          {/* Grid */}

          <line
            x1={chartPadding.left}
            y1="25"
            x2={chartWidth - chartPadding.right}
            y2="25"
            className="analysis-grid-line"
          />

          <line
            x1={chartPadding.left}
            y1="150"
            x2={chartWidth - chartPadding.right}
            y2="150"
            className="analysis-grid-line"
          />

          <line
            x1={chartPadding.left}
            y1="275"
            x2={chartWidth - chartPadding.right}
            y2="275"
            className="analysis-grid-line"
          />


          <PredictionYAxis />


          {/* Team A */}

          <path
            d={createLinePath(
              predictionA
            )}
            className="analysis-line team-a-line"
            fill="none"
          />


          {/* Team B */}

          <path
            d={createLinePath(
              predictionB
            )}
            className="analysis-line team-b-line"
            fill="none"
          />


          {/* Team A points */}

          {predictionA.map(
            (point, index) => (
              <circle
                key={`prediction-a-${index}`}
                cx={point.x}
                cy={point.y}
                r="3.2"
                className="analysis-point team-a-point"
              >
                <title>
                  Over{" "}
                  {
                    predictionPoints[
                      index
                    ]?.over
                  }
                  .
                  {
                    predictionPoints[
                      index
                    ]?.ball
                  }{" "}
                  •{" "}
                  {teamAName}:{" "}
                  {point.value.toFixed(
                    1
                  )}
                  %
                </title>
              </circle>
            )
          )}


          {/* Team B points */}

          {predictionB.map(
            (point, index) => (
              <circle
                key={`prediction-b-${index}`}
                cx={point.x}
                cy={point.y}
                r="3.2"
                className="analysis-point team-b-point"
              >
                <title>
                  Over{" "}
                  {
                    predictionPoints[
                      index
                    ]?.over
                  }
                  .
                  {
                    predictionPoints[
                      index
                    ]?.ball
                  }{" "}
                  •{" "}
                  {teamBName}:{" "}
                  {point.value.toFixed(
                    1
                  )}
                  %
                </title>
              </circle>
            )
          )}

        </svg>

      </div>
    ) : (
      <GraphEmpty
        message="Prediction data is not available for this completed match."
      />
    )}

  </div>


  {/* =================================================
      GRAPH 2 - BATTER RUNS BAR GRAPH
  ================================================== */}

  <div className="match-analysis-chart-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Batter Performance
        </strong>

        <small>
          Runs scored by every recorded batter from both innings
        </small>
      </div>

      <div className="match-analysis-legend">

        <span>
          <i className="legend-team-a" />
          {teamAName}
        </span>

        <span>
          <i className="legend-team-b" />
          {teamBName}
        </span>

      </div>

    </div>


    {batterPlayers.length ? (
      <div className="match-analysis-chart-scroll">

        <svg
          className="match-analysis-svg performance-svg batter-bar-svg"
          viewBox={`0 0 ${Math.max(
            chartWidth,
            batterPlayers.length * 75
          )} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Batter runs bar graph"
        >

          {(() => {

            const graphWidth = Math.max(
              chartWidth,
              batterPlayers.length * 75
            );

            const graphLeft =
              chartPadding.left;

            const graphRight =
              graphWidth -
              chartPadding.right;

            const graphTop = 25;
            const graphBottom = 265;
            const graphHeight =
              graphBottom - graphTop;

            const maxRuns = Math.max(
              10,
              ...batterPlayers.map(
                (player) =>
                  Number(
                    player.runs || 0
                  )
              )
            );

            const slotWidth =
              (graphRight - graphLeft) /
              Math.max(
                batterPlayers.length,
                1
              );

            const barWidth =
              Math.min(
                38,
                slotWidth * 0.55
              );

            return (
              <>

                {/* Grid */}

                <line
                  x1={graphLeft}
                  y1={graphTop}
                  x2={graphRight}
                  y2={graphTop}
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={
                    graphTop +
                    graphHeight / 2
                  }
                  x2={graphRight}
                  y2={
                    graphTop +
                    graphHeight / 2
                  }
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={graphBottom}
                  x2={graphRight}
                  y2={graphBottom}
                  className="analysis-grid-line"
                />


                {/* Y Axis */}

                <text
                  x="10"
                  y={graphTop + 4}
                  className="analysis-axis-label"
                >
                  {maxRuns}
                </text>

                <text
                  x="10"
                  y={
                    graphTop +
                    graphHeight / 2 +
                    4
                  }
                  className="analysis-axis-label"
                >
                  {Math.round(
                    maxRuns / 2
                  )}
                </text>

                <text
                  x="10"
                  y={graphBottom + 4}
                  className="analysis-axis-label"
                >
                  0
                </text>


                {/* Bars */}

                {batterPlayers.map(
                  (player, index) => {

                    const runs = Number(
                      player.runs || 0
                    );

                    const barHeight =
                      maxRuns > 0
                        ? (runs / maxRuns) *
                          graphHeight
                        : 0;

                    const x =
                      graphLeft +
                      slotWidth * index +
                      slotWidth / 2 -
                      barWidth / 2;

                    const y =
                      graphBottom -
                      barHeight;

                    const teamClass =
                      player.graphTeam ===
                      "A"
                        ? "team-a-bar"
                        : "team-b-bar";

                    return (
                      <g
                        key={`batter-bar-${player.id}-${index}`}
                      >

                        {/* Bar */}

                        <rect
                          x={x}
                          y={y}
                          width={barWidth}
                          height={Math.max(
                            barHeight,
                            runs > 0 ? 3 : 1
                          )}
                          rx="6"
                          ry="6"
                          className={`analysis-bar ${teamClass}`}
                        >
                          <title>
                            {player.name} •{" "}
                            {runs} runs
                            {player.balls != null
                              ? ` • ${player.balls} balls`
                              : ""}
                            {player.strikeRate != null
                              ? ` • SR ${Number(
                                  player.strikeRate
                                ).toFixed(1)}`
                              : ""}
                          </title>
                        </rect>


                        {/* Run value */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y={Math.max(
                            y - 7,
                            15
                          )}
                          textAnchor="middle"
                          className="analysis-bar-value"
                        >
                          {runs}
                        </text>


                        {/* Player name */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y="292"
                          textAnchor="middle"
                          className={
                            player.graphTeam ===
                            "A"
                              ? "analysis-player-label team-a-label"
                              : "analysis-player-label team-b-label"
                          }
                        >
                          {String(
                            player.name ||
                              "Player"
                          ).slice(
                            0,
                            10
                          )}
                        </text>

                      </g>
                    );
                  }
                )}

              </>
            );

          })()}

        </svg>

      </div>
    ) : (
      <GraphEmpty
        message="No recorded batting performance is available."
      />
    )}

  </div>


  {/* =================================================
      GRAPH 3 - BOWLER WICKETS + ECONOMY
  ================================================== */}

  <div className="match-analysis-chart-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Bowler Performance
        </strong>

        <small>
          Wickets and economy of recorded bowlers from both teams
        </small>
      </div>

      <div className="match-analysis-legend">

        <span>
          <i className="legend-team-a" />
          {teamAName}
        </span>

        <span>
          <i className="legend-team-b" />
          {teamBName}
        </span>

      </div>

    </div>


    {bowlerPlayers.length ? (
      <div className="match-analysis-chart-scroll">

        <svg
          className="match-analysis-svg performance-svg bowler-bar-svg"
          viewBox={`0 0 ${Math.max(
            chartWidth,
            bowlerPlayers.length * 85
          )} ${chartHeight}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Bowler wickets and economy graph"
        >

          {(() => {

            const graphWidth = Math.max(
              chartWidth,
              bowlerPlayers.length * 85
            );

            const graphLeft =
              chartPadding.left;

            const graphRight =
              graphWidth -
              chartPadding.right;

            const graphTop = 25;
            const graphBottom = 265;
            const graphHeight =
              graphBottom - graphTop;

            const maxWickets = Math.max(
              1,
              ...bowlerPlayers.map(
                (player) =>
                  Number(
                    player.wickets || 0
                  )
              )
            );

            const slotWidth =
              (graphRight - graphLeft) /
              Math.max(
                bowlerPlayers.length,
                1
              );

            const barWidth =
              Math.min(
                34,
                slotWidth * 0.48
              );

            return (
              <>

                {/* Grid */}

                <line
                  x1={graphLeft}
                  y1={graphTop}
                  x2={graphRight}
                  y2={graphTop}
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={
                    graphTop +
                    graphHeight / 2
                  }
                  x2={graphRight}
                  y2={
                    graphTop +
                    graphHeight / 2
                  }
                  className="analysis-grid-line"
                />

                <line
                  x1={graphLeft}
                  y1={graphBottom}
                  x2={graphRight}
                  y2={graphBottom}
                  className="analysis-grid-line"
                />


                {/* Y Axis */}

                <text
                  x="8"
                  y={graphTop + 4}
                  className="analysis-axis-label"
                >
                  {maxWickets}
                </text>

                <text
                  x="8"
                  y={
                    graphTop +
                    graphHeight / 2 +
                    4
                  }
                  className="analysis-axis-label"
                >
                  {Math.round(
                    maxWickets / 2
                  )}
                </text>

                <text
                  x="8"
                  y={graphBottom + 4}
                  className="analysis-axis-label"
                >
                  0
                </text>


                {/* Wickets bars */}

                {bowlerPlayers.map(
                  (player, index) => {

                    const wickets =
                      Number(
                        player.wickets || 0
                      );

                    const economy =
                      Number(
                        player.economy || 0
                      );

                    const barHeight =
                      maxWickets > 0
                        ? (wickets /
                            maxWickets) *
                          graphHeight
                        : 0;

                    const x =
                      graphLeft +
                      slotWidth * index +
                      slotWidth / 2 -
                      barWidth / 2;

                    const y =
                      graphBottom -
                      barHeight;

                    const teamClass =
                      player.graphTeam ===
                      "A"
                        ? "team-a-bar"
                        : "team-b-bar";

                    return (
                      <g
                        key={`bowler-bar-${player.id}-${index}`}
                      >

                        {/* Wicket bar */}

                        <rect
                          x={x}
                          y={y}
                          width={barWidth}
                          height={Math.max(
                            barHeight,
                            wickets > 0
                              ? 3
                              : 1
                          )}
                          rx="6"
                          ry="6"
                          className={`analysis-bar ${teamClass}`}
                        >
                          <title>
                            {player.name} •{" "}
                            {wickets} wickets •
                            Economy{" "}
                            {economy.toFixed(
                              2
                            )}
                          </title>
                        </rect>


                        {/* Wicket value */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y={Math.max(
                            y - 7,
                            15
                          )}
                          textAnchor="middle"
                          className="analysis-bar-value"
                        >
                          {wickets}W
                        </text>


                        {/* Economy */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y="280"
                          textAnchor="middle"
                          className="analysis-economy-label"
                        >
                          Eco{" "}
                          {economy.toFixed(
                            2
                          )}
                        </text>


                        {/* Bowler name */}

                        <text
                          x={
                            x +
                            barWidth / 2
                          }
                          y="295"
                          textAnchor="middle"
                          className={
                            player.graphTeam ===
                            "A"
                              ? "analysis-player-label team-a-label"
                              : "analysis-player-label team-b-label"
                          }
                        >
                          {String(
                            player.name ||
                              "Player"
                          ).slice(
                            0,
                            9
                          )}
                        </text>

                      </g>
                    );
                  }
                )}

              </>
            );

          })()}

        </svg>

      </div>
    ) : (
      <GraphEmpty
        message="No recorded bowling performance is available."
      />
    )}

  </div>


  {/* =================================================
      PARTNERSHIP ANALYSIS - BOTH INNINGS
  ================================================== */}

  <div className="match-analysis-chart-card partnership-analysis-card">

    <div className="match-analysis-chart-header">

      <div>
        <strong>
          Batting Partnerships
        </strong>

        <small>
          Partnerships between batters in both innings
        </small>
      </div>

    </div>


    {(() => {

      const buildPartnerships = (
        innings,
        inningsNumber
      ) => {

        if (
          !innings ||
          !Array.isArray(
            innings.deliveries
          )
        ) {
          return [];
        }

        const deliveries =
          innings.deliveries;

        const partnerships = [];

        let currentPair = null;
        let currentRuns = 0;
        let currentBalls = 0;

        const getPlayerName = (
          playerId
        ) => {

          if (!playerId) {
            return "";
          }

          const player =
            [
              ...(teamA?.players || []),
              ...(teamB?.players || [])
            ].find(
              (item) =>
                String(
                  scorecardPlayerId(
                    item
                  )
                ) ===
                String(playerId)
            );

          return (
            player?.name ||
            player?.displayName ||
            player?.playerName ||
            String(playerId)
          );
        };


        const savePartnership = () => {

          if (!currentPair) {
            return;
          }

          partnerships.push({
            innings:
              inningsNumber,

            striker:
              currentPair.striker,

            nonStriker:
              currentPair.nonStriker,

            strikerName:
              getPlayerName(
                currentPair.striker
              ) || "Batter",

            nonStrikerName:
              getPlayerName(
                currentPair.nonStriker
              ) || "Batter",

            runs: currentRuns,

            balls: currentBalls,
          });
        };


        deliveries.forEach(
          (delivery) => {

            const striker =
              delivery?.strikerId ||
              delivery?.batterId ||
              delivery?.batsmanId ||
              "";

            const nonStriker =
              delivery?.nonStrikerId ||
              delivery?.nonStriker ||
              "";

            /*
             * If only one batter is recorded,
             * show the same name on both sides.
             */

            const effectiveNonStriker =
              nonStriker ||
              striker;

            const pairKey =
              [
                String(striker),
                String(
                  effectiveNonStriker
                ),
              ]
                .sort()
                .join("-");


            if (
              currentPair &&
              currentPair.key !==
                pairKey
            ) {
              savePartnership();

              currentRuns = 0;
              currentBalls = 0;
            }


            if (
              !currentPair ||
              currentPair.key !==
                pairKey
            ) {
              currentPair = {
                key: pairKey,
                striker,
                nonStriker:
                  effectiveNonStriker,
              };
            }


            const deliveryRuns =
              Number(
                delivery?.runs?.total ??
                delivery?.totalRuns ??
                delivery?.runs ??
                0
              );

            currentRuns +=
              Number.isFinite(
                deliveryRuns
              )
                ? deliveryRuns
                : 0;


            /*
             * Count recorded deliveries.
             */

            currentBalls += 1;

          }
        );


        savePartnership();

        return partnerships;
      };


      const firstPartnerships =
        buildPartnerships(
          match?.firstInningsData,
          1
        );

      const secondPartnerships =
        buildPartnerships(
          match?.secondInningsData,
          2
        );


      const allPartnerships = [
        ...firstPartnerships,
        ...secondPartnerships,
      ];


      if (!allPartnerships.length) {
        return (
          <GraphEmpty
            message="Partnership data is not available for this completed match."
          />
        );
      }


      return (
        <div className="partnership-list">

          {[
            {
              title:
                "1st Innings",
              team:
                match
                  ?.firstInningsData
                  ?.teamName ||
                teamAName,
              items:
                firstPartnerships,
            },

            {
              title:
                "2nd Innings",
              team:
                match
                  ?.secondInningsData
                  ?.teamName ||
                teamBName,
              items:
                secondPartnerships,
            },
          ].map(
            (
              inningsData,
              inningsIndex
            ) => (

              <div
                className="partnership-innings"
                key={`partnership-innings-${inningsIndex}`}
              >

                <div className="partnership-innings-header">

                  <strong>
                    {inningsData.title}
                  </strong>

                  <span>
                    {inningsData.team}
                  </span>

                </div>


                {inningsData.items
                  .length ? (

                  <div className="partnership-items">

                    {inningsData.items.map(
                      (
                        partnership,
                        index
                      ) => (

                        <div
                          className="partnership-item"
                          key={`partnership-${inningsIndex}-${index}`}
                        >

                          <div className="partnership-batters">

                            <div className="partnership-player">
                              <span className="partnership-player-name">
                                {
                                  partnership.strikerName
                                }
                              </span>
                            </div>

                            <div className="partnership-vs">
                              +
                            </div>

                            <div className="partnership-player">
                              <span className="partnership-player-name">
                                {
                                  partnership.nonStrikerName
                                }
                              </span>
                            </div>

                          </div>


                          <div className="partnership-score">

                            <strong>
                              {
                                partnership.runs
                              }
                            </strong>

                            <span>
                              runs
                            </span>

                          </div>


                          <div className="partnership-balls">
                            {
                              partnership.balls
                            }{" "}
                            balls
                          </div>

                        </div>

                      )
                    )}

                  </div>

                ) : (

                  <div className="partnership-empty">
                    No partnership data recorded for this innings.
                  </div>

                )}

              </div>

            )
          )}

        </div>
      );

    })()}

  </div>

</section>
  );
}

function MatchScorecard({ match }) {
  const [activeInnings, setActiveInnings] = useState("first");
  const teamA = match.teamA || { id: "A", name: match.teamAName, players: match.teamAPlayers || [] };
  const teamB = match.teamB || { id: "B", name: match.teamBName, players: match.teamBPlayers || [] };
  const savedState = match.scoringState || {};
  const liveTeamId = savedState.inningsIndex === 1
    ? (match.battingTeamId === "A" ? "B" : "A")
    : match.battingTeamId || "A";
  const liveInnings = savedState.battingStats
    ? {
        teamId: liveTeamId,
        teamName: liveTeamId === "A" ? teamA.name : teamB.name,
        runs: savedState.inningsRuns ?? (liveTeamId === "A" ? match.scoreA : match.scoreB) ?? 0,
        wickets: savedState.inningsWickets ?? 0,
        balls: savedState.legalBalls ?? 0,
        battingStats: savedState.battingStats,
        bowlingStats: savedState.bowlingStats,
        extras: savedState.extras,
        deliveries: savedState.deliveries,
        fallOfWickets: savedState.fallOfWickets,
        completedOvers: savedState.completedOvers,
      }
    : null;
  const firstTeamId = match.firstInningsData?.teamId ||
    (match.firstInningsTeamId === "B" ? "B" : "A");
  const secondTeamId = firstTeamId === "A" ? "B" : "A";
  const firstInnings = match.firstInningsData || (
    savedState.inningsIndex === 0 ? liveInnings : null
  );
  const secondInnings = match.secondInningsData || (
    savedState.inningsIndex === 1 ? liveInnings : null
  );

  const tossResult = match.secondTossResult || null;
  const tossWinner = match.secondTossWinner;

  const inningsFor = (data, defaultBattingTeam) => {
    const battingTeam = data?.teamId === "B" ? teamB : data?.teamId === "A" ? teamA : defaultBattingTeam;
    const bowlingTeam = battingTeam.id === "A" ? teamB : teamA;

    return (
      <MatchInningsScorecard
        key={`${battingTeam.id}-${data?.teamId || "saved"}`}
        innings={data}
        battingTeam={battingTeam}
        bowlingTeam={bowlingTeam}
      />
    );
  };

  const prediction = calculateWinPrediction({
    match,
    scoringState: savedState,
  });

  const handleDownloadScorecardPdf = () => {
    const printSheet = document.querySelector(".scorecard-print-sheet");

    if (!printSheet) {
      alert("Unable to prepare the complete scorecard for PDF.");
      return;
    }

    const printWindow = window.open("", "_blank");

    if (!printWindow) {
      alert("Please allow pop-ups in your browser to download the scorecard PDF.");
      return;
    }

    const teamAName = teamA?.name || "Team A";
    const teamBName = teamB?.name || "Team B";
    const printTitle = `${teamAName} vs ${teamBName} - Scorecard`;

    // Reuse every stylesheet already loaded by the app so the PDF window is
    // visually identical to the scorecard, while the complete print sheet
    // already contains BOTH innings instead of only the selected tab.
    const stylesheetLinks = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]')
    )
      .map((link) => {
        const href = link.href;
        return href
          ? `<link rel="stylesheet" href="${href.replace(/"/g, "&quot;")}">`
          : "";
      })
      .join("\n");

    const inlineStyles = Array.from(document.querySelectorAll("style"))
      .map((style) => style.outerHTML)
      .join("\n");

    const printWindowDocument = printWindow.document;
    printWindowDocument.open();
    printWindowDocument.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${printTitle.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
    ${stylesheetLinks}
    ${inlineStyles}
    <style>
      @page { size: A4; margin: 10mm; }
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        background: #ffffff !important;
      }
      body {
        min-width: 0 !important;
      }
      .scorecard-print-sheet {
        display: block !important;
        position: static !important;
        width: 100% !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
        background: #ffffff !important;
        color: #111827 !important;
      }
      .scorecard-print-sheet,
      .scorecard-print-sheet * {
        visibility: visible !important;
      }
      .scorecard-print-sheet .match-scorecard-table-wrap {
        overflow: visible !important;
      }
      .scorecard-print-sheet .match-scorecard-table {
        width: 100% !important;
        min-width: 0 !important;
        table-layout: fixed !important;
      }
      .scorecard-print-sheet .match-scorecard-table th,
      .scorecard-print-sheet .match-scorecard-table td {
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }
      .scorecard-print-sheet .scorecard-download-button,
      .scorecard-print-sheet .match-scorecard-tabs {
        display: none !important;
      }
      .scorecard-print-page-break {
        break-before: page !important;
        page-break-before: always !important;
        height: 1px !important;
      }
      .scorecard-print-header,
      .match-toss-summary,
      .match-innings-scorecard,
      .match-scorecard-block,
      .win-prediction-card,
      .win-prediction-history,
      .match-impact-card,
      .finished-match-analysis,
      .match-analysis-chart-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      svg {
        max-width: 100% !important;
      }
    </style>
  </head>
  <body class="scorecard-print-mode">
    ${printSheet.outerHTML}
  </body>
</html>`);
    printWindowDocument.close();

    const startPrint = () => {
      try {
        printWindow.focus();
        printWindow.print();
      } finally {
        window.setTimeout(() => {
          try {
            printWindow.close();
          } catch {
            // Ignore browser restrictions on closing a print window.
          }
        }, 1000);
      }
    };

    if (printWindow.document.fonts?.ready) {
      printWindow.document.fonts.ready
        .then(() => window.setTimeout(startPrint, 250))
        .catch(() => window.setTimeout(startPrint, 250));
    } else {
      window.setTimeout(startPrint, 500);
    }
  };

  const matchResultText =
    typeof match?.result === "string"
      ? match.result
      : match?.result?.text || match?.resultText || "";

  return (
    <>
      <div className="scorecard-print-sheet" aria-hidden="true">
        <div className="scorecard-print-header">
          <p className="eyebrow">MATCH SCORECARD</p>
          <h1>{teamA.name} vs {teamB.name}</h1>
          {match?.createdAt && (
            <p>
              {new Date(match.createdAt).toLocaleString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
          {(matchResultText || match?.winner) && (
            <strong>{matchResultText || match.winner}</strong>
          )}
        </div>

        <LiveWinPredictionCard prediction={prediction} />
        <PredictionOverHistory match={match} scoringState={savedState} />
        <MatchMatchImpactSections match={match} scoringState={savedState} />

        <div className="match-toss-summary">
          <span className="match-toss-coin">
            {tossResult === "Tails" ? "T" : "H"}
          </span>
          <span>
            Toss: {tossResult || "Not recorded"}
            {tossWinner?.name ? ` • ${tossWinner.name}` : ""}
          </span>
        </div>

        {firstInnings
          ? inningsFor(firstInnings, firstTeamId === "B" ? teamB : teamA)
          : (
            <p className="match-scorecard-note">
              Detailed first-innings scorecard is not available for this match.
            </p>
          )}

        <div className="scorecard-print-page-break" />

        {secondInnings
          ? inningsFor(secondInnings, secondTeamId === "B" ? teamB : teamA)
          : (
            <p className="match-scorecard-note">
              Detailed second-innings scorecard is not available for this match.
            </p>
          )}

        <FinishedMatchAnalysisGraphs match={match} />
      </div>

      <div className="match-scorecard-full">
        <button
          type="button"
          className="scorecard-download-button"
          onClick={handleDownloadScorecardPdf}
          aria-label="Download whole match scorecard as PDF"
          title="Download whole match scorecard as PDF"
        >
          <svg
            className="scorecard-download-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          <span>Download PDF</span>
        </button>

        <LiveWinPredictionCard prediction={prediction} />
      <PredictionOverHistory match={match} scoringState={savedState} />
      <MatchMatchImpactSections match={match} scoringState={savedState} />
      <div className="match-scorecard-tabs" role="tablist" aria-label="Match innings">
        <button
          type="button"
          className={activeInnings === "first" ? "active" : ""}
          onClick={() => setActiveInnings("first")}
        >
          {firstInnings?.teamName || (firstTeamId === "B" ? teamB.name : teamA.name)}
        </button>
        <button
          type="button"
          className={activeInnings === "second" ? "active" : ""}
          onClick={() => setActiveInnings("second")}
        >
          {secondInnings?.teamName || (secondTeamId === "A" ? teamA.name : teamB.name)}
        </button>
      </div>

      <div className="match-toss-summary">
        <span className="match-toss-coin">{tossResult === "Tails" ? "T" : "H"}</span>
        <span>
          Toss: {tossResult || "Not recorded"}
          {tossWinner?.name ? ` • ${tossWinner.name}` : ""}
        </span>
      </div>

      {activeInnings === "first"
        ? firstInnings
          ? inningsFor(firstInnings, teamA)
          : <p className="match-scorecard-note">Detailed first-innings scorecard is not available for this match.</p>
        : secondInnings
          ? inningsFor(secondInnings, teamB)
          : <p className="match-scorecard-note">Detailed second-innings scorecard is not available for this match.</p>}
    
          {/* =================================================
          FINISHED MATCH ANALYSIS
          Only appears after the match is completed.
      ================================================== */}

      <FinishedMatchAnalysisGraphs
        match={match}
      />
    </div>
    </>
  );
}

function Matches() {
  const navigate = useNavigate();
  const isAdmin =
    Boolean(ADMIN_UID) &&
    String(getCurrentUserId() || "") === ADMIN_UID;

  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [savedTeams, setSavedTeams] = useState([]);
  const [savedTeamPlayers, setSavedTeamPlayers] = useState([]);
  const [battingStats, setBattingStats] = useState([]);
  const [bowlingStats, setBowlingStats] = useState([]);

  const [screen, setScreen] = useState("list");
  const [teamMode, setTeamMode] = useState(null);

  const [teamA, setTeamA] = useState({
    ...emptyTeam,
    id: "A",
    name: "Team A",
  });

  const [teamB, setTeamB] = useState({
    ...emptyTeam,
    id: "B",
    name: "Team B",
  });

  // Captains are selected before the first toss.
  const [captainA, setCaptainA] = useState(null);
  const [captainB, setCaptainB] = useState(null);

  // First toss decides which captain gets the later player-selection step.
  const [firstTossCaller, setFirstTossCaller] = useState(null);
  const [firstTossChoice, setFirstTossChoice] = useState(null);
  const [firstTossResult, setFirstTossResult] = useState(null);
  const [firstTossWinner, setFirstTossWinner] = useState(null);
  const [firstTossSpinning, setFirstTossSpinning] = useState(false);

  // Player draft. The first toss winner's team always picks first.
  const [nextPickTeam, setNextPickTeam] = useState(null);
  const [draftSelections, setDraftSelections] = useState([]);
  const [playerChoiceHistory, setPlayerChoiceHistory] = useState([]);

  const [playerSearch, setPlayerSearch] = useState("");

  // Final toss.
  const [secondTossCaller, setSecondTossCaller] = useState(null);
  const [secondTossChoice, setSecondTossChoice] = useState(null);
  const [secondTossResult, setSecondTossResult] = useState(null);
  const [secondTossWinner, setSecondTossWinner] = useState(null);
  const [secondTossSpinning, setSecondTossSpinning] = useState(false);

  const [battingTeam, setBattingTeam] = useState(null);
  const [bowlingTeam, setBowlingTeam] = useState(null);

  const [matchOvers, setMatchOvers] = useState(5);

  const [score, setScore] = useState({
    runs: 0,
    wickets: 0,
    balls: 0,
  });

  const [viewingMatch, setViewingMatch] = useState(null);

  // --------------------------------------------------
  // LOAD DATA
  // --------------------------------------------------

  useEffect(() => {
    const unsubscribePlayers = subscribeToPlayers(
      setPlayers,
      (error) => console.error("Unable to load Firebase players:", error)
    );
    const unsubscribeTeams = subscribeToTeams(
      (teams) =>
        setSavedTeams((current) => {
          const merged = new Map(
            current.map((team) => [
              String(team.teamId || team.id),
              team,
            ])
          );

          teams.forEach((team) => {
            merged.set(
              String(team.teamId || team.id),
              {
                ...merged.get(String(team.teamId || team.id)),
                ...team,
              }
            );
          });

          return Array.from(merged.values());
        }),
      (error) => console.error("Unable to load Firebase teams:", error)
    );
    const unsubscribeTeamPlayers = subscribeToTeamPlayers(
      setSavedTeamPlayers,
      (error) => console.error("Unable to load Firebase team players:", error)
    );
    const unsubscribeMatches = subscribeToMatches(
      (nextMatches) => setMatches(
        nextMatches.sort(
          (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        )
      ),
      (error) => console.error("Unable to load Firebase matches:", error)
    );

    Promise.all([
      getDocs(collection(db, "battingStats")),
      getDocs(collection(db, "bowlingStats")),
    ])
      .then(([battingSnapshot, bowlingSnapshot]) => {
        setBattingStats(
          battingSnapshot.docs.map((item) => ({
            id: item.id,
            ...item.data(),
          }))
        );
        setBowlingStats(
          bowlingSnapshot.docs.map((item) => ({
            id: item.id,
            ...item.data(),
          }))
        );
      })
      .catch((error) => {
        console.error("Unable to load player match statistics:", error);
      });

    return () => {
      unsubscribePlayers();
      unsubscribeTeams();
      unsubscribeTeamPlayers();
      unsubscribeMatches();
    };
  }, []);

  // Keep an opened scorecard in sync with the existing match snapshot stream.
  // This is event-driven and does not add any polling or database reads.
  useEffect(() => {
    if (!viewingMatch) return;

    const latestMatch = matches.find(
      (match) => String(match.id) === String(viewingMatch.id)
    );

    if (latestMatch && latestMatch !== viewingMatch) {
      setViewingMatch(latestMatch);
    }
  }, [matches, viewingMatch]);

  // --------------------------------------------------
  // AUTO CHANGE LIVE -> UNFINISHED AFTER 12 HOURS
  // --------------------------------------------------

  useEffect(() => {
    const checkMatches = () => {
      setMatches((currentMatches) => {
        let changed = false;

        const updated = currentMatches.map((match) => {
          if (
            match.status === "live" &&
            match.startedAt &&
            Date.now() - new Date(match.startedAt).getTime() >=
              12 * 60 * 60 * 1000
          ) {
            changed = true;

            return {
              ...match,
              status: "unfinished",
              updatedAt: new Date().toISOString(),
            };
          }

          return match;
        });

        if (changed) {
          updated
            .filter((match) => match.status === "unfinished")
            .forEach((match) => saveMatch(match).catch(console.error));
        }

        return updated;
      });
    };

    checkMatches();

    const interval = setInterval(checkMatches, 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  // --------------------------------------------------
  // HELPERS
  // --------------------------------------------------

  const resetMatchCreation = () => {
    setTeamMode(null);

    setTeamA({
      ...emptyTeam,
      id: "A",
      name: "Team A",
    });

    setTeamB({
      ...emptyTeam,
      id: "B",
      name: "Team B",
    });

    setCaptainA(null);
    setCaptainB(null);

    setFirstTossCaller(null);
    setFirstTossChoice(null);
    setFirstTossResult(null);
    setFirstTossWinner(null);
    setFirstTossSpinning(false);

    setNextPickTeam(null);
    setDraftSelections([]);
    setPlayerChoiceHistory([]);

    setPlayerSearch("");

    setSecondTossCaller(null);
    setSecondTossChoice(null);
    setSecondTossResult(null);
    setSecondTossWinner(null);

    setBattingTeam(null);
    setBowlingTeam(null);
    setMatchOvers(5);

    setScore({
      runs: 0,
      wickets: 0,
      balls: 0,
    });
  };

  const getPlayerName = (player) => {
    if (!player) return "";

    if (typeof player === "string") {
      return player;
    }

    return player.name || "Unknown Player";
  };

  const playerStrength = (player) => {
    if (!player) return 0;

    let strength = 50;

    if (player.type === "Batsman") strength += 12;
    if (player.type === "Bowler") strength += 12;
    if (player.type === "All-rounder") strength += 18;
    if (player.type === "Wicketkeeper") strength += 10;

    if (player.battingPosition === "Opener") strength += 4;
    if (player.battingPosition === "Middle order") strength += 3;
    if (player.battingPosition === "Finisher") strength += 5;

    if (player.bowlingStyle === "Full pacer") strength += 5;
    if (player.bowlingStyle === "Medium pacer") strength += 3;
    if (player.bowlingStyle === "Spinner") strength += 4;

    return strength;
  };

  const playerMatchStrength = (player) => {
    const playerId = String(
      player?.id ??
        player?.uid ??
        player?.playerId ??
        ""
    );

    if (!playerId) return 0;

    const batting = battingStats.filter(
      (stat) =>
        String(stat.playerId ?? stat.uid ?? stat.id ?? "") === playerId
    );
    const bowling = bowlingStats.filter(
      (stat) =>
        String(stat.playerId ?? stat.uid ?? stat.id ?? "") === playerId
    );

    const matchIds = new Set(
      [...batting, ...bowling]
        .map((stat) => stat.matchId ?? stat.matchID)
        .filter(Boolean)
        .map(String)
    );
    const matchesPlayed =
      matchIds.size ||
      Number(player.matchesPlayed ?? player.matches ?? 0);

    if (!matchesPlayed) return 0;

    const runs = batting.reduce(
      (total, stat) => total + (Number(stat.runs) || 0),
      0
    );
    const wickets = bowling.reduce(
      (total, stat) => total + (Number(stat.wickets) || 0),
      0
    );

    return (runs + wickets * 20) / matchesPlayed;
  };

  const teamStrength = (team) => {
    if (!team) return 0;

    const captain =
      String(team.id) === "B"
        ? captainB
        : captainA;
    const strengthPlayers = [
      captain,
      ...(Array.isArray(team.players)
        ? team.players
        : []),
    ].filter(Boolean);

    const uniquePlayers = Array.from(
      new Map(
        strengthPlayers.map((player) => [
          String(
            player.id ??
              player.uid ??
              player.playerId
          ),
          player,
        ])
      ).values()
    );

    if (!uniquePlayers.length) return 0;

    const total = uniquePlayers.reduce(
      (sum, player) => sum + playerMatchStrength(player),
      0
    );

    return Number(
      (total / uniquePlayers.length).toFixed(1)
    );
  };

  const strengthBarWidth = (team) => {
    const teamAValue = teamStrength(teamA);
    const teamBValue = teamStrength(teamB);
    const strongestTeam = Math.max(
      teamAValue,
      teamBValue
    );

    if (!strongestTeam) return 0;

    return (teamStrength(team) / strongestTeam) * 100;
  };

  const teamAHasPlayer = (id) =>
    teamA.players.some(
      (player) => String(player.id) === String(id)
    );

  const teamBHasPlayer = (id) =>
    teamB.players.some(
      (player) => String(player.id) === String(id)
    );

  const bothPlayer = useMemo(() => {
    const bothA = teamA.players.filter((a) =>
      teamB.players.some(
        (b) => String(a.id) === String(b.id)
      )
    );

    return bothA[0] || null;
  }, [teamA.players, teamB.players]);

  // --------------------------------------------------
  // SELECT CAPTAINS FIRST
  // --------------------------------------------------

  const chooseCaptainA = (playerId) => {
    const player = players.find(
      (p) => String(p.id) === String(playerId)
    );

    if (!player) {
      setCaptainA(null);
      return;
    }

    setCaptainA(player);
  };

  const chooseCaptainB = (playerId) => {
    const player = players.find(
      (p) => String(p.id) === String(playerId)
    );

    if (!player) {
      setCaptainB(null);
      return;
    }

    setCaptainB(player);
  };

  // FIX: explicit screen transition.
  const continueAfterCaptains = () => {
    if (!captainA || !captainB) {
      alert("Please select both captains.");
      return;
    }

    if (String(captainA.id) === String(captainB.id)) {
      alert("Team captains must be different players.");
      return;
    }

    const nextTeamA = {
      ...teamA,
      players: teamA.players.some(
        (player) => String(player.id) === String(captainA.id)
      )
        ? teamA.players
        : [captainA, ...teamA.players],
    };
    const nextTeamB = {
      ...teamB,
      players: teamB.players.some(
        (player) => String(player.id) === String(captainB.id)
      )
        ? teamB.players
        : [captainB, ...teamB.players],
    };

    setTeamA(nextTeamA);
    setTeamB(nextTeamB);
    setDraftSelections([
      { player: captainA, team: "A" },
      { player: captainB, team: "B" },
    ]);
    setPlayerChoiceHistory([]);

    setFirstTossCaller(
      Math.random() < 0.5 ? captainA : captainB
    );
    setFirstTossChoice(null);
    setFirstTossResult(null);
    setFirstTossWinner(null);
    setFirstTossSpinning(false);

    setScreen("first-toss");
  };

  // --------------------------------------------------
  // FIRST TOSS
  // --------------------------------------------------

  const chooseFirstToss = (choice) => {
    if (firstTossResult || firstTossChoice) return;

    const caller = firstTossCaller || captainA;
    const other =
      String(caller?.id) === String(captainA?.id) ? captainB : captainA;

    setFirstTossChoice(choice);
    setFirstTossSpinning(true);

    window.setTimeout(() => {
      const result = Math.random() < 0.5 ? "Heads" : "Tails";
      const winner = result === choice ? caller : other;

      setFirstTossResult(result);
      setFirstTossWinner(winner);
      setFirstTossSpinning(false);

      const winnerIsA =
        String(winner?.id) === String(captainA?.id);

      setNextPickTeam(winnerIsA ? "A" : "B");
    }, TOSS_FLIP_MS);
  };

  // --------------------------------------------------
  // PLAYER SELECTION
  // --------------------------------------------------

  const savePlayerChoiceSnapshot = () => {
    setPlayerChoiceHistory((prev) => [
      ...prev,
      {
        teamAPlayers: [...teamA.players],
        teamBPlayers: [...teamB.players],
        draftSelections: [...draftSelections],
        nextPickTeam,
      },
    ]);
  };

  const selectPlayer = (player, choice) => {
    if (!player || !choice) return;

    const id = String(player.id);

    const alreadySelected = draftSelections.some(
      (item) => String(item.player.id) === id
    );

    const alreadyInA = teamA.players.some((p) => String(p.id) === id);
    const alreadyInB = teamB.players.some((p) => String(p.id) === id);
    const isCaptain =
      String(captainA?.id) === id ||
      String(captainB?.id) === id;

    if (alreadySelected) return;
    if (isCaptain) return;
    if (choice === "A" && alreadyInB) return;
    if (choice === "B" && alreadyInA) return;
    if (choice === "BOTH" && (alreadyInA || alreadyInB)) return;

    // BOTH is allowed only once. It does not replace the normal A/B turn.
    if (choice === "BOTH") {
      const existingBoth = teamA.players.find((p) =>
        teamB.players.some((b) => String(b.id) === String(p.id))
      );

      if (existingBoth) {
        alert(
          `Only one player can play for BOTH teams.\n\n${getPlayerName(existingBoth)} is already selected for both teams.`
        );
        return;
      }

      savePlayerChoiceSnapshot();

      setTeamA((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setTeamB((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setDraftSelections((prev) => [
        ...prev,
        { player, team: "BOTH" },
      ]);

      return;
    }

    // A/B picks must follow the first-toss order.
    if (choice !== nextPickTeam) return;

    if (choice === "A") {
      savePlayerChoiceSnapshot();

      setTeamA((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setDraftSelections((prev) => [
        ...prev,
        { player, team: "A" },
      ]);

      setNextPickTeam("B");
      return;
    }

    if (choice === "B") {
      savePlayerChoiceSnapshot();

      setTeamB((prev) => ({
        ...prev,
        players: prev.players.some((p) => String(p.id) === id)
          ? prev.players
          : [...prev.players, player],
      }));

      setDraftSelections((prev) => [
        ...prev,
        { player, team: "B" },
      ]);

      setNextPickTeam("A");
    }
  };

  const isBothPlayer = (player) => {
    if (!player) return false;
    const id = String(player.id);
    return (
      teamA.players.some((p) => String(p.id) === id) &&
      teamB.players.some((p) => String(p.id) === id)
    );
  };

  const isPlayerSelected = (player) => {
    if (!player) return false;
    const id = String(player.id);
    return draftSelections.some(
      (item) => String(item.player.id) === id
    );
  };

  const isTeamOptionBlocked = (player, option) => {
    if (!player) return true;

    const id = String(player.id);

    const inA = teamA.players.some((p) => String(p.id) === id);
    const inB = teamB.players.some((p) => String(p.id) === id);

    // Once assigned to one team, the player cannot be assigned to the opposite team.
    if (option === "A" && inB) return true;
    if (option === "B" && inA) return true;

    if (isPlayerSelected(player)) return true;

    if (option === "A" && nextPickTeam !== "A") return true;
    if (option === "B" && nextPickTeam !== "B") return true;

    if (option === "BOTH") {
      const currentBoth = teamA.players.find((p) =>
        teamB.players.some((b) => String(b.id) === String(p.id))
      );

      if (currentBoth && String(currentBoth.id) !== id) return true;
    }

    return false;
  };

  const removePlayerFromTeam = (playerId, team) => {
    const id = String(playerId);

    if (
      (team === "A" && String(captainA?.id) === id) ||
      (team === "B" && String(captainB?.id) === id)
    ) {
      alert("A captain must remain in their own team.");
      return;
    }

    savePlayerChoiceSnapshot();

    const playerWasBoth =
      teamA.players.some((p) => String(p.id) === id) &&
      teamB.players.some((p) => String(p.id) === id);

    if (team === "A") {
      setTeamA((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
    }

    if (team === "B") {
      setTeamB((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
    }

    // A BOTH player is removed from BOTH sides and becomes available again.
    if (playerWasBoth) {
      setTeamA((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
      setTeamB((prev) => ({
        ...prev,
        players: prev.players.filter((p) => String(p.id) !== id),
      }));
    }

    setDraftSelections((prev) => {
      const next = prev.filter((item) => String(item.player.id) !== id);
      const aCount = next.filter((item) => item.team === "A").length;
      const bCount = next.filter((item) => item.team === "B").length;
      const winnerIsA =
        String(firstTossWinner?.id) === String(captainA?.id);

      if (winnerIsA) {
        setNextPickTeam(aCount <= bCount ? "A" : "B");
      } else {
        setNextPickTeam(bCount <= aCount ? "B" : "A");
      }

      return next;
    });
  };

  const undoPlayerChoice = () => {
    const previous = playerChoiceHistory[playerChoiceHistory.length - 1];

    if (!previous) return;

    setTeamA((current) => ({
      ...current,
      players: previous.teamAPlayers,
    }));
    setTeamB((current) => ({
      ...current,
      players: previous.teamBPlayers,
    }));
    setDraftSelections(previous.draftSelections);
    setNextPickTeam(previous.nextPickTeam);
    setPlayerChoiceHistory((history) => history.slice(0, -1));
  };

  // --------------------------------------------------
  // AI TEAM BALANCE
  // --------------------------------------------------

  const [skippedAiPlayerIds, setSkippedAiPlayerIds] = useState([]);

  useEffect(() => {
    setSkippedAiPlayerIds([]);
  }, [nextPickTeam, draftSelections]);

  const aiSuggestion = useMemo(() => {
    if (!nextPickTeam) return null;

    const available = players.filter((player) => {
      const id = String(player.id);
      return !draftSelections.some(
        (item) => String(item.player.id) === id
      );
    });

    if (!available.length) return null;

    const strengthA = teamStrength(teamA);
    const strengthB = teamStrength(teamB);

    const candidates = available
      .filter((player) => {
        const id = String(player.id);
        return nextPickTeam === "A"
          ? !teamA.players.some((p) => String(p.id) === id)
          : !teamB.players.some((p) => String(p.id) === id);
      })
      .filter((player) => !skippedAiPlayerIds.includes(String(player.id)))
      .sort(
        (a, b) =>
          playerMatchStrength(b) - playerMatchStrength(a)
      );

    const candidate = candidates[0];
    if (!candidate) return null;

    return {
      team: nextPickTeam,
      player: candidate,
      strengthA,
      strengthB,
    };
  }, [
    players,
    teamA.players,
    teamB.players,
    nextPickTeam,
    draftSelections,
    battingStats,
    bowlingStats,
    skippedAiPlayerIds,
  ]);

  const skipAiSuggestion = () => {
    if (!aiSuggestion) return;
    setSkippedAiPlayerIds((previous) => [
      ...previous,
      String(aiSuggestion.player.id),
    ]);
  };

  // --------------------------------------------------
  // CONFIRM TEAMS
  // --------------------------------------------------

  const confirmTeams = async () => {
    if (!teamA.name.trim() || !teamB.name.trim()) {
      alert("Please enter both team names.");
      return;
    }

    if (String(teamA.name).trim().toLowerCase() === String(teamB.name).trim().toLowerCase()) {
      alert("Team A and Team B must have different names.");
      return;
    }

    if (!captainA || !captainB) {
      alert("Please select both captains.");
      return;
    }

    if (String(captainA.id) === String(captainB.id)) {
      alert("Captains must be different players.");
      return;
    }

    if (!teamA.players.length || !teamB.players.length) {
      alert("Both teams must have at least one player.");
      return;
    }

    // Captains are always included in their own teams.
    const uniquePlayers = (items) =>
      Array.from(
        new Map(
          items.map((player) => [
            String(player.id || player.uid || player.playerId),
            player,
          ])
        ).values()
      );

    const nextA = {
      ...teamA,
      players: uniquePlayers(
        teamA.players.some((p) => String(p.id) === String(captainA.id))
          ? teamA.players
          : [...teamA.players, captainA]
      ),
    };

    const nextB = {
      ...teamB,
      players: uniquePlayers(
        teamB.players.some((p) => String(p.id) === String(captainB.id))
          ? teamB.players
          : [...teamB.players, captainB]
      ),
    };

    setTeamA(nextA);
    setTeamB(nextB);

    // Persist reusable teams for the Use Existing Team flow.
    try {
      const current = Array.isArray(savedTeams) ? savedTeams : [];
      const now = new Date().toISOString();

      const makeSavedTeam = (team, captain) => {
        const existingTeamId =
          team.teamId && !["A", "B"].includes(String(team.teamId))
            ? String(team.teamId)
            : team.id && !["A", "B"].includes(String(team.id))
              ? String(team.id)
              : null;

        const savedId =
          existingTeamId ||
          `team-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        return {
          id: savedId,
          teamId: savedId,
          name: team.name.trim(),
          captain,
          players: team.players,
          updatedAt: now,
        };
      };

      // IMPORTANT: only save the two teams created/updated in this operation.
      // Never re-save every existing team here. Firestore team documents loaded
      // from the database contain playerIds/teamPlayers, not necessarily the
      // full `players` array. Re-saving those old teams with an empty players
      // array could overwrite their playerIds with [].
      const savedTeamA = makeSavedTeam(nextA, captainA);
      const savedTeamB = makeSavedTeam(nextB, captainB);
      const teamsToSave = [savedTeamA, savedTeamB];

      await Promise.all(teamsToSave.map((team) => saveTeam(team)));

      setSavedTeams((current) => {
        const merged = new Map(
          current.map((team) => [
            String(team.teamId || team.id),
            team,
          ])
        );

        teamsToSave.forEach((team) => {
          merged.set(
            String(team.teamId || team.id),
            team
          );
        });

        return Array.from(merged.values());
      });
    } catch (error) {
      alert(error.message || "Unable to save teams to Firebase.");
      return;
    }

    // Captain A is explicitly shown as the final toss caller in the existing UI.
    // Keep that caller deterministic so the Heads/Tails result matches the visible flow.
    setSecondTossCaller(captainA);
    setSecondTossChoice(null);
    setSecondTossResult(null);
    setSecondTossWinner(null);
    setSecondTossSpinning(false);
    setScreen("second-toss");
  };

  // --------------------------------------------------
  // SECOND TOSS
  // --------------------------------------------------

  const chooseSecondToss = (choice) => {
    if (secondTossResult || secondTossChoice) return;

    const caller = secondTossCaller || captainA;
    const other =
      String(caller?.id) === String(captainA?.id) ? captainB : captainA;

    setSecondTossChoice(choice);
    setSecondTossSpinning(true);

    window.setTimeout(() => {
      const result = Math.random() < 0.5 ? "Heads" : "Tails";

      setSecondTossResult(result);
      setSecondTossSpinning(false);

      if (result === choice) {
        setSecondTossWinner(caller);
      } else {
        setSecondTossWinner(other);
      }
    }, TOSS_FLIP_MS);
  };

  // --------------------------------------------------
  // BAT / BOWL
  // --------------------------------------------------

  const getTossTeams = () => {
    if (!secondTossWinner) return null;

    const winnerIsA =
      String(secondTossWinner.id) ===
      String(captainA.id);

    return {
      winnerTeam: winnerIsA ? teamA : teamB,
      otherTeam: winnerIsA ? teamB : teamA,
    };
  };

  const chooseBat = () => {
    const tossTeams = getTossTeams();
    if (!tossTeams) return;

    const { winnerTeam, otherTeam } = tossTeams;

    setBattingTeam(winnerTeam);
    setBowlingTeam(otherTeam);

    startLiveMatch(winnerTeam, otherTeam);
  };

  const chooseBowl = () => {
    const tossTeams = getTossTeams();
    if (!tossTeams) return;

    const { winnerTeam, otherTeam } = tossTeams;

    setBattingTeam(otherTeam);
    setBowlingTeam(winnerTeam);

    startLiveMatch(otherTeam, winnerTeam);
  };

  // --------------------------------------------------
  // START MATCH
  // --------------------------------------------------

  const startLiveMatch = async (batting, bowling) => {
    const now = new Date().toISOString();
    const id = Date.now();

    const battingTeamId =
      String(batting?.id) === "B" || batting === teamB ? "B" : "A";
    const bowlingTeamId = battingTeamId === "A" ? "B" : "A";

    const newMatch = {
      id,
      teamA: {
        id: "A",
        name: teamA.name.trim(),
        captain: captainA,
        players: teamA.players,
      },
      teamB: {
        id: "B",
        name: teamB.name.trim(),
        captain: captainB,
        players: teamB.players,
      },
      teamAPlayers: teamA.players,
      teamBPlayers: teamB.players,
      teamAName: teamA.name.trim(),
      teamBName: teamB.name.trim(),
      captainA,
      captainB,
      firstTossChoice,
      firstTossResult,
      firstTossWinner,
      secondTossChoice,
      secondTossResult,
      secondTossWinner,
      battingTeamId,
      bowlingTeamId,
      battingTeam: batting.name,
      bowlingTeam: bowling.name,
      overs: Number(matchOvers),
      scoreA: 0,
      wicketsA: 0,
      scoreB: 0,
      wicketsB: 0,
      status: "live",
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      winner: null,
    };

    try {
      const savedMatch = await saveMatch(newMatch);
      setMatches((current) => [savedMatch, ...current.filter((item) => String(item.id) !== String(id))]);
    } catch (error) {
      alert(error.message || "Unable to save match to Firebase.");
      return;
    }

    // Scoring is handled by the dedicated Scoring page.
    navigate(`/scoring/${id}`);
  };

  // --------------------------------------------------
  // FINISH MATCH
  // --------------------------------------------------

  const finishMatch = async (winnerName = null) => {
    const latestMatch = matches[0];

    if (!latestMatch) return;

    const finishedAt = new Date().toISOString();
    const updatedMatches = matches.map(
      (match, index) => {
        if (index !== 0) return match;

        const savedMatch = {
          ...match,
          status: "finished",
          winner: winnerName,
          finishedAt,
          updatedAt: finishedAt,
        };

        saveMatch(savedMatch).catch(console.error);

        return savedMatch;
      }
    );

    setMatches(updatedMatches);

    setScreen("list");
  };

  // --------------------------------------------------
  // DATE FORMAT
  // --------------------------------------------------

  const formatDate = (date) =>
    new Date(date).toLocaleDateString(
      "en-IN",
      {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }
    );

  const formatTime = (date) =>
    new Date(date).toLocaleTimeString(
      "en-IN",
      {
        hour: "2-digit",
        minute: "2-digit",
      }
    );

  const getMatchStatus = (match) => {
    if (!match) return "live";
    if (match.status === "unfinished") return "unfinished";
    if (
      match.status === "finished" ||
      match.result ||
      match.resultText ||
      match.winner ||
      match.finishedAt
    ) {
      return "finished";
    }
    return "live";
  };

  const getMatchResultText = (match) => {
    if (!match) return "";

    if (typeof match.result === "string") {
      return match.result;
    }

    return (
      match.result?.text ||
      match.resultText ||
      ""
    );
  };

  const sortedMatches = [...matches].sort(
    (a, b) =>
      new Date(b.createdAt) -
      new Date(a.createdAt)
  );

  // --------------------------------------------------
  // DARK MODE / FORM CONTROL FIX
  // --------------------------------------------------

  // --------------------------------------------------
  // MATCH LIST
  // --------------------------------------------------

  if (screen === "list") {
    return (
      <>
        <div className="page matches-page">
          <div className="matches-header">
            <div>
              <p className="eyebrow">CRICKET MATCHES</p>
              <h2>Matches</h2>
              <p className="subtitle">
                Manage live, unfinished and finished matches.
              </p>
            </div>

            <button
              type="button"
              className="primary-button"
              onClick={() => {
                resetMatchCreation();
                setScreen("team-mode");
              }}
            >
              ＋ Start Match
            </button>
          </div>

          {sortedMatches.length === 0 ? (
            <div className="empty-card matches-empty">
              <div className="empty-icon">🏏</div>

              <h3>No matches yet</h3>

              <p>
                Start your first local cricket match.
              </p>

              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  resetMatchCreation();
                  setScreen("team-mode");
                }}
              >
                Start Match
              </button>
            </div>
          ) : (
            <div className="matches-list">
              {sortedMatches.map((match) => (
                <div
                  className="match-date-group"
                  key={match.id}
                >
                  <div className="match-date">
                    {formatDate(match.createdAt)}
                  </div>

                  <div className="match-card">
                    <div className="match-card-top">
                      {getMatchStatus(match) === "live" && (
                        <span className="live-badge">
                          <span className="live-dot"></span>
                          LIVE
                        </span>
                      )}

                      {getMatchStatus(match) === "unfinished" && (
                        <span className="unfinished-badge">
                          UNFINISHED
                        </span>
                      )}

                      {getMatchStatus(match) === "finished" && (
                        <span className="finished-badge">
                          FINISHED
                        </span>
                      )}

                      <span className="match-time">
                        {formatTime(match.createdAt)}
                      </span>
                    </div>

                    <div className="teams-display">
                      <div className="match-team">
                        <strong>{match.teamA.name}</strong>

                        <span>
                          {match.scoreA || 0}/
                          {match.wicketsA || 0}
                        </span>
                      </div>

                      <div className="vs">VS</div>

                      <div className="match-team">
                        <strong>{match.teamB.name}</strong>

                        <span>
                          {match.scoreB || 0}/
                          {match.wicketsB || 0}
                        </span>
                      </div>
                    </div>

                    {getMatchStatus(match) === "finished" &&
                      (getMatchResultText(match) || match.winner) && (
                        <div className="winner-text">
                          {getMatchResultText(match).toLowerCase().includes("draw") ||
                          getMatchResultText(match).toLowerCase().includes("tie")
                            ? "🤝"
                            : "🏆"}{" "}
                          {getMatchResultText(match) || `${match.winner} won`}
                        </div>
                      )}

                    {getMatchStatus(match) === "unfinished" && (
                      <div className="unfinished-text">
                        Match was automatically marked
                        unfinished after 12 hours.
                      </div>
                    )}

                    <div className="match-card-actions">
                      {(getMatchStatus(match) === "live" || getMatchStatus(match) === "unfinished") &&
                        (!match.createdBy || String(match.createdBy) === String(getCurrentUserId())) ? (
                        <button
                          type="button"
                          className="primary-button full-button"
                          onClick={() => navigate(`/scoring/${match.id}`)}
                        >
                          ▶ Resume Scoring
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="secondary-button full-button"
                        onClick={() => {
                          setViewingMatch(match);
                          setScreen("view-scorecard");
                        }}
                      >
                        View Scorecard
                      </button>

                      {isAdmin && (
                        <button
                          type="button"
                          className="danger-button full-button "
                          onClick={async () => {
                            if (!window.confirm("Delete this match and all related score data?")) return;
                            try {
                              await deleteMatchCascade(match.id);
                              setMatches((current) =>
                                current.filter((item) => String(item.id) !== String(match.id))
                              );
                            } catch (error) {
                              alert(error.message || "Unable to delete match.");
                            }
                          }}
                        >
                          Delete Match
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // TEAM MODE
  // --------------------------------------------------

  if (screen === "team-mode") {
    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("list")}
          >
            ← Back
          </button>

          <div className="setup-header">
            <p className="eyebrow">MATCH SETUP</p>

            <h2>Choose Teams</h2>

            <p className="subtitle">
              How do you want to create the teams?
            </p>
          </div>

          <div className="team-mode-grid">
            <button
              type="button"
              className="mode-card"
              onClick={() => {
                setTeamMode("create");
                setScreen("team-names");
              }}
            >
              <span className="mode-icon">👥</span>

              <h3>Create Team</h3>

              <p>
                Enter team names, choose captains, then build balanced teams.
              </p>
            </button>

            <button
              type="button"
              className="mode-card"
              onClick={() => {
                if (!savedTeams.length) {
                  alert(
                    "No existing teams found. Please create teams first."
                  );
                  return;
                }

                setTeamMode("existing");
                setScreen("existing-teams");
              }}
            >
              <span className="mode-icon">📋</span>

              <h3>Use Existing Team</h3>

              <p>
                Select two teams already created.
              </p>
            </button>
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // TEAM NAMES FIRST
  // --------------------------------------------------

  if (screen === "team-names") {
    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("team-mode")}
          >
            ← Back
          </button>

          <div className="setup-header">
            <p className="eyebrow">STEP 1</p>
            <h2>Name Your Teams</h2>
            <p className="subtitle">Enter both team names first.</p>
          </div>

          <div className="team-name-grid">
            <div className="setup-card">
              <label>Team A Name</label>
              <input
                value={teamA.name}
                onChange={(e) =>
                  setTeamA((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="Enter Team A name"
              />
            </div>

            <div className="setup-card">
              <label>Team B Name</label>
              <input
                value={teamB.name}
                onChange={(e) =>
                  setTeamB((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="Enter Team B name"
              />
            </div>
          </div>

          <button
            type="button"
            className="primary-button full-button"
            onClick={() => {
              if (!teamA.name.trim() || !teamB.name.trim()) {
                alert("Please enter both team names.");
                return;
              }
              if (teamA.name.trim().toLowerCase() === teamB.name.trim().toLowerCase()) {
                alert("Team names must be different.");
                return;
              }
              setScreen("captains");
            }}
          >
            Continue to Captains →
          </button>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // CAPTAINS FIRST
  // --------------------------------------------------

  if (screen === "captains") {
    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("team-mode")}
          >
            ← Back
          </button>

          <div className="setup-header">
            <p className="eyebrow">STEP 2</p>

            <h2>Choose Captains</h2>

            <p className="subtitle">
              Select one captain for each team before the first toss.
            </p>
          </div>
{/* here remove the captain 1 , captain 2 and in placee of 1 ,2 put team name each */}
          <div className="captain-grid">
            <div className="setup-card">
              <h3>{teamA.name}</h3>

              <select
                value={captainA?.id || ""}
                onChange={(e) =>
                  chooseCaptainA(e.target.value)
                }
              >
                <option value="">
                  Select captain for {teamA.name}
                </option>

                {players.map((player) => (
                  <option
                    key={player.id}
                    value={player.id}
                    disabled={
                      captainB?.id != null &&
                      String(captainB.id) ===
                        String(player.id)
                    }
                  >
                    {getPlayerName(player)}
                  </option>
                ))}
              </select>

              {captainA && (
                <div className="selected-captain">
                  👤 {getPlayerName(captainA)}
                </div>
              )}
            </div>

            <div className="setup-card">
              <h3>{teamB.name}</h3>

              <select
                value={captainB?.id || ""}
                onChange={(e) =>
                  chooseCaptainB(e.target.value)
                }
              >
                <option value="">
                  Select captain for {teamB.name}
                </option>

                {players.map((player) => (
                  <option
                    key={player.id}
                    value={player.id}
                    disabled={
                      captainA?.id != null &&
                      String(captainA.id) ===
                        String(player.id)
                    }
                  >
                    {getPlayerName(player)}
                  </option>
                ))}
              </select>

              {captainB && (
                <div className="selected-captain">
                  👤 {getPlayerName(captainB)}
                </div>
              )}
            </div>
          </div>

          {/* FIXED NAVIGATION BUTTON */}
          <button
            type="button"
            className="primary-button full-button"
            onClick={continueAfterCaptains}
          >
            Continue to Toss →
          </button>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // FIRST TOSS
  // --------------------------------------------------

  if (screen === "first-toss") {
    return (
      <>
        <div className="page matches-page">
          <div className="setup-header">
            <p className="eyebrow">STEP 2</p>

            <h2>First Toss</h2>

            <p className="subtitle">
              {getPlayerName(captainA)} chooses first.
            </p>
          </div>

          <div className="toss-card">
            <div className="toss-captains">
              <div>
                <span>Captain 1</span>
                <strong>
                  {getPlayerName(captainA)}
                </strong>
              </div>

              <div className="toss-vs">VS</div>

              <div>
                <span>Captain 2</span>
                <strong>
                  {getPlayerName(captainB)}
                </strong>
              </div>
            </div>

            {!firstTossResult && (
              <>
                <h3>
                  {getPlayerName(firstTossCaller || captainA)}, choose your side
                </h3>

                {!firstTossChoice && (
                  <div className="toss-buttons">
                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseFirstToss("Heads")
                      }
                    >
                      🪙
                      <span>Heads</span>
                    </button>

                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseFirstToss("Tails")
                      }
                    >
                      🪙
                      <span>Tails</span>
                    </button>
                  </div>
                )}
              </>
            )}

            {firstTossChoice && !firstTossResult && (
              <CoinFlip spinning={firstTossSpinning} />
            )}

            {firstTossResult && (
              <div className="toss-result">
                <CoinFlip result={firstTossResult} spinning={firstTossSpinning} />

                <p>Toss result</p>

                <h2>{firstTossResult}</h2>

                <div className="toss-winner">
                  🏆 {getPlayerName(firstTossWinner)} won
                  the toss
                </div>

                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    if (!firstTossWinner || !nextPickTeam) return;
                    setScreen("player-selection");
                  }}
                >
                  Select Player→
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // PLAYER SELECTION
  // --------------------------------------------------

  if (screen === "player-selection") {
    const filteredPlayers = players.filter((player) =>
      getPlayerName(player)
        .toLowerCase()
        .includes(playerSearch.toLowerCase())
    );

    const currentBoth = teamA.players.find((p) =>
      teamB.players.some((b) => String(b.id) === String(p.id))
    );

    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => setScreen("first-toss")}
          >
            ← Back to Toss
          </button>

          <div className="setup-header">
            <p className="eyebrow">STEP 3</p>
            <h2>Select Players</h2>
            <p className="subtitle">
              Teams are picked alternately. The first toss winner picks first.
            </p>
          </div>

          <div className="draft-turn-card">
            <span className="draft-turn-label">CURRENT PICK</span>
            <strong>
              {nextPickTeam === "A" ? teamA.name : teamB.name}
            </strong>
            <p>Choose the next player for this team.</p>
          </div>

          <div className="ai-card">
            <div className="ai-title">
              <span className="ai-icon">✨</span>
              <div>
                <strong>AI Team Balance Suggestion</strong>
                <p>Suggested player for the current pick</p>
              </div>
            </div>

            {aiSuggestion ? (
              <div className="ai-suggestion">
                <div>
                  <span>
                    {aiSuggestion.team === "A" ? teamA.name : teamB.name}
                  </span>
                  <strong>Choose {getPlayerName(aiSuggestion.player)}</strong>
                </div>
                <button
                  type="button"
                  disabled={isTeamOptionBlocked(aiSuggestion.player, aiSuggestion.team)}
                  onClick={() => selectPlayer(aiSuggestion.player, aiSuggestion.team)}
                >
                  + Add
                </button>
                <button
                  type="button"
                  onClick={skipAiSuggestion}
                >
                  Skip
                </button>
              </div>
            ) : (
              <p className="ai-complete">No further AI suggestion is available.</p>
            )}

            <div className="strength-container">
              <div className="strength-team">
                <div>
                  <span>{teamA.name}</span>
                  <strong>{teamStrength(teamA)}</strong>
                </div>
                <div className="strength-bar">
                  <div
                    style={{
                      width: `${strengthBarWidth(teamA)}%`,
                    }}
                  />
                </div>
              </div>

              <div className="strength-team">
                <div>
                  <span>{teamB.name}</span>
                  <strong>{teamStrength(teamB)}</strong>
                </div>
                <div className="strength-bar">
                  <div
                    style={{
                      width: `${strengthBarWidth(teamB)}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="balance-text">
              Difference:{" "}
              {Math.abs(
                teamStrength(teamA) -
                  teamStrength(teamB)
              ).toFixed(1)}{" "}
              points
            </div>
          </div>
 <div className="setup-card">
            <label>Match Overs</label>
            <select
              value={matchOvers}
              onChange={(e) => setMatchOvers(e.target.value)}
            >
              <option value="1">1 Over</option>
              <option value="2">2 Overs</option>
              <option value="3">3 Overs</option>
              <option value="4">4 Overs</option>
              <option value="5">5 Overs</option>
              <option value="6">6 Overs</option>
              <option value="7">7 Overs</option>
              <option value="8">8 Overs</option>
              <option value="9">9 Overs</option>
              <option value="10">10 Overs</option>
              <option value="15">15 Overs</option>
            </select>
          </div>

          <div className="player-picker">
            <div className="picker-header">
              <h3>Available Players</h3>
              <div className="picker-actions">
                <span>{players.length} available</span>
                <button
                  type="button"
                  className="danger-button undo-player-button"
                  onClick={undoPlayerChoice}
                  disabled={!playerChoiceHistory.length}
                >
                  Undo 
                </button>
              </div>
            </div>

            <input
              className="player-search"
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
              placeholder="🔍 Search player..."
            />

            {currentBoth && (
              <div className="both-info">
                ⭐ BOTH player: <strong>{getPlayerName(currentBoth)}</strong>
              </div>
            )}

            <div className="available-players">
              {filteredPlayers.length === 0 ? (
                <div className="no-players">No players found.</div>
              ) : (
                filteredPlayers.map((player) => {
                  const inA = teamAHasPlayer(player.id);
                  const inB = teamBHasPlayer(player.id);
                  const selected = isPlayerSelected(player) || inA || inB;
                  const both = inA && inB;

                  return (
                    <div className="available-player" key={player.id}>
                      <div className="player-info">
                        <div className="player-avatar">
                          {getPlayerName(player).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <strong>{getPlayerName(player)}</strong>
                          <span>{player.type || "Player"}</span>
                        </div>
                      </div>

                      <div className="player-team-actions draft-player-actions">
                        {both ? (
                          <span className="team-tag both">BOTH</span>
                        ) : selected ? (
                          <span className="team-tag">Selected</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              className={`draft-team-button ${nextPickTeam === "A" ? "allowed" : "blocked"}`}
                              disabled={isTeamOptionBlocked(player, "A")}
                              onClick={() => selectPlayer(player, "A")}
                            >
                              {teamA.name}
                            </button>

                            <button
                              type="button"
                              className={`draft-team-button ${nextPickTeam === "B" ? "allowed" : "blocked"}`}
                              disabled={isTeamOptionBlocked(player, "B")}
                              onClick={() => selectPlayer(player, "B")}
                            >
                              {teamB.name}
                            </button>

                            <button
                              type="button"
                              className="draft-team-button both-button"
                              disabled={isTeamOptionBlocked(player, "BOTH")}
                              onClick={() => selectPlayer(player, "BOTH")}
                            >
                              BOTH
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="selected-teams-grid">
            <div className="selected-team-card">
              <div className="selected-team-header">
                <div>
                  <span>TEAM A</span>
                  <h3>{teamA.name}</h3>
                </div>
                <strong>{teamA.players.length}</strong>
              </div>

              {teamA.players.length === 0 ? (
                <p className="no-players">No players selected.</p>
              ) : (
                teamA.players.map((player) => (
                  <div className="selected-player" key={`A-${player.id}`}>
                    <div>
                      <strong>{getPlayerName(player)}</strong>
                      <span>{isBothPlayer(player) ? "BOTH" : teamA.name}</span>
                    </div>
                    {String(player.id) === String(captainA?.id) ? (
                      <span className="captain-lock">Captain</span>
                    ) : (
                      <button
                        type="button"
                        className="delete-player"
                        onClick={() => removePlayerFromTeam(player.id, "A")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="selected-team-card">
              <div className="selected-team-header">
                <div>
                  <span>TEAM B</span>
                  <h3>{teamB.name}</h3>
                </div>
                <strong>{teamB.players.length}</strong>
              </div>

              {teamB.players.length === 0 ? (
                <p className="no-players">No players selected.</p>
              ) : (
                teamB.players.map((player) => (
                  <div className="selected-player" key={`B-${player.id}`}>
                    <div>
                      <strong>{getPlayerName(player)}</strong>
                      <span>{isBothPlayer(player) ? "BOTH" : teamB.name}</span>
                    </div>
                    {String(player.id) === String(captainB?.id) ? (
                      <span className="captain-lock">Captain</span>
                    ) : (
                      <button
                        type="button"
                        className="delete-player"
                        onClick={() => removePlayerFromTeam(player.id, "B")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

         
          <button
            type="button"
            className="primary-button full-button"
            onClick={confirmTeams}
          >
            Confirm Teams →
          </button>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // EXISTING TEAMS
  // --------------------------------------------------

  if (screen === "existing-teams") {
   
const teamsWithPlayers = savedTeams.map((team) => {
  const teamId = String(
    team.teamId || team.id || ""
  );

  // ------------------------------------------------
  // PLAYER DOCUMENT MAP
  // ------------------------------------------------

  const playerMap = new Map();

  players.forEach((player) => {
    const playerId = String(
      player.id ??
        player.uid ??
        player.playerId ??
        ""
    );

    if (playerId) {
      playerMap.set(
        playerId,
        player
      );
    }
  });

  // ------------------------------------------------
  // FIRESTORE TEAM MEMBERSHIPS
  // ------------------------------------------------

  const memberships =
    savedTeamPlayers.filter(
      (item) =>
        String(item.teamId) ===
        teamId
    );

  // ------------------------------------------------
  // CONVERT MEMBERSHIPS INTO PLAYERS
  // ------------------------------------------------

  const membershipPlayers =
    memberships
      .map((item) => {
        const playerId = String(
          item.playerId || ""
        );

        // Prefer the full player document
        const fullPlayer =
          playerMap.get(playerId);

        if (fullPlayer) {
          return {
            ...fullPlayer,

            // Keep membership information
            // if it exists.
            battingPosition:
              item.battingPosition ??
              fullPlayer.battingPosition,

            battingHand:
              item.battingHand ??
              fullPlayer.battingHand,

            bowlingHand:
              item.bowlingHand ??
              fullPlayer.bowlingHand,

            bowlingStyle:
              item.bowlingStyle ??
              fullPlayer.bowlingStyle,

            type:
              fullPlayer.type ||
              item.role ||
              "",
          };
        }

        // Fallback if player document
        // is temporarily unavailable.
        return {
          id: playerId,
          uid: playerId,
          playerId: playerId,
          name:
            item.playerName ||
            "Unknown Player",
          email:
            item.playerEmail ||
            "",
          type:
            item.role ||
            "",
          battingPosition:
            item.battingPosition ||
            "",
          battingHand:
            item.battingHand ||
            "",
          bowlingHand:
            item.bowlingHand ||
            "",
          bowlingStyle:
            item.bowlingStyle ||
            "",
        };
      })
      .filter(
        (player) =>
          String(
            player.id ||
              player.uid ||
              player.playerId ||
              ""
          )
      );

  // ------------------------------------------------
  // OLD TEAM PLAYER IDS
  // Backward compatibility
  // ------------------------------------------------

  const oldPlayerIds =
    Array.isArray(team.playerIds)
      ? team.playerIds
      : [];

  const oldPlayers = oldPlayerIds
    .map((playerId) =>
      playerMap.get(
        String(playerId)
      )
    )
    .filter(Boolean);

  // ------------------------------------------------
  // OLD team.players SUPPORT
  // ------------------------------------------------

  const storedPlayers =
    Array.isArray(team.players)
      ? team.players
      : [];

  const resolvedStoredPlayers =
    storedPlayers
      .map((item) => {
        if (
          item &&
          typeof item === "object"
        ) {
          const id = String(
            item.id ??
              item.uid ??
              item.playerId ??
              ""
          );

          return (
            playerMap.get(id) ||
            item
          );
        }

        return playerMap.get(
          String(item)
        );
      })
      .filter(Boolean);

  // ------------------------------------------------
  // COMBINE EVERYTHING
  // ------------------------------------------------

  const uniquePlayers = new Map();

  [
    ...membershipPlayers,
    ...oldPlayers,
    ...resolvedStoredPlayers,
  ].forEach((player) => {
    const playerId = String(
      player.id ??
        player.uid ??
        player.playerId ??
        ""
    );

    if (!playerId) return;

    uniquePlayers.set(
      playerId,
      player
    );
  });

  return {
    ...team,

    // Always provide a usable name.
    name:
      team.name ||
      team.teamName ||
      "Unnamed Team",

    // Keep teamId available.
    teamId:
      team.teamId ||
      team.id,

    // Final verified player list.
    players:
      Array.from(
        uniquePlayers.values()
      ),
  };
});

    return (
      <>
        <ExistingTeamsScreen
          teams={teamsWithPlayers}
          players={players}
          onBack={() => setScreen("team-mode")}
          onContinue={(
            selectedA,
            selectedB,
            capA,
            capB,
            selectedOvers
          ) => {
            setTeamA({
              id: "A",
              teamId: selectedA.teamId || selectedA.id,
              name: selectedA.name || "Team A",
              captain: capA,
              players: selectedA.players || [],
            });

            setTeamB({
              id: "B",
              teamId: selectedB.teamId || selectedB.id,
              name: selectedB.name || "Team B",
              captain: capB,
              players: selectedB.players || [],
            });

            setCaptainA(capA);
            setCaptainB(capB);
            setMatchOvers(Number(selectedOvers) || 5);

            setFirstTossChoice(null);
            setFirstTossResult(null);
            setFirstTossWinner(null);
            setNextPickTeam(null);

            const existingA = selectedA.players || [];
            const existingB = selectedB.players || [];
            const existingIds = new Set();
            const existingDraft = [];

            existingA.forEach((player) => {
              const id = String(player.id);
              if (!existingIds.has(id)) {
                existingIds.add(id);
                existingDraft.push({ player, team: "A" });
              }
            });

            existingB.forEach((player) => {
              const id = String(player.id);
              const already = existingDraft.find(
                (item) => String(item.player.id) === id
              );

              if (already) {
                already.team = "BOTH";
              } else {
                existingIds.add(id);
                existingDraft.push({ player, team: "B" });
              }
            });

            setDraftSelections(existingDraft);
            setPlayerChoiceHistory([]);

            setFirstTossChoice(null);
            setFirstTossResult(null);
            setFirstTossWinner(null);
            setNextPickTeam(null);

            // Captain A is explicitly shown as the final toss caller in the existing UI.
            // Keep that caller deterministic so the Heads/Tails result matches the visible flow.
            setSecondTossCaller(capA);
            setSecondTossChoice(null);
            setSecondTossResult(null);
            setSecondTossWinner(null);

            setScreen("second-toss");
          }}
        />
      </>
    );
  }

  // --------------------------------------------------
  // SECOND TOSS
  // --------------------------------------------------

  if (screen === "second-toss") {
    return (
      <>
        <div className="page matches-page">
          <div className="setup-header">
            <p className="eyebrow">FINAL TOSS</p>

            <h2>Second Toss</h2>

            <p className="subtitle">
              {getPlayerName(captainA)} chooses first.
            </p>
          </div>

          <div className="toss-card">
            <div className="toss-captains">
              <div>
                <span>{teamA.name}</span>
                <strong>
                  {getPlayerName(captainA)}
                </strong>
              </div>

              <div className="toss-vs">VS</div>

              <div>
                <span>{teamB.name}</span>
                <strong>
                  {getPlayerName(captainB)}
                </strong>
              </div>
            </div>

            {!secondTossResult && (
              <>
                <h3>
                  {getPlayerName(captainA)}, choose
                </h3>

                {!secondTossChoice && (
                  <div className="toss-buttons">
                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseSecondToss("Heads")
                      }
                    >
                      🪙
                      <span>Heads</span>
                    </button>

                    <button
                      type="button"
                      className="toss-choice"
                      onClick={() =>
                        chooseSecondToss("Tails")
                      }
                    >
                      🪙
                      <span>Tails</span>
                    </button>
                  </div>
                )}
              </>
            )}

            {secondTossChoice &&
              !secondTossResult && (
                <CoinFlip spinning={secondTossSpinning} />
              )}

            {secondTossResult && (
              <div className="toss-result">
                <CoinFlip result={secondTossResult} spinning={secondTossSpinning} />

                <p>Toss result</p>

                <h2>{secondTossResult}</h2>

                <div className="toss-winner">
                  🏆{" "}
                  {getPlayerName(secondTossWinner)}
                  {" "}won the toss
                </div>

                <div className="winner-team">
                  {String(secondTossWinner.id) ===
                  String(captainA.id)
                    ? teamA.name
                    : teamB.name}
                </div>

                <button
                  type="button"
                  className="primary-button"
                  onClick={() =>
                    setScreen("bat-bowl")
                  }
                >
                  Continue →
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // BAT / BOWL
  // --------------------------------------------------

  if (screen === "bat-bowl") {
    const tossTeams = getTossTeams();

    if (!tossTeams) {
      setScreen("second-toss");
      return null;
    }

    const { winnerTeam } = tossTeams;

    return (
      <>
        <div className="page matches-page">
          <div className="setup-header">
            <p className="eyebrow">TOSS DECISION</p>

            <h2>
              {getPlayerName(secondTossWinner)}
              {" "}won the toss
            </h2>

            <p className="subtitle">
              What would you like to choose?
            </p>
          </div>

          <div className="bat-bowl-card">
            <div className="winner-highlight">
              🏆
              <strong>{winnerTeam.name}</strong>
              <span>Toss Winner</span>
            </div>

            <div className="bat-bowl-buttons">
              <button
                type="button"
                className="bat-button"
                onClick={chooseBat}
              >
                <span>🏏</span>
                <strong>BAT</strong>
                <small>Choose to bat first</small>
              </button>

              <button
                type="button"
                className="bowl-button"
                onClick={chooseBowl}
              >
                <span>⚾</span>
                <strong>BOWL</strong>
                <small>Choose to bowl first</small>
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // --------------------------------------------------
  // LEGACY SCORECARD ROUTE
  // --------------------------------------------------

  if (screen === "scorecard") {
    const currentMatch = matches[0];

    if (!currentMatch) {
      setScreen("list");
      return null;
    }

    navigate(`/scoring/${currentMatch.id}`);
    return null;
  }

  // --------------------------------------------------
  // VIEW SCORECARD
  // --------------------------------------------------

  if (screen === "view-scorecard") {
    if (!viewingMatch) {
      setScreen("list");
      return null;
    }

    return (
      <>
        <div className="page matches-page">
          <button
            type="button"
            className="back-button"
            onClick={() => {
              setViewingMatch(null);
              setScreen("list");
            }}
          >
            ← Back to Matches
          </button>

          <div className="setup-header">
            <p className="eyebrow">SCORECARD</p>

            <h2>
              {viewingMatch.teamA.name}
              {" "}vs{" "}
              {viewingMatch.teamB.name}
            </h2>

            <p className="subtitle">
              {formatDate(viewingMatch.createdAt)}
              {" • "}
              {formatTime(viewingMatch.createdAt)}
            </p>
          </div>

          <div className="view-scorecard-card">
            <div className="status-row">
              {viewingMatch.status === "live" && (
                <span className="live-badge">
                  <span className="live-dot"></span>
                  LIVE
                </span>
              )}

              {viewingMatch.status === "unfinished" && (
                <span className="unfinished-badge">
                  UNFINISHED
                </span>
              )}

              {viewingMatch.status === "finished" && (
                <span className="finished-badge">
                  FINISHED
                </span>
              )}
            </div>

            <div className="scorecard-teams">
              <div>
                
                <strong>
                  {viewingMatch.teamA.name}{getTossWinnerTeamId(viewingMatch) === "A" && (
                  <small className="scorecard-toss-badge">
                    <small className="scorecard-toss-coin">
                      {viewingMatch.secondTossResult === "Tails" ? "T" : "H"}
                    </small>
                    {/* Toss winner */}
                  </small>
                )}
                
                </strong>


                <span>
                  {viewingMatch.scoreA || 0}/
                  {viewingMatch.wicketsA || 0}
                </span>
              </div>

              <div className="score-vs">VS</div>

              <div>
                
                <strong>
                  {viewingMatch.teamB.name}
 {getTossWinnerTeamId(viewingMatch) === "B" && (
                  <small className="scorecard-toss-badge">
                    <small className="scorecard-toss-coin">
                      {viewingMatch.secondTossResult === "Tails" ? "T" : "H"}
                    </small>
                    {/* Toss winner */}
                  </small>
                )}
               

                </strong>


                <span>
                  {viewingMatch.scoreB || 0}/
                  {viewingMatch.wicketsB || 0}
                </span>
              </div>
            </div>

            {(viewingMatch.winner ||
              getMatchResultText(viewingMatch)) && (
              <div className="scorecard-winner">
                {getMatchResultText(viewingMatch).toLowerCase().includes("draw") ||
                getMatchResultText(viewingMatch).toLowerCase().includes("tie")
                  ? "🤝"
                  : "🏆"}{" "}
                {getMatchResultText(viewingMatch) ||
                  viewingMatch.winner}
              </div>
            )}

            <div className="scorecard-info-grid">
              <div>
                <span>Overs</span>
                <strong>
                  {viewingMatch.overs}
                </strong>
              </div>

              <div>
                <span>Batting First</span>
                <strong>
                  {viewingMatch.battingTeam}
                </strong>
              </div>

              <div>
                <span>Bowling First</span>
                <strong>
                  {viewingMatch.bowlingTeam}
                </strong>
              </div>
            </div>
          </div>

          <MatchScorecard match={viewingMatch} />
        </div>
      </>
    );
  }

  return null;
}

// ==================================================
// EXISTING TEAMS COMPONENT
// ==================================================

function ExistingTeamsScreen({
  teams,
  players,
  onBack,
  onContinue,
}) {
  const [teamAId, setTeamAId] = useState("");
  const [teamBId, setTeamBId] = useState("");

  const [captainAId, setCaptainAId] = useState("");
  const [captainBId, setCaptainBId] = useState("");
  const [selectedOvers, setSelectedOvers] = useState("5");

  // --------------------------------------------------
  // SAFE ID HELPER
  // --------------------------------------------------

  const getId = (item) => {
    if (!item) return "";

    if (typeof item === "string" || typeof item === "number") {
      return String(item);
    }

    return String(
      item.id ??
        item.uid ??
        item.playerId ??
        item.teamId ??
        ""
    );
  };

  // --------------------------------------------------
  // SAFE NAME HELPERS
  // --------------------------------------------------

  const getTeamName = (team) => {
    return (
      team?.name ||
      team?.teamName ||
      "Unnamed Team"
    );
  };

  const getPlayerName = (player) => {
    return (
      player?.name ||
      player?.playerName ||
      "Unknown Player"
    );
  };

  // --------------------------------------------------
  // SELECTED TEAMS
  // --------------------------------------------------

  const selectedA = teams.find(
    (team) =>
      getId(team) === String(teamAId)
  );

  const selectedB = teams.find(
    (team) =>
      getId(team) === String(teamBId)
  );

  // --------------------------------------------------
  // GET PLAYERS BELONGING TO A TEAM
  // --------------------------------------------------

const getTeamPlayers = (team) => {
  if (!team) return [];

  const teamId = String(
    team.teamId ?? team.id ?? ""
  );

  if (!teamId) return [];

  // First priority: players already attached to this team
  const teamPlayerList = Array.isArray(team.players)
    ? team.players
    : [];

  // Global player lookup
  const playerMap = new Map(
    players.map((player) => [
      String(
        player.id ??
        player.uid ??
        player.playerId ??
        ""
      ),
      player,
    ])
  );

  const resolvedPlayers = [];

  teamPlayerList.forEach((item) => {
    const playerId =
      typeof item === "object"
        ? String(
            item.playerId ??
            item.id ??
            item.uid ??
            ""
          )
        : String(item);

    if (!playerId) return;

    // Resolve the player from global players,
    // but ONLY if that player is actually listed
    // in this team's player list.
    const globalPlayer = playerMap.get(playerId);

    if (globalPlayer) {
      resolvedPlayers.push({
        ...globalPlayer,
        ...(
          typeof item === "object"
            ? item
            : {}
        ),
        id: playerId,
      });
    } else if (typeof item === "object") {
      resolvedPlayers.push({
        ...item,
        id: playerId,
      });
    }
  });

  // Remove duplicate players
  return Array.from(
    new Map(
      resolvedPlayers.map((player) => [
        String(
          player.id ??
          player.uid ??
          player.playerId
        ),
        player,
      ])
    ).values()
  );
};
  const playersA =
    getTeamPlayers(selectedA);

  const playersB =
    getTeamPlayers(selectedB);

  // --------------------------------------------------
  // SELECTED CAPTAINS
  // IMPORTANT:
  // Captain A can ONLY come from Team A
  // Captain B can ONLY come from Team B
  // --------------------------------------------------

  const captainA = playersA.find(
    (player) =>
      getId(player) ===
      String(captainAId)
  );

  const captainB = playersB.find(
    (player) =>
      getId(player) ===
      String(captainBId)
  );

  // --------------------------------------------------
  // TEAM A CHANGE
  // --------------------------------------------------

  const handleTeamAChange = (e) => {
    const newTeamId = e.target.value;

    setTeamAId(newTeamId);

    // Changing the team invalidates
    // the previously selected captain.
    setCaptainAId("");

    // If somehow the same team was selected,
    // clear Team B captain as well.
    if (
      newTeamId &&
      newTeamId === String(teamBId)
    ) {
      setTeamBId("");
      setCaptainBId("");
    }
  };

  // --------------------------------------------------
  // TEAM B CHANGE
  // --------------------------------------------------

  const handleTeamBChange = (e) => {
    const newTeamId = e.target.value;

    setTeamBId(newTeamId);

    // Changing the team invalidates
    // the previously selected captain.
    setCaptainBId("");

    if (
      newTeamId &&
      newTeamId === String(teamAId)
    ) {
      setTeamAId("");
      setCaptainAId("");
    }
  };

  // --------------------------------------------------
  // CAPTAIN A CHANGE
  // --------------------------------------------------

  const handleCaptainAChange = (e) => {
    const newCaptainId =
      e.target.value;

    // Empty selection
    if (!newCaptainId) {
      setCaptainAId("");
      return;
    }

    // Make sure this player actually belongs
    // to Team A.
    const playerBelongsToA =
      playersA.some(
        (player) =>
          getId(player) ===
          String(newCaptainId)
      );

    if (!playerBelongsToA) {
      alert(
        "This player does not belong to Team A."
      );
      return;
    }

    // Same player cannot captain both teams.
    if (
      String(newCaptainId) ===
      String(captainBId)
    ) {
      alert(
        "The same player cannot be captain of both teams."
      );
      return;
    }

    setCaptainAId(
      newCaptainId
    );
  };

  // --------------------------------------------------
  // CAPTAIN B CHANGE
  // --------------------------------------------------

  const handleCaptainBChange = (e) => {
    const newCaptainId =
      e.target.value;

    if (!newCaptainId) {
      setCaptainBId("");
      return;
    }

    // Make sure this player actually belongs
    // to Team B.
    const playerBelongsToB =
      playersB.some(
        (player) =>
          getId(player) ===
          String(newCaptainId)
      );

    if (!playerBelongsToB) {
      alert(
        "This player does not belong to Team B."
      );
      return;
    }

    // Same player cannot captain both teams.
    if (
      String(newCaptainId) ===
      String(captainAId)
    ) {
      alert(
        "The same player cannot be captain of both teams."
      );
      return;
    }

    setCaptainBId(
      newCaptainId
    );
  };

  // --------------------------------------------------
  // CONTINUE
  // --------------------------------------------------

  const continueSetup = () => {
    // Teams
    if (!selectedA || !selectedB) {
      alert(
        "Please select both teams."
      );
      return;
    }

    // Same team
    if (
      getId(selectedA) ===
      getId(selectedB)
    ) {
      alert(
        "Please select two different teams."
      );
      return;
    }

    // Captains
    if (!captainA || !captainB) {
      alert(
        "Please select both captains."
      );
      return;
    }

    // Same captain
    if (
      getId(captainA) ===
      getId(captainB)
    ) {
      alert(
        "Captains must be different players."
      );
      return;
    }

    // Captain A must belong to Team A
    const captainAInTeamA =
      playersA.some(
        (player) =>
          getId(player) ===
          getId(captainA)
      );

    // Captain B must belong to Team B
    const captainBInTeamB =
      playersB.some(
        (player) =>
          getId(player) ===
          getId(captainB)
      );

    if (!captainAInTeamA) {
      alert(
        `${getPlayerName(captainA)} does not belong to ${getTeamName(selectedA)}.`
      );
      return;
    }

    if (!captainBInTeamB) {
      alert(
        `${getPlayerName(captainB)} does not belong to ${getTeamName(selectedB)}.`
      );
      return;
    }

    // A player cannot be captain for both teams.
    if (
      getId(captainA) ===
      getId(captainB)
    ) {
      alert(
        "The same player cannot be captain for both teams."
      );
      return;
    }

    // Make sure both teams actually contain players.
    if (!playersA.length) {
      alert(
        `${getTeamName(selectedA)} has no players.`
      );
      return;
    }

    if (!playersB.length) {
      alert(
        `${getTeamName(selectedB)} has no players.`
      );
      return;
    }

    // ------------------------------------------------
    // SEND ONLY VERIFIED TEAM PLAYERS + CAPTAINS
    // ------------------------------------------------

    onContinue(
      {
        ...selectedA,
        name: getTeamName(selectedA),
        players: playersA,
      },
      {
        ...selectedB,
        name: getTeamName(selectedB),
        players: playersB,
      },
      captainA,
      captainB,
      selectedOvers
    );
  };

  // ==================================================
  // UI
  // ==================================================

  return (
    <div className="page matches-page">

      <button
        type="button"
        className="back-button"
        onClick={onBack}
      >
        ← Back
      </button>

      <div className="setup-header">
        <p className="eyebrow">
          EXISTING TEAMS
        </p>

        <h2>
          Select Teams
        </h2>

        <p className="subtitle">
          Select two teams and their captains.
        </p>
      </div>

      <div className="existing-team-grid">

        {/* ==============================
            TEAM A
        ============================== */}

        <div className="setup-card">

          <h3>Team A</h3>

          <select
            value={teamAId}
            onChange={handleTeamAChange}
          >
            <option value="">
              Select Team A
            </option>

            {teams.map((team) => {
              const id = getId(team);

              return (
                <option
                  key={id}
                  value={id}
                  disabled={
                    id ===
                    String(teamBId)
                  }
                >
                  {getTeamName(team)}
                </option>
              );
            })}
          </select>

          {/* Team A captain */}

          {selectedA && (
            <>
              <label>
                Captain
              </label>

              <select
                value={captainAId}
                onChange={
                  handleCaptainAChange
                }
              >
                <option value="">
                  Select Captain for{" "}
                  {getTeamName(selectedA)}
                </option>

                {playersA.length === 0 ? (
                  <option disabled>
                    No players found in this team
                  </option>
                ) : (
                  playersA.map((player) => {
                    const playerId =
                      getId(player);

                    return (
                      <option
                        key={playerId}
                        value={playerId}
                        disabled={
                          playerId ===
                          String(captainBId)
                        }
                      >
                        {getPlayerName(player)}
                      </option>
                    );
                  })
                )}
              </select>
            </>
          )}

        </div>

        {/* ==============================
            TEAM B
        ============================== */}

        <div className="setup-card">

          <h3>Team B</h3>

          <select
            value={teamBId}
            onChange={handleTeamBChange}
          >
            <option value="">
              Select Team B
            </option>

            {teams.map((team) => {
              const id = getId(team);

              return (
                <option
                  key={id}
                  value={id}
                  disabled={
                    id ===
                    String(teamAId)
                  }
                >
                  {getTeamName(team)}
                </option>
              );
            })}
          </select>

          {/* Team B captain */}

          {selectedB && (
            <>
              <label>
                Captain
              </label>

              <select
                value={captainBId}
                onChange={
                  handleCaptainBChange
                }
              >
                <option value="">
                  Select Captain for{" "}
                  {getTeamName(selectedB)}
                </option>

                {playersB.length === 0 ? (
                  <option disabled>
                    No players found in this team
                  </option>
                ) : (
                  playersB.map((player) => {
                    const playerId =
                      getId(player);

                    return (
                      <option
                        key={playerId}
                        value={playerId}
                        disabled={
                          playerId ===
                          String(captainAId)
                        }
                      >
                        {getPlayerName(player)}
                      </option>
                    );
                  })
                )}
              </select>
            </>
          )}

        </div>

      </div>

      <div className="setup-card">
        <label htmlFor="existing-match-overs">Match Overs</label>
        <select
          id="existing-match-overs"
          value={selectedOvers}
          onChange={(e) => setSelectedOvers(e.target.value)}
        >
          <option value="1">1 Over</option>
          <option value="2">2 Overs</option>
          <option value="3">3 Overs</option>
          <option value="4">4 Overs</option>
          <option value="5">5 Overs</option>
          <option value="6">6 Overs</option>
          <option value="7">7 Overs</option>
          <option value="8">8 Overs</option>
          <option value="9">9 Overs</option>
          <option value="10">10 Overs</option>
          <option value="15">15 Overs</option>
        </select>
      </div>

      {/* ==============================
          CONTINUE
      ============================== */}

      <button
        type="button"
        className="primary-button full-button"
        onClick={continueSetup}
      >
        Continue to Toss →
      </button>

    </div>
  );
}


export default Matches;