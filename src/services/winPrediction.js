/* =========================================================
   SCORIFY - LIVE WIN PREDICTION
   ---------------------------------------------------------
   Browser-only, derived prediction logic.
   This module NEVER writes to Firebase/local persistence.

   Input sources already used by Scorify:
   - match.teamA / match.teamB or teamAPlayers / teamBPlayers
   - match.firstInningsData / secondInningsData
   - match.scoringState
   - scoringState.deliveries / battingStats / bowlingStats
   - match.result / winner / resultText
   - optional head-to-head fields when they already exist on match
   ========================================================= */

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const hasOwn = (object, key) =>
  Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);

const clamp = (value, min, max) => {
  const number = toNumber(value, min);
  return Math.min(max, Math.max(min, number));
};

const round1 = (value) => Number(toNumber(value).toFixed(1));
const round2 = (value) => Number(toNumber(value).toFixed(2));

const normaliseId = (value) => String(value ?? "").trim();

const playerId = (player) =>
  normaliseId(
    typeof player === "string"
      ? player
      : player?.id ??
          player?._id ??
          player?.uid ??
          player?.playerId ??
          player?.name ??
          player?.playerName
  );

const playerName = (player) =>
  typeof player === "string"
    ? player
    : player?.name || player?.playerName || "Unknown Player";

const uniquePlayers = (players) => {
  const list = Array.isArray(players) ? players : [];
  const map = new Map();

  list.forEach((player) => {
    const id = playerId(player);
    if (id && !map.has(id)) {
      map.set(id, player);
    }
  });

  return [...map.values()];
};

const playersForTeam = (team, fallback = []) =>
  uniquePlayers(
    team?.players ??
      team?.teamPlayers ??
      team?.members ??
      fallback
  );

const teamName = (team, fallback) =>
  team?.name || team?.teamName || team?.title || fallback;

const getTeams = (match) => {
  const teamAPlayers =
    match?.teamAPlayers ||
    match?.teamA?.players ||
    match?.teamA?.teamPlayers ||
    [];

  const teamBPlayers =
    match?.teamBPlayers ||
    match?.teamB?.players ||
    match?.teamB?.teamPlayers ||
    [];

  return {
    A: {
      ...(match?.teamA || {}),
      id: "A",
      name: teamName(match?.teamA, match?.teamAName || "Team A"),
      players: uniquePlayers(teamAPlayers),
    },
    B: {
      ...(match?.teamB || {}),
      id: "B",
      name: teamName(match?.teamB, match?.teamBName || "Team B"),
      players: uniquePlayers(teamBPlayers),
    },
  };
};

const statsLookup = (stats, id) => {
  const key = normaliseId(id);
  if (!key || !stats) return {};

  if (Array.isArray(stats)) {
    return (
      stats.find(
        (stat) =>
          normaliseId(
            stat?.playerId ??
              stat?.uid ??
              stat?.id ??
              stat?._id
          ) === key
      ) || {}
    );
  }

  if (typeof stats === "object") {
    return stats[key] || stats[id] || {};
  }

  return {};
};

const collectStats = (stats, id) => {
  const key = normaliseId(id);
  if (!key || !stats) return [];

  if (Array.isArray(stats)) {
    return stats.filter(
      (stat) =>
        normaliseId(
          stat?.playerId ??
            stat?.uid ??
            stat?.id ??
            stat?._id
        ) === key
    );
  }

  const stat = statsLookup(stats, key);
  return Object.keys(stat).length ? [stat] : [];
};

/* =========================================================
   PLAYER / TEAM STRENGTH
   ---------------------------------------------------------
   This mirrors Scorify's existing role-based strength defaults.
   Explicit player rating/strength fields are respected when present.
   ========================================================= */

const numericPlayerRating = (player) => {
  const raw =
    player?.strength ??
    player?.playerStrength ??
    player?.rating ??
    player?.overallRating;

  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const number = Number(raw);
  if (!Number.isFinite(number)) return null;

  // Support either the app's 0-100 style or common 0-10 ratings.
  if (number > 0 && number <= 10) {
    return clamp(number * 10, 1, 100);
  }

  return clamp(number, 1, 100);
};

const roleStrength = (player) => {
  let strength = 50;

  if (player?.type === "Batsman") strength += 12;
  if (player?.type === "Bowler") strength += 12;
  if (player?.type === "All-rounder") strength += 18;
  if (player?.type === "Wicketkeeper") strength += 10;

  if (player?.battingPosition === "Opener") strength += 4;
  if (player?.battingPosition === "Middle order") strength += 3;
  if (player?.battingPosition === "Finisher") strength += 5;

  if (player?.bowlingStyle === "Full pacer") strength += 5;
  if (player?.bowlingStyle === "Medium pacer") strength += 3;
  if (player?.bowlingStyle === "Spinner") strength += 4;

  return clamp(strength, 1, 100);
};

const historicalFormStrength = (player, battingStats, bowlingStats) => {
  const id = playerId(player);
  if (!id) return roleStrength(player);

  const batting = collectStats(battingStats, id);
  const bowling = collectStats(bowlingStats, id);

  if (!batting.length && !bowling.length) {
    return roleStrength(player);
  }

  const matchIds = new Set(
    [...batting, ...bowling]
      .map((stat) => stat?.matchId ?? stat?.matchID)
      .filter((value) => value !== undefined && value !== null && value !== "")
      .map(String)
  );

  const explicitMatches = toNumber(
    player?.matchesPlayed ?? player?.matches,
    0
  );
  const matchesPlayed =
    matchIds.size || explicitMatches;

  if (!matchesPlayed) {
    return roleStrength(player);
  }

  const runs = batting.reduce(
    (sum, stat) => sum + toNumber(stat?.runs),
    0
  );
  const wickets = bowling.reduce(
    (sum, stat) => sum + toNumber(stat?.wickets),
    0
  );

  // Keep historical form as a modest adjustment, not the whole rating.
  const formScore = (runs + wickets * 20) / matchesPlayed;
  const formNormalised = clamp(50 + formScore * 0.85, 1, 100);
  const base = roleStrength(player);

  return clamp(base * 0.72 + formNormalised * 0.28, 1, 100);
};

const playerStrength = (player, battingStats, bowlingStats) => {
  const explicit = numericPlayerRating(player);
  if (explicit !== null) {
    return explicit;
  }

  return historicalFormStrength(player, battingStats, bowlingStats);
};

const teamStrength = (team, battingStats, bowlingStats) => {
  const players = playersForTeam(team);
  if (!players.length) return 50;

  const total = players.reduce(
    (sum, player) =>
      sum + playerStrength(player, battingStats, bowlingStats),
    0
  );

  return clamp(total / players.length, 1, 100);
};

