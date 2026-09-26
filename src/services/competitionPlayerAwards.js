const idOf = (value) =>
  String(
    typeof value === "object"
      ? value?.id ??
          value?.uid ??
          value?.playerId ??
          value?.playerUid ??
          value?._id ??
          ""
      : value ?? ""
  )
    .trim()
    .toLowerCase();

const finiteNumber = (...values) => {
  const value = values.find((item) => item !== null && item !== undefined);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const completed = (match) =>
  ["finished", "completed"].includes(String(match?.status || "").toLowerCase());

export const calculatePlayerImpactPoints = ({
  runs = 0,
  balls = 0,
  fours = 0,
  sixes = 0,
  wickets = 0,
  legalBalls = 0,
  runsConceded = 0,
  teamCount = 1,
} = {}) => {
  const strikeRate = balls > 0 ? (runs / balls) * 100 : 0;
  const economy =
    legalBalls > 0 ? (runsConceded / legalBalls) * 6 : null;
  const battingImpact =
    runs * 2 +
    fours * 0.5 +
    sixes * 1.5 +
    (balls > 0
      ? Math.max(-4, Math.min(4, (strikeRate - 100) * 0.04))
      : 0);
  const bowlingImpact =
    wickets * 7 +
    (economy === null
      ? 0
      : Math.max(-8, Math.min(8, (6.5 - economy) * 2)));

  return (battingImpact + bowlingImpact) / Math.max(1, teamCount);
};

const valuesForStats = (stats, matchId, inningsNumber) => {
  if (!Array.isArray(stats)) return [];
  return stats.filter((stat) => {
    const statMatchId = idOf(
      stat?.matchId ?? stat?.matchID ?? stat?.match_id
    );
    if (statMatchId && statMatchId !== matchId) return false;
    const number = Number(stat?.inningsNumber ?? stat?.innings);
    if (Number.isInteger(number) && number > 0) {
      return number === inningsNumber;
    }
    const index = Number(stat?.inningsIndex);
    if (Number.isInteger(index) && index >= 0) {
      return index + 1 === inningsNumber;
    }
    const suffix = String(stat?.inningsId || "").match(/_innings_(\d+)$/i);
    return !suffix || Number(suffix[1]) === inningsNumber;
  });
};

const entriesForStats = (stats) => {
  if (Array.isArray(stats)) {
    return stats.filter(Boolean).map((stat, index) => [
      idOf(stat?.playerId ?? stat?.playerUid ?? stat?.uid ?? stat?.id) ||
        `player-${index}`,
      stat,
    ]);
  }
  return stats && typeof stats === "object"
    ? Object.entries(stats).filter(([, stat]) => Boolean(stat))
    : [];
};

const matchInnings = (match) => {
  const innings = Array.isArray(match?.testInnings) && match.testInnings.length
    ? match.testInnings
    : Array.isArray(match?.innings) && match.innings.length
      ? match.innings
      : Array.isArray(match?.inningsData) && match.inningsData.length
        ? match.inningsData
        : [match?.firstInningsData, match?.secondInningsData].filter(Boolean);
  const unique = new Map();

  innings.forEach((inning, index) => {
    const explicitNumber = Number(inning?.inningsNumber);
    const explicitIndex = Number(inning?.inningsIndex);
    const number =
      Number.isInteger(explicitNumber) && explicitNumber > 0
        ? explicitNumber
        : Number.isInteger(explicitIndex) && explicitIndex >= 0
          ? explicitIndex + 1
          : index + 1;
    unique.set(number, { ...(unique.get(number) || {}), ...inning, inningsNumber: number });
  });

  return [...unique.values()].sort(
    (left, right) => left.inningsNumber - right.inningsNumber
  );
};

const sideForInnings = (match, inning) => {
  const team = String(
    inning?.battingTeamId ?? inning?.teamId ?? ""
  ).trim().toLowerCase();
  if (["b", "teamb"].includes(team)) return "B";
  if (["a", "teama"].includes(team)) return "A";
  const teamAIds = [
    match?.teamAId,
    match?.teamA?.teamId,
    match?.teamA?.id,
    match?.teamAName,
    match?.teamA?.name,
  ].map(idOf);
  const teamBIds = [
    match?.teamBId,
    match?.teamB?.teamId,
    match?.teamB?.id,
    match?.teamBName,
    match?.teamB?.name,
  ].map(idOf);
  if (teamAIds.includes(team)) return "A";
  if (teamBIds.includes(team)) return "B";
  return "A";
};

export const calculateCompetitionPlayerAward = (
  matches = [],
  { inningsRecords = [], battingStats = [], bowlingStats = [] } = {}
) => {
  const inningsByMatch = new Map();
  inningsRecords.forEach((record) => {
    const matchId = idOf(record?.matchId ?? record?.matchID ?? record?.match_id);
    if (!matchId) return;
    inningsByMatch.set(matchId, [
      ...(inningsByMatch.get(matchId) || []),
      record,
    ]);
  });

  const playerTotals = new Map();
  matches.filter(completed).forEach((match) => {
    const matchId = idOf(match?.id ?? match?.matchId);
    const innings = matchInnings(match);
    const knownNumbers = new Set(innings.map((inning) => inning.inningsNumber));
    (inningsByMatch.get(matchId) || []).forEach((record, index) => {
      const explicitNumber = Number(record?.inningsNumber ?? record?.innings);
      const explicitIndex = Number(record?.inningsIndex);
      const suffix = String(record?.inningsId || "").match(/_innings_(\d+)$/i);
      const number =
        Number.isInteger(explicitNumber) && explicitNumber > 0
          ? explicitNumber
          : Number.isInteger(explicitIndex) && explicitIndex >= 0
            ? explicitIndex + 1
            : suffix
              ? Number(suffix[1])
              : index + 1;
      if (knownNumbers.has(number)) return;
      knownNumbers.add(number);
      innings.push({
        ...record,
        inningsNumber: number,
        teamId: record?.battingTeamId ?? record?.teamId,
      });
    });

    const performances = new Map();
    innings.forEach((inning, index) => {
      const number = Number(inning?.inningsNumber ?? index + 1);
      let battingEntries = entriesForStats(inning?.battingStats);
      let bowlingEntries = entriesForStats(inning?.bowlingStats);
      if (!battingEntries.length) {
        battingEntries = valuesForStats(battingStats, matchId, number).map(
          (stat, statIndex) => [
            idOf(stat?.playerId ?? stat?.playerUid ?? stat?.uid ?? stat?.id) ||
              `batter-${statIndex}`,
            stat,
          ]
        );
      }
      if (!bowlingEntries.length) {
        bowlingEntries = valuesForStats(bowlingStats, matchId, number).map(
          (stat, statIndex) => [
            idOf(stat?.playerId ?? stat?.playerUid ?? stat?.uid ?? stat?.id) ||
              `bowler-${statIndex}`,
            stat,
          ]
        );
      }

      const battingSide = sideForInnings(match, inning);
      const bowlingSide = battingSide === "A" ? "B" : "A";
      const add = (key, stats, side, bowling) => {
        const playerId = idOf(
          stats?.playerId ?? stats?.playerUid ?? stats?.uid ?? stats?.id ?? key
        );
        if (!playerId) return;
        const player = performances.get(playerId) || {
          playerId,
          playerName: String(
            stats?.playerName ?? stats?.name ?? "Unknown Player"
          ).trim(),
          runs: 0,
          balls: 0,
          fours: 0,
          sixes: 0,
          wickets: 0,
          legalBalls: 0,
          runsConceded: 0,
          sides: new Set(),
        };
        player.sides.add(side);
        if (player.playerName === "Unknown Player" && (stats?.playerName || stats?.name)) {
          player.playerName = String(stats.playerName || stats.name).trim();
        }
        if (bowling) {
          player.wickets += finiteNumber(stats?.wickets, stats?.wicketCount);
          player.legalBalls += finiteNumber(
            stats?.legalBalls,
            stats?.balls,
            stats?.ballsBowled
          );
          player.runsConceded += finiteNumber(
            stats?.runsConceded,
            stats?.runs
          );
        } else {
          player.runs += finiteNumber(stats?.runs, stats?.battingRuns);
          player.balls += finiteNumber(stats?.balls, stats?.ballsFaced);
          player.fours += finiteNumber(stats?.fours);
          player.sixes += finiteNumber(stats?.sixes);
        }
        performances.set(playerId, player);
      };

      battingEntries.forEach(([key, stats]) => add(key, stats, battingSide, false));
      bowlingEntries.forEach(([key, stats]) => add(key, stats, bowlingSide, true));
    });

    performances.forEach((performance, playerId) => {
      if (
        performance.runs <= 0 &&
        performance.wickets <= 0 &&
        performance.balls <= 0 &&
        performance.legalBalls <= 0
      ) {
        return;
      }
      const points = calculatePlayerImpactPoints({
        ...performance,
        teamCount: performance.sides.size,
      });
      const total = playerTotals.get(playerId) || {
        playerId,
        playerName: performance.playerName || "Unknown Player",
        totalPoints: 0,
        matchesPlayed: 0,
      };
      total.totalPoints += points;
      total.matchesPlayed += 1;
      if (total.playerName === "Unknown Player" && performance.playerName) {
        total.playerName = performance.playerName;
      }
      playerTotals.set(playerId, total);
    });
  });

  return [...playerTotals.values()]
    .map((player) => ({
      ...player,
      averagePoints: player.totalPoints / player.matchesPlayed,
    }))
    .sort(
      (left, right) =>
        right.averagePoints - left.averagePoints ||
        right.totalPoints - left.totalPoints ||
        left.playerName.localeCompare(right.playerName)
    )[0] || null;
};