const roleBattingWeight = (player) => {
  if (player?.type === "Batsman") return 1.08;
  if (player?.type === "All-rounder") return 1.05;
  if (player?.type === "Wicketkeeper") return 1.03;
  if (player?.type === "Bowler") return 0.92;
  return 1;
};

const roleBowlingWeight = (player) => {
  if (player?.type === "Bowler") return 1.08;
  if (player?.type === "All-rounder") return 1.05;
  return 0.95;
};

const weightedTeamStrength = (
  team,
  battingStats,
  bowlingStats,
  kind = "batting"
) => {
  const players = playersForTeam(team);
  if (!players.length) return 50;

  let weightedTotal = 0;
  let totalWeight = 0;

  players.forEach((player) => {
    const weight =
      kind === "bowling"
        ? roleBowlingWeight(player)
        : roleBattingWeight(player);
    weightedTotal +=
      playerStrength(player, battingStats, bowlingStats) * weight;
    totalWeight += weight;
  });

  return totalWeight
    ? clamp(weightedTotal / totalWeight, 1, 100)
    : 50;
};

const currentBatterStrength = (team, stats, id, battingStats, bowlingStats) => {
  const key = normaliseId(id);
  if (!key) return 50;

  const player = playersForTeam(team).find(
    (candidate) => playerId(candidate) === key
  );
  if (!player) return 50;

  const stat = statsLookup(stats, key);
  const runs = toNumber(stat?.runs);
  const balls = toNumber(stat?.balls);
  const strikeRate = balls > 0 ? (runs / balls) * 100 : 0;

  const formBoost = balls > 0
    ? clamp((strikeRate - 100) * 0.06, -6, 6)
    : 0;

  return clamp(
    playerStrength(player, battingStats, bowlingStats) + formBoost,
    1,
    100
  );
};

const currentBowlerStrength = (team, stats, id, battingStats, bowlingStats) => {
  const key = normaliseId(id);
  if (!key) return 50;

  const player = playersForTeam(team).find(
    (candidate) => playerId(candidate) === key
  );
  if (!player) return 50;

  const stat = statsLookup(stats, key);
  const runs = toNumber(stat?.runs);
  const balls = toNumber(stat?.legalBalls ?? stat?.balls);
  const economy = balls > 0 ? (runs / balls) * 6 : 0;

  // Lower economy is better. Adjustment is deliberately small.
  const economyAdjustment = balls > 0
    ? clamp((6 - economy) * 1.8, -6, 6)
    : 0;

  return clamp(
    playerStrength(player, battingStats, bowlingStats) + economyAdjustment,
    1,
    100
  );
};

/* =========================================================
   INNINGS / DELIVERY HELPERS
   ========================================================= */

const readTeamId = (value) => {
  const id = normaliseId(value).toUpperCase();
  return id === "A" || id === "B" ? id : null;
};

const teamIdFromName = (name, teams) => {
  const value = normaliseId(name).toLowerCase();
  if (!value) return null;

  if (value === normaliseId(teams.A.name).toLowerCase()) return "A";
  if (value === normaliseId(teams.B.name).toLowerCase()) return "B";
  return null;
};

const firstInningsTeamId = (match, teams) => {
  const direct =
    readTeamId(match?.firstInningsTeamId) ||
    readTeamId(match?.firstInningsData?.teamId) ||
    readTeamId(match?.firstBattingTeamId);

  if (direct) return direct;

  const fromName =
    teamIdFromName(match?.firstInningsTeam, teams) ||
    teamIdFromName(match?.firstInningsData?.teamName, teams) ||
    teamIdFromName(match?.battingTeam, teams);

  if (fromName) return fromName;

  // Scoring currently defaults to Team A when no toss/batting team is stored.
  return "A";
};

const getScoringState = (match, suppliedState) => {
  if (suppliedState && typeof suppliedState === "object") {
    return suppliedState;
  }

  return match?.scoringState && typeof match.scoringState === "object"
    ? match.scoringState
    : null;
};

const isLegalDelivery = (delivery) => {
  if (!delivery || typeof delivery !== "object") return false;
  if (typeof delivery.validBall === "boolean") return delivery.validBall;

  const type = normaliseId(delivery.type).toUpperCase();
  if (["NB", "WD", "DEAD", "NO_BALL", "WIDE"].includes(type)) {
    return false;
  }

  return true;
};

const deliveryRuns = (delivery) => {
  if (!delivery || typeof delivery !== "object") return 0;

  // Scoring stores total team runs in `runs` for normal/extras deliveries.
  if (hasOwn(delivery, "runs")) {
    return Math.max(0, toNumber(delivery.runs));
  }

  const batterRuns = toNumber(delivery.batterRuns);
  const extras = toNumber(delivery.extras);
  return Math.max(0, batterRuns + extras);
};

const deliveryHasWicket = (delivery) => {
  if (!delivery || typeof delivery !== "object") return false;
  return Boolean(delivery.wicket);
};

const calculateDeliveryTotals = (deliveries) => {
  const list = Array.isArray(deliveries) ? deliveries : [];

  return list.reduce(
    (total, delivery) => {
      total.runs += deliveryRuns(delivery);
      if (isLegalDelivery(delivery)) total.legalBalls += 1;
      if (deliveryHasWicket(delivery)) total.wickets += 1;
      return total;
    },
    { runs: 0, wickets: 0, legalBalls: 0 }
  );
};

const recentSixDeliveries = (deliveries) => {
  const list = Array.isArray(deliveries) ? deliveries : [];
  return list.slice(-6);
};

const recentRuns = (deliveries) =>
  recentSixDeliveries(deliveries).reduce(
    (sum, delivery) => sum + deliveryRuns(delivery),
    0
  );

const recentWickets = (deliveries) =>
  recentSixDeliveries(deliveries).filter(deliveryHasWicket).length;

const getInningsData = (match, scoringState, inningsIndex, firstTeamId) => {
  const secondTeamId = firstTeamId === "A" ? "B" : "A";

  if (inningsIndex === 0) {
    return {
      ...(match?.firstInningsData || {}),
      teamId: firstTeamId,
      runs:
        scoringState && hasOwn(scoringState, "inningsRuns")
          ? toNumber(scoringState.inningsRuns)
          : toNumber(match?.firstInningsData?.runs ?? match?.[`score${firstTeamId}`]),
      wickets:
        scoringState && hasOwn(scoringState, "inningsWickets")
          ? toNumber(scoringState.inningsWickets)
          : toNumber(match?.firstInningsData?.wickets ?? match?.[`wickets${firstTeamId}`]),
      balls:
        scoringState && hasOwn(scoringState, "legalBalls")
          ? toNumber(scoringState.legalBalls)
          : toNumber(match?.firstInningsData?.balls),
      battingStats:
        scoringState?.battingStats ??
        match?.firstInningsData?.battingStats ??
        {},
      bowlingStats:
        scoringState?.bowlingStats ??
        match?.firstInningsData?.bowlingStats ??
        {},
      deliveries:
        Array.isArray(scoringState?.deliveries)
          ? scoringState.deliveries
          : Array.isArray(match?.firstInningsData?.deliveries)
          ? match.firstInningsData.deliveries
          : [],
    };
  }

  return {
    ...(match?.secondInningsData || {}),
    teamId: secondTeamId,
    runs:
      scoringState && hasOwn(scoringState, "inningsRuns")
        ? toNumber(scoringState.inningsRuns)
        : toNumber(match?.secondInningsData?.runs ?? match?.[`score${secondTeamId}`]),
    wickets:
      scoringState && hasOwn(scoringState, "inningsWickets")
        ? toNumber(scoringState.inningsWickets)
        : toNumber(match?.secondInningsData?.wickets ?? match?.[`wickets${secondTeamId}`]),
    balls:
      scoringState && hasOwn(scoringState, "legalBalls")
        ? toNumber(scoringState.legalBalls)
        : toNumber(match?.secondInningsData?.balls),
    battingStats:
      scoringState?.battingStats ??
      match?.secondInningsData?.battingStats ??
      {},
    bowlingStats:
      scoringState?.bowlingStats ??
      match?.secondInningsData?.bowlingStats ??
      {},
    deliveries:
      Array.isArray(scoringState?.deliveries)
        ? scoringState.deliveries
        : Array.isArray(match?.secondInningsData?.deliveries)
        ? match.secondInningsData.deliveries
        : [],
  };
};

const buildLiveContext = (match, scoringState) => {
  const teams = getTeams(match);
  const firstTeamId = firstInningsTeamId(match, teams);
  const secondTeamId = firstTeamId === "A" ? "B" : "A";

  const suppliedIndex = readTeamId(scoringState?.inningsIndex);
  const inningsIndex =
    Number(scoringState?.inningsIndex) === 1 ? 1 : 0;

  const battingTeamId =
    inningsIndex === 1
      ? secondTeamId
      : firstTeamId;

  const battingTeam = teams[battingTeamId];
  const bowlingTeam = teams[battingTeamId === "A" ? "B" : "A"];
  const innings = getInningsData(
    match,
    scoringState,
    inningsIndex,
    firstTeamId
  );

  return {
    teams,
    firstTeamId,
    secondTeamId,
    inningsIndex,
    battingTeamId,
    battingTeam,
    bowlingTeam,
    innings,
    suppliedIndex,
  };
};

/* =========================================================
   HEAD-TO-HEAD
   ---------------------------------------------------------
   Only use H2H values that are already present on the match.
   No synthetic historical data is created.
   ========================================================= */

const parseH2HWinner = (value, teams) => {
  if (value === null || value === undefined) return null;

  if (typeof value === "object") {
    return (
      parseH2HWinner(value.winnerId, teams) ||
      parseH2HWinner(value.winner, teams) ||
      parseH2HWinner(value.teamId, teams) ||
      parseH2HWinner(value.result, teams)
    );
  }

  const text = String(value).trim().toLowerCase();
  if (!text) return null;

  if (text === "a" || text === normaliseId(teams.A.id).toLowerCase()) return "A";
  if (text === "b" || text === normaliseId(teams.B.id).toLowerCase()) return "B";

  if (
    text === normaliseId(teams.A.name).toLowerCase() ||
    text.includes(`${normaliseId(teams.A.name).toLowerCase()} won`) ||
    text.includes(`${normaliseId(teams.A.name).toLowerCase()} wins`)
  ) {
    return "A";
  }

  if (
    text === normaliseId(teams.B.name).toLowerCase() ||
    text.includes(`${normaliseId(teams.B.name).toLowerCase()} won`) ||
    text.includes(`${normaliseId(teams.B.name).toLowerCase()} wins`)
  ) {
    return "B";
  }

  if (["draw", "drawn", "tie", "tied", "match drawn", "match tied"].includes(text)) {
    return "D";
  }

  return null;
};

const extractH2H = (match, teams) => {
  const sources = [
    match?.headToHead,
    match?.headToHeadHistory,
    match?.h2h,
    match?.h2hHistory,
    match?.teamHeadToHead,
  ];

  const source = sources.find((candidate) => {
    if (Array.isArray(candidate)) return candidate.length > 0;
    return candidate && typeof candidate === "object";
  });

  if (!source) return null;

  let aWins = 0;
  let bWins = 0;
  let draws = 0;

  const addWinner = (winner) => {
    const parsed = parseH2HWinner(winner, teams);
    if (parsed === "A") aWins += 1;
    else if (parsed === "B") bWins += 1;
    else if (parsed === "D") draws += 1;
  };

  if (Array.isArray(source)) {
    source.forEach((item) => {
      addWinner(
        item?.winnerId ??
          item?.winner ??
          item?.teamId ??
          item?.result ??
          item
      );
    });
  } else {
    const history =
      Array.isArray(source.history) ? source.history :
      Array.isArray(source.matches) ? source.matches :
      Array.isArray(source.results) ? source.results : null;

    if (history) {
      history.forEach(addWinner);
    }

    aWins += toNumber(
      source.aWins ??
        source.teamAWins ??
        source.team1Wins ??
        source.teamA?.wins
    );
    bWins += toNumber(
      source.bWins ??
        source.teamBWins ??
        source.team2Wins ??
        source.teamB?.wins
    );
    draws += toNumber(
      source.draws ??
        source.ties ??
        source.tied ??
        source.teamADraws ??
        source.teamBDraws
    );
  }

  const total = aWins + bWins + draws;
  if (!total) return null;

  return {
    aWins,
    bWins,
    draws,
    total,
  };
};

/* =========================================================
   RESULT / TERMINAL STATE
   ========================================================= */

const readResultText = (match, scoringState) =>
  String(
    match?.resultText ||
      match?.result?.text ||
      match?.winner ||
      scoringState?.result?.text ||
      ""
  ).trim();

const resolvedWinner = (match, scoringState, teams) => {
  const explicitWinner =
    match?.winner ??
    match?.result?.winner ??
    scoringState?.result?.winner;

  if (explicitWinner === null || explicitWinner === "") {
    const resultText = readResultText(match, scoringState).toLowerCase();
    if (resultText.includes("draw") || resultText.includes("tie")) {
      return "D";
    }
  }

  if (typeof explicitWinner === "object") {
    return resolvedWinner(
      { ...match, winner: explicitWinner?.name ?? explicitWinner?.id ?? explicitWinner?.winnerId },
      scoringState,
      teams
    );
  }

  const explicit = normaliseId(explicitWinner).toLowerCase();
  if (explicit === "a" || explicit === normaliseId(teams.A.name).toLowerCase()) return "A";
  if (explicit === "b" || explicit === normaliseId(teams.B.name).toLowerCase()) return "B";
  if (["draw", "drawn", "tie", "tied", "match drawn", "match tied"].includes(explicit)) return "D";

  const resultText = readResultText(match, scoringState).toLowerCase();
  if (resultText.includes(normaliseId(teams.A.name).toLowerCase())) return "A";
  if (resultText.includes(normaliseId(teams.B.name).toLowerCase())) return "B";
  if (resultText.includes("draw") || resultText.includes("tie")) return "D";

  // A finished match with final numeric scores can still resolve without winner text.
  const status = normaliseId(match?.status).toLowerCase();
  const scoreA = Number(match?.scoreA);
  const scoreB = Number(match?.scoreB);
  if ((status === "finished" || status === "completed") && Number.isFinite(scoreA) && Number.isFinite(scoreB)) {
    if (scoreA > scoreB) return "A";
    if (scoreB > scoreA) return "B";
    return "D";
  }

  return null;
};

const isFinished = (match, winner) => {
  const status = normaliseId(match?.status).toLowerCase();
  return (
    status === "finished" ||
    status === "completed" ||
    winner !== null
  );
};

/* =========================================================
   PROBABILITY HELPERS
   ========================================================= */

const logistic = (value) => {
  const x = clamp(value, -12, 12);
  return 1 / (1 + Math.exp(-x));
};

const probabilityFromScoreDifference = (scoreDifference, scale) =>
  clamp(logistic(scoreDifference / Math.max(1, scale)) * 100, 1, 99);

/* =========================================================
   LAST-WICKET CHASE MODEL
   ---------------------------------------------------------
   No fixed run table. The chance is the probability that the
   last batsman survives long enough to score the runs still
   needed, so it moves with runs required, balls left, the
   team's scoring rate and batter-vs-bowler strength. The same
   model works for any target or match length.
   ========================================================= */
const oneWicketRemainingChaseChance = ({
  runsRemaining,
  ballsRemaining,
  scoringRate,
  batterStrength,
  bowlerStrength,
}) => {
  if (runsRemaining <= 0) return 90;
  if (ballsRemaining <= 0) return 10;

  // Runs per ball the lone batsman can score at a normal pace.
  const naturalRate = clamp((scoringRate / 6) * 0.85, 0.3, 2);

  // Chance of getting out on each ball; weaker batter / stronger bowler = higher.
  const baseHazard = clamp(
    0.14 * (bowlerStrength / Math.max(1, batterStrength)),
    0.06,
    0.3
  );

  // Batter plays safe when the ask is low and attacks (more risk) when it is high.
  const requiredPerBall = runsRemaining / ballsRemaining;
  const effort = clamp(requiredPerBall / naturalRate, 0.6, 2.2);
  const ballRate = naturalRate * effort;
  const hazard = clamp(baseHazard * effort * effort, 0.01, 0.75);

  // Balls needed at that pace, and the chance of surviving that long.
  const ballsNeeded = runsRemaining / ballRate;
  const survival = Math.pow(1 - hazard, Math.min(ballsNeeded, ballsRemaining));

  // Even at full attack, running out of balls makes the target unreachable.
  const feasibility =
    ballsNeeded <= ballsRemaining
      ? 1
      : Math.pow(ballsRemaining / ballsNeeded, 3);

  return clamp(survival * feasibility * 100, 10, 90);
};

const normalisePair = (a) => {
  const safeA = clamp(a, 0.1, 99.9);
  const safeB = clamp(100 - safeA, 0.1, 99.9);
  const total = safeA + safeB;

  return {
    A: round1((safeA / total) * 100),
    B: round1((safeB / total) * 100),
  };
};

const buildPreMatchPrediction = ({
  teams,
  battingStats,
  bowlingStats,
  h2h,
}) => {
  const strengthA = teamStrength(teams.A, battingStats, bowlingStats);
  const strengthB = teamStrength(teams.B, battingStats, bowlingStats);

  // Keep the pre-match baseline centered unless there is meaningful data.
  let scoreA = 50 + (strengthA - strengthB) * 1.15;

  if (h2h) {
    const h2hEdge =
      (h2h.aWins - h2h.bWins) /
      Math.max(1, h2h.total);
    scoreA += h2hEdge * 15;
  }

  return {
    ...normalisePair(scoreA),
    strengthA: round1(strengthA),
    strengthB: round1(strengthB),
  };
};

const inningsOvers = (match) =>
  Math.max(
    1,
    toNumber(
      match?.overs ??
        match?.matchOvers ??
        match?.totalOvers,
      1
    )
  );

const expectedScoringRate = ({
  battingStrength,
  bowlingStrength,
  totalOvers,
}) => {
  const strengthEdge = battingStrength - bowlingStrength;
  return clamp(
    7 + strengthEdge * 0.055 + Math.min(totalOvers, 20) * 0.02,
    3.5,
    13.5
  );
};

const currentRunRate = (runs, legalBalls) =>
  legalBalls > 0 ? (runs / legalBalls) * 6 : 0;

const requiredRunRate = (runsRequired, ballsRemaining) =>
  ballsRemaining > 0
    ? (runsRequired / ballsRemaining) * 6
    : runsRequired > 0
    ? Infinity
    : 0;

const remainingPlayerStrength = ({
  team,
  battingStats,
  historicalBattingStats,
  historicalBowlingStats,
  excludeIds = [],
}) => {
  const excluded = new Set(excludeIds.map(normaliseId).filter(Boolean));
  const players = playersForTeam(team).filter(
    (player) => !excluded.has(playerId(player))
  );

  if (!players.length) return 0;

  const values = players.map((player) => {
    const stat = statsLookup(battingStats, playerId(player));
    return {
      player,
      stat,
      strength: playerStrength(
        player,
        historicalBattingStats,
        historicalBowlingStats
      ),
    };
  });

  const remaining = values.filter(({ stat }) => {
    const status = normaliseId(stat?.status).toLowerCase();
    if (status === "yet") return true;

    return (
      status === "" &&
      toNumber(stat?.runs) === 0 &&
      toNumber(stat?.balls) === 0
    );
  });

  const source = remaining.length ? remaining : values;
  return source.reduce((sum, item) => sum + item.strength, 0) / source.length;
};

const usedBowlerIds = (deliveries) =>
  new Set(
    (Array.isArray(deliveries) ? deliveries : [])
      .map((delivery) => playerId(delivery?.bowlerId ?? delivery?.bowler))
      .filter(Boolean)
  );

const remainingBowlerStrength = ({
  team,
  deliveries,
  battingStats,
  bowlingStats,
}) => {
  const used = usedBowlerIds(deliveries);
  const bowlers = playersForTeam(team).filter(
    (player) => !used.has(playerId(player))
  );

  if (!bowlers.length) {
    return weightedTeamStrength(team, battingStats, bowlingStats, "bowling");
  }

  return (
    bowlers.reduce(
      (sum, player) => sum + playerStrength(player, battingStats, bowlingStats),
      0
    ) / bowlers.length
  );
};

/* =========================================================
   LIVE MODEL
   ========================================================= */

const calculateChaseProbability = ({
  battingTeam,
  bowlingTeam,
  innings,
  totalBalls,
  preMatchA,
  preMatchB,
  match,
  scoringState,
  historicalBattingStats,
  historicalBowlingStats,
}) => {
  const runs = toNumber(innings.runs);
  const wickets = toNumber(innings.wickets);
  const balls = toNumber(innings.balls);
  const deliveries = Array.isArray(innings.deliveries) ? innings.deliveries : [];
  const ballsRemaining = Math.max(0, totalBalls - balls);

  const firstTeamId = firstInningsTeamId(match, getTeams(match));
  const firstInningsScore = toNumber(
    match?.firstInningsScore ??
      match?.firstInningsData?.runs ??
      match?.[`score${firstTeamId}`]
  );
  const target = firstInningsScore + 1;
  const runsRequired = Math.max(0, target - runs);

  if (runs >= target) {
    return {
      chanceForBattingTeam: 100,
      metrics: {
        score: runs,
        wickets,
        overs: `${Math.floor(balls / 6)}.${balls % 6}`,
        ballsRemaining,
        runsRequired: 0,
        currentRR: currentRunRate(runs, balls),
        requiredRR: 0,
        currentBatsmenStrength: 0,
        remainingBattingStrength: 0,
        currentBowlerStrength: 0,
        remainingBowlingStrength: 0,
        partnershipRuns: 0,
        recentSixRuns: recentRuns(deliveries),
        recentSixWickets: recentWickets(deliveries),
        recentRR: deliveries.length
          ? (recentRuns(deliveries) / Math.max(1, recentSixDeliveries(deliveries).length)) * 6
          : 0,
      },
    };
  }

  const rr = currentRunRate(runs, balls);
  const reqRR = requiredRunRate(runsRequired, ballsRemaining);

  const currentStriker = normaliseId(scoringState?.strikerId);
  const currentNonStriker = normaliseId(scoringState?.nonStrikerId);
  const currentBowlerId = normaliseId(scoringState?.currentBowlerId);

  const currentBatterA = currentBatterStrength(
    battingTeam,
    innings.battingStats,
    currentStriker,
    historicalBattingStats,
    historicalBowlingStats
  );
  const currentBatterB = currentBatterStrength(
    battingTeam,
    innings.battingStats,
    currentNonStriker,
    historicalBattingStats,
    historicalBowlingStats
  );
  const currentBattingStrength =
    (currentBatterA + currentBatterB) / 2;

  const currentBowlerScore = currentBowlerStrength(
    bowlingTeam,
    innings.bowlingStats,
    currentBowlerId,
    historicalBattingStats,
    historicalBowlingStats
  );

  const remainingBatting = remainingPlayerStrength({
    team: battingTeam,
    battingStats: innings.battingStats,
    historicalBattingStats,
    historicalBowlingStats,
    excludeIds: [currentStriker, currentNonStriker],
  });

  const remainingBowling = remainingBowlerStrength({
    team: bowlingTeam,
    deliveries,
    battingStats: historicalBattingStats,
    bowlingStats: historicalBowlingStats,
  });

  const currentPairRuns =
    toNumber(statsLookup(innings.battingStats, currentStriker)?.runs) +
    toNumber(statsLookup(innings.battingStats, currentNonStriker)?.runs);

  const recent = recentSixDeliveries(deliveries);
  const recentSixRuns = recentRuns(deliveries);
  const recentSixWickets = recentWickets(deliveries);
  const recentRR = recent.length > 0
    ? (recentSixRuns / recent.length) * 6
    : rr;

  const battingStrength = weightedTeamStrength(
    battingTeam,
    historicalBattingStats,
    historicalBowlingStats,
    "batting"
  );
  const bowlingStrength = weightedTeamStrength(
    bowlingTeam,
    historicalBattingStats,
    historicalBowlingStats,
    "bowling"
  );

  const baselineRate = expectedScoringRate({
    battingStrength,
    bowlingStrength,
    totalOvers: totalBalls / 6,
  });

  // Blend match rate + recent six balls + team matchup baseline.
  const liveRate = clamp(
    balls === 0
      ? baselineRate
      : baselineRate * 0.35 + rr * 0.4 + recentRR * 0.25,
    2.5,
    15
  );

  const requiredPressure = Number.isFinite(reqRR)
    ? reqRR - liveRate
    : 10;

  const wicketsInHand = Math.max(0, playersForTeam(battingTeam).length - wickets);
  const maxWickets = Math.max(1, playersForTeam(battingTeam).length - 1);
  // Scorify lets the last batsman continue alone, so "one wicket left" means
  // exactly one batsman still in hand.
  const oneWicketLeft = wicketsInHand === 1;
  const wicketRatio = clamp(wickets / maxWickets, 0, 1);

  // Positive = batting side is doing better than the chase requires.
  let score = 50;

  // Required rate is the strongest live signal.
  score += clamp(-requiredPressure * 3.6, -30, 30);

  // Wickets materially affect a short-format chase.
  score += clamp((1 - wicketRatio) * 12 - wicketRatio * 18, -18, 12);

  // Current run rate and recent six-ball momentum.
  score += clamp((rr - reqRR) * 1.2, -10, 10);
  score += clamp((recentRR - reqRR) * 0.8, -8, 8);
  score -= recentSixWickets * 4;

  // Current batter vs current bowler matchup.
  score += clamp((currentBattingStrength - currentBowlerScore) * 0.16, -8, 8);

  // Remaining batting/bowling depth.
  score += clamp((remainingBatting - 50) * 0.18, -6, 6);
  score -= clamp((remainingBowling - 50) * 0.10, -4, 4);

  // Stable partnership gets a small positive adjustment.
  score += clamp((currentPairRuns - 20) * 0.10, -3, 3);

  // Pre-match team edge should still matter, but much less once live data exists.
  const preMatchEdge = preMatchA - preMatchB;
  score += clamp(
    (battingTeam.id === "A" ? preMatchEdge : -preMatchEdge) * 0.10,
    -6,
    6
  );

  // Near the end, the required rate should dominate rather than the team rating.
  if (ballsRemaining <= 12 && ballsRemaining > 0) {
    score += clamp(-requiredPressure * 1.6, -12, 12);
  }

  let chanceForBattingTeam = probabilityFromScoreDifference(score - 50, 22);

  // One wicket remaining is not the same as being all out. In this state,
  // target progress should be the dominant signal for the chase probability.
  if (oneWicketLeft) {
    chanceForBattingTeam = oneWicketRemainingChaseChance({
      runsRemaining: runsRequired,
      ballsRemaining,
      scoringRate: liveRate,
      batterStrength: currentBatterA,
      bowlerStrength: currentBowlerScore,
    });
  }

  // A completely exhausted chase is effectively decided.
  if (ballsRemaining === 0 && runs < target) {
    chanceForBattingTeam = 0;
  }

  chanceForBattingTeam = clamp(chanceForBattingTeam, 1, 99);

  const teamBattingId = battingTeam.id;
  const chanceA = teamBattingId === "A"
    ? chanceForBattingTeam
    : 100 - chanceForBattingTeam;

  return {
    chanceForBattingTeam,
    A: chanceA,
    metrics: {
      score: runs,
      wickets,
      overs: `${Math.floor(balls / 6)}.${balls % 6}`,
      ballsRemaining,
      runsRequired,
      target,
      currentRR: rr,
      requiredRR: reqRR,
      currentBatsmenStrength: currentBattingStrength,
      remainingBattingStrength: remainingBatting,
      currentBowlerStrength: currentBowlerScore,
      remainingBowlingStrength: remainingBowling,
      partnershipRuns: currentPairRuns,
      recentSixRuns,
      recentSixWickets,
      recentRR,
      wicketsInHand,
    },
  };
};

const calculateFirstInningsProbability = ({
  match,
  scoringState,
  innings,
  battingTeam,
  bowlingTeam,
  totalBalls,
  preMatchA,
  preMatchB,
  historicalBattingStats,
  historicalBowlingStats,
}) => {
  const runs = toNumber(innings.runs);
  const wickets = toNumber(innings.wickets);
  const balls = toNumber(innings.balls);
  const deliveries = Array.isArray(innings.deliveries) ? innings.deliveries : [];
  const ballsRemaining = Math.max(0, totalBalls - balls);
  const rr = currentRunRate(runs, balls);
  const recent = recentSixDeliveries(deliveries);
  const recentSixRuns = recentRuns(deliveries);
  const recentSixWickets = recentWickets(deliveries);
  const recentRR = recent.length > 0
    ? (recentSixRuns / recent.length) * 6
    : rr;

  const battingStrength = weightedTeamStrength(
    battingTeam,
    historicalBattingStats,
    historicalBowlingStats,
    "batting"
  );
  const bowlingStrength = weightedTeamStrength(
    bowlingTeam,
    historicalBattingStats,
    historicalBowlingStats,
    "bowling"
  );

  const baselineRate = expectedScoringRate({
    battingStrength,
    bowlingStrength,
    totalOvers: totalBalls / 6,
  });

  const scoringRate = clamp(
    balls === 0
      ? baselineRate
      : baselineRate * 0.35 + rr * 0.4 + recentRR * 0.25,
    2.5,
    15
  );

  const wicketPenalty = wickets * 0.55;
  const projectedFinalScore = Math.max(
    runs,
    runs + (ballsRemaining / 6) * scoringRate - wicketPenalty
  );

  // Estimate the chasing side's normal scoring capability for the same innings length.
  const chasingBattingStrength = weightedTeamStrength(
    bowlingTeam,
    historicalBattingStats,
    historicalBowlingStats,
    "batting"
  );
  const defendingBowlingStrength = weightedTeamStrength(
    battingTeam,
    historicalBattingStats,
    historicalBowlingStats,
    "bowling"
  );
  const opponentExpectedRate = expectedScoringRate({
    battingStrength: chasingBattingStrength,
    bowlingStrength: defendingBowlingStrength,
    totalOvers: totalBalls / 6,
  });
  const opponentExpectedTotal = opponentExpectedRate * (totalBalls / 6);

  const finalMargin = projectedFinalScore - opponentExpectedTotal;
  let scoreAorB = probabilityFromScoreDifference(
    finalMargin,
    12 + (totalBalls / 6) * 1.4
  );

  // A first-innings side has not actually "won" merely by projecting a total.
  // Keep the live result somewhat anchored to the pre-match expectation early on.
  const inningsProgress = clamp(balls / totalBalls, 0, 1);
  const preMatchForBatting = battingTeam.id === "A" ? preMatchA : preMatchB;
  const liveWeight = 0.35 + inningsProgress * 0.65;

  scoreAorB =
    preMatchForBatting * (1 - liveWeight) +
    scoreAorB * liveWeight;

  // Wickets in hand should add some value to a defending total projection.
  const totalBatters = Math.max(1, playersForTeam(battingTeam).length);
  const wicketRatio = clamp(wickets / Math.max(1, totalBatters - 1), 0, 1);
  scoreAorB += (0.5 - wicketRatio) * 4;
  scoreAorB -= recentSixWickets * 1.5;

  const maxWickets = Math.max(1, totalBatters - 1);
  const wicketsRemaining = Math.max(0, maxWickets - wickets);
  if (wicketsRemaining === 1) {
    // A side with one wicket left can still set a competitive total; avoid
    // collapsing its first-innings chance solely because of wicket count.
    scoreAorB = clamp(scoreAorB, 10, 90);
  }

  const normalized = normalisePair(
    battingTeam.id === "A" ? scoreAorB : 100 - scoreAorB
  );

  const currentStriker = normaliseId(scoringState?.strikerId);
  const currentNonStriker = normaliseId(scoringState?.nonStrikerId);
  const currentBowlerId = normaliseId(scoringState?.currentBowlerId);

  const currentBatting =
    (currentBatterStrength(
      battingTeam,
      innings.battingStats,
      currentStriker,
      historicalBattingStats,
      historicalBowlingStats
    ) +
      currentBatterStrength(
        battingTeam,
        innings.battingStats,
        currentNonStriker,
        historicalBattingStats,
        historicalBowlingStats
      )) /
    2;

  const currentBowler = currentBowlerStrength(
    bowlingTeam,
    innings.bowlingStats,
    currentBowlerId,
    historicalBattingStats,
    historicalBowlingStats
  );

  return {
    ...normalized,
    metrics: {
      score: runs,
      wickets,
      overs: `${Math.floor(balls / 6)}.${balls % 6}`,
      ballsRemaining,
      projectedFinalScore: round1(projectedFinalScore),
      currentRR: rr,
      requiredRR: 0,
      runsRequired: null,
      currentBatsmenStrength: currentBatting,
      remainingBattingStrength: remainingPlayerStrength({
        team: battingTeam,
        battingStats: innings.battingStats,
        historicalBattingStats,
        historicalBowlingStats,
        excludeIds: [currentStriker, currentNonStriker],
      }),
      currentBowlerStrength: currentBowler,
      remainingBowlingStrength: remainingBowlerStrength({
        team: bowlingTeam,
        deliveries,
        battingStats: historicalBattingStats,
        bowlingStats: historicalBowlingStats,
      }),
      partnershipRuns:
        toNumber(statsLookup(innings.battingStats, currentStriker)?.runs) +
        toNumber(statsLookup(innings.battingStats, currentNonStriker)?.runs),
      recentSixRuns,
      recentSixWickets,
      recentRR,
      wicketsInHand: Math.max(0, totalBatters - wickets),
    },
  };
};

/* =========================================================
   PUBLIC API
   ========================================================= */

export function calculateWinPrediction({
  match,
  scoringState = null,
  battingStats = [],
  bowlingStats = [],
} = {}) {
  if (!match) return null;

  const teams = getTeams(match);
  const state = getScoringState(match, scoringState);
  const names = {
    A: teams.A.name,
    B: teams.B.name,
  };

  const winner = resolvedWinner(match, state, teams);
  const isTest = String(match.matchType || "").toLowerCase() === "test";

  if (isFinished(match, winner)) {
    if (winner === "A") {
      return {
        A: 100,
        B: 0,
        teamA: names.A,
        teamB: names.B,
        phase: "finished",
        reason: "winner",
      };
    }

    if (winner === "B") {
      return {
        A: 0,
        B: 100,
        teamA: names.A,
        teamB: names.B,
        phase: "finished",
        reason: "winner",
      };
    }

    if (winner === "D") {
      return {
        A: 0,
        B: 0,
        draw: 100,
        teamA: names.A,
        teamB: names.B,
        phase: "finished",
        reason: "draw",
      };
    }
  }

  if (isTest) {
    const recorded = Array.isArray(match.testInnings)
      ? match.testInnings
      : Array.isArray(state?.testInnings) ? state.testInnings : [];
    const inningsByIndex = new Map();
    recorded.forEach((item) => {
      const index = Number(item?.inningsIndex);
      if (Number.isInteger(index) && index >= 0) {
        inningsByIndex.set(index, item);
      }
    });
    if (state?.inningsIndex != null) {
      const index = Number(state.inningsIndex);
      const teamId = Array.isArray(match.inningsOrder) && match.inningsOrder[index]
        ? match.inningsOrder[index]
        : index % 2 === 0 ? "A" : "B";
      inningsByIndex.set(index, {
        ...(inningsByIndex.get(index) || {}),
        inningsIndex: index,
        teamId,
        runs: toNumber(state.inningsRuns),
        wickets: toNumber(state.inningsWickets),
        balls: toNumber(state.legalBalls),
      });
    }
    const innings = [...inningsByIndex.values()].sort(
      (a, b) => Number(a.inningsIndex) - Number(b.inningsIndex)
    );
    const totals = innings.reduce((acc, item) => {
      const id = item.teamId === "B" ? "B" : "A";
      acc[id] += toNumber(item.runs);
      return acc;
    }, { A: 0, B: 0 });
    const currentIndex = Number(state?.inningsIndex ?? innings.length - 1);
    const currentTeam = Array.isArray(match.inningsOrder) && match.inningsOrder[currentIndex]
      ? match.inningsOrder[currentIndex]
      : currentIndex % 2 === 0 ? "A" : "B";
    const currentRuns = toNumber(state?.inningsRuns);
    const currentWickets = toNumber(state?.inningsWickets);
    const currentTeamPreviousRuns = innings
      .filter((item) => item.teamId === currentTeam && Number(item.inningsIndex ?? -1) < currentIndex)
      .reduce((total, item) => total + toNumber(item.runs), 0);
    const chaseTarget = toNumber(innings.find((item) => Number(item.inningsIndex) === 0)?.runs)
      - currentTeamPreviousRuns + 1;
    const aggregateMargin = totals.A - totals.B;
    const chaseProgress = currentIndex === 3 && chaseTarget > 0
      ? clamp(currentRuns / chaseTarget, 0, 1)
      : 0;
    const wicketsInHand = Math.max(0, 10 - currentWickets);
    const inningsProgress = clamp(
      toNumber(state?.legalBalls) / Math.max(1, toNumber(match.oversPerDay || match.testOvers || 90) * 6),
      0,
      1
    );
    const draw = currentIndex === 3
      ? clamp(46 - chaseProgress * 30 - (10 - wicketsInHand) * 1.8 - inningsProgress * 8, 8, 46)
      : clamp(52 - Math.abs(aggregateMargin) * 0.08 - Math.max(0, currentIndex) * 3 - inningsProgress * 6, 28, 52);
    const available = 100 - draw;
    let lead;
    if (currentIndex === 3 && chaseTarget > 0 && currentRuns > 0) {
      const chaseStrength = (chaseProgress - 0.5) * 58 + (wicketsInHand - 5) * 2.5;
      lead = currentTeam === "A"
        ? 50 + chaseStrength
        : 50 - chaseStrength;
    } else {
      lead = 50 + aggregateMargin * 0.22;
    }
    lead = 50 + clamp(lead - 50, -available * 0.42, available * 0.42);
    const chanceA = Math.max(5, (lead / 100) * available);
    const chanceB = Math.max(5, available - (lead / 100) * available);
    const chanceTotal = chanceA + chanceB;
    const finalA = (chanceA / chanceTotal) * available;
    return {
      A: round1(finalA),
      B: round1(available - finalA),
      draw: round1(draw),
      teamA: names.A, teamB: names.B, phase: state ? "live" : "pre-match",
      h2hIncluded: false, testMatch: true,
    };
  }

  const h2h = extractH2H(match, teams);
  const preMatch = buildPreMatchPrediction({
    teams,
    battingStats,
    bowlingStats,
    h2h,
  });

  if (!state) {
    return {
      A: preMatch.A,
      B: preMatch.B,
      teamA: names.A,
      teamB: names.B,
      phase: "pre-match",
      h2hIncluded: Boolean(h2h),
    };
  }

  const context = buildLiveContext(match, state);
  const totalBalls = Math.max(6, Math.round(inningsOvers(match) * 6));
  const innings = context.innings;
  const deliveries = Array.isArray(innings.deliveries) ? innings.deliveries : [];
  const totalsFromDeliveries = calculateDeliveryTotals(deliveries);

  // Prefer the scoring state counters, but use deliveries as a safe fallback.
  const balls =
    hasOwn(state, "legalBalls")
      ? toNumber(state.legalBalls)
      : toNumber(innings.balls, totalsFromDeliveries.legalBalls);
  const runs =
    hasOwn(state, "inningsRuns")
      ? toNumber(state.inningsRuns)
      : toNumber(innings.runs, totalsFromDeliveries.runs);
  const wickets =
    hasOwn(state, "inningsWickets")
      ? toNumber(state.inningsWickets)
      : toNumber(innings.wickets, totalsFromDeliveries.wickets);

  const liveInnings = {
    ...innings,
    runs,
    wickets,
    balls,
    deliveries,
  };

  const inningsHasStarted =
    context.inningsIndex === 1
      ? Boolean(
          match?.firstInningsData ||
            hasOwn(match, "firstInningsScore") ||
            state?.inningsIndex === 1
        )
      : balls > 0 || runs > 0 || wickets > 0 || deliveries.length > 0;

  // Opening screen before any first ball = pre-match prediction.
  if (!inningsHasStarted) {
    return {
      A: preMatch.A,
      B: preMatch.B,
      teamA: names.A,
      teamB: names.B,
      phase: "pre-match",
      h2hIncluded: Boolean(h2h),
    };
  }

  const secondInnings = context.inningsIndex === 1;
  const firstScore = toNumber(
    match?.firstInningsScore ??
      match?.firstInningsData?.runs ??
      match?.[`score${context.firstTeamId}`]
  );

  // Exact terminal outcomes even when the caller has not yet set status=finished.
  if (secondInnings) {
    const target = firstScore + 1;
    // Scoring.jsx ends the innings only when every batsman is dismissed.
    const wicketsLimit = Math.max(1, playersForTeam(context.battingTeam).length);
    const ballsRemaining = Math.max(0, totalBalls - balls);

    if (runs > 0 && target > 0 && runs >= target) {
      return {
        A: context.battingTeamId === "A" ? 100 : 0,
        B: context.battingTeamId === "B" ? 100 : 0,
        teamA: names.A,
        teamB: names.B,
        phase: "finished",
        reason: "target-reached",
        live: true,
      };
    }

    if (ballsRemaining === 0 || wickets >= wicketsLimit) {
      const defenderId = context.firstTeamId;
      return {
        A: defenderId === "A" ? 100 : 0,
        B: defenderId === "B" ? 100 : 0,
        teamA: names.A,
        teamB: names.B,
        phase: "finished",
        reason: "target-not-reached",
        live: true,
      };
    }
  }

  let normalized;
  let metrics;

  if (secondInnings) {
    const result = calculateChaseProbability({
      battingTeam: context.battingTeam,
      bowlingTeam: context.bowlingTeam,
      innings: liveInnings,
      totalBalls,
      preMatchA: preMatch.A,
      preMatchB: preMatch.B,
      match,
      scoringState: state,
      historicalBattingStats: battingStats,
      historicalBowlingStats: bowlingStats,
    });

    normalized = normalisePair(
      context.battingTeamId === "A"
        ? result.chanceForBattingTeam
        : 100 - result.chanceForBattingTeam
    );
    metrics = result.metrics;
  } else {
    const result = calculateFirstInningsProbability({
      match,
      scoringState: state,
      innings: liveInnings,
      battingTeam: context.battingTeam,
      bowlingTeam: context.bowlingTeam,
      totalBalls,
      preMatchA: preMatch.A,
      preMatchB: preMatch.B,
      historicalBattingStats: battingStats,
      historicalBowlingStats: bowlingStats,
    });

    normalized = {
      A: result.A,
      B: result.B,
    };
    metrics = result.metrics;
  }

  return {
    ...normalized,
    teamA: names.A,
    teamB: names.B,
    phase: "live",
    live: true,
    h2hIncluded: Boolean(h2h),
    metrics,
  };
}

/*
  Reconstruct prediction after a specific recorded delivery.
  This is browser-only and is used by Match scorecard history.
*/
export function getPredictionForDelivery({
  match,
  scoringState,
  deliveryIndex,
  battingStats = [],
  bowlingStats = [],
} = {}) {
  const deliveries = Array.isArray(scoringState?.deliveries)
    ? scoringState.deliveries
    : [];

  const index = Number(deliveryIndex);
  if (!Number.isInteger(index) || index < 0 || index >= deliveries.length) {
    return null;
  }

  const upto = deliveries.slice(0, index + 1);
  const totals = calculateDeliveryTotals(upto);

  const inningsIndex = Number(scoringState?.inningsIndex) === 1 ? 1 : 0;
  const lastDelivery = upto[upto.length - 1] || {};

  const syntheticState = {
    ...(scoringState || {}),
    inningsIndex,
    inningsRuns: totals.runs,
    inningsWickets: totals.wickets,
    legalBalls: totals.legalBalls,
    deliveries: upto,
    strikerId:
      lastDelivery?.strikerId ??
      scoringState?.strikerId ??
      "",
    nonStrikerId:
      lastDelivery?.nonStrikerId ??
      scoringState?.nonStrikerId ??
      "",
    currentBowlerId:
      lastDelivery?.bowlerId ??
      scoringState?.currentBowlerId ??
      "",
    battingStats: scoringState?.battingStats || {},
    bowlingStats: scoringState?.bowlingStats || {},
  };

  const teams = getTeams(match);
  const firstTeamId = firstInningsTeamId(match, teams);
  const currentTeamId = inningsIndex === 1
    ? firstTeamId === "A" ? "B" : "A"
    : firstTeamId;

  return calculateWinPrediction({
    match: {
      ...match,
      [`score${currentTeamId}`]: totals.runs,
      [`wickets${currentTeamId}`]: totals.wickets,
      scoringState: syntheticState,
    },
    scoringState: syntheticState,
    battingStats,
    bowlingStats,
  });
}

export default calculateWinPrediction;