const idOf = (value) =>
  String(
    typeof value === "object"
      ? value?.id ?? value?.uid ?? value?.playerId ?? value?._id
      : value ?? ""
  ).trim().toLowerCase();

const nameOf = (value) =>
  String(typeof value === "object" ? value?.name ?? "" : value ?? "")
    .trim()
    .toLowerCase();

const teamOfMatch = (match, side) =>
  side === "A"
    ? match?.teamA || { id: "A", name: match?.teamAName || "Team A", players: match?.teamAPlayers || [] }
    : match?.teamB || { id: "B", name: match?.teamBName || "Team B", players: match?.teamBPlayers || [] };

const rosterIds = (team) =>
  new Set((team?.players || []).map(idOf).filter(Boolean));

const winnerSide = (match) => {
  const values = [
    match?.winnerId,
    match?.winnerTeamId,
    match?.winner,
    match?.winnerName,
    match?.result?.winnerId,
    match?.result?.winnerTeamId,
    match?.result?.winner,
  ].map(nameOf).filter(Boolean);
  if (!values.length || values.includes("draw") || values.includes("tie")) return null;

  return ["A", "B"].find((side) => {
    const team = teamOfMatch(match, side);
    return values.some((value) =>
      [side, idOf(team), nameOf(team?.name)].includes(value)
    );
  }) || null;
};

const isDrawnMatch = (match) => {
  const values = [
    match?.drawState,
    match?.winner,
    match?.winnerName,
    match?.result?.winner,
    match?.result?.text,
    match?.resultText,
  ].map((value) => String(value || "").trim().toLowerCase());

  return values.some((value) => value === "draw" || value === "tie" || value.includes("match drawn") || value.includes("drawn match"));
};

const inningsFor = (match) => {
  if (String(match?.matchType || "").toLowerCase() === "test") {
    const saved = Array.isArray(match?.testInnings)
      ? match.testInnings
      : Array.isArray(match?.innings)
        ? match.innings
        : [];
    return saved.length ? saved : [match?.firstInningsData, match?.secondInningsData].filter(Boolean);
  }
  return [match?.firstInningsData, match?.secondInningsData].filter(Boolean);
};

export const getMaidenCount = (innings, bowlerId, savedMaidens = 0) => {
  const normalizedBowlerId = idOf(bowlerId);
  const completedOvers = Array.isArray(innings?.completedOvers)
    ? innings.completedOvers
    : [];
  const recorded = completedOvers.filter(
    (over) =>
      over?.maiden === true &&
      idOf(over?.bowlerId) === normalizedBowlerId
  ).length;

  const deliveries = Array.isArray(innings?.deliveries)
    ? innings.deliveries
    : [];
  const legal = (delivery) => {
    if (delivery?.validBall !== undefined) return delivery.validBall === true;
    if (delivery?.legalBall !== undefined) return delivery.legalBall === true;
    return !["NB", "NO_BALL", "NO-BALL", "WD", "WIDE", "DEAD"].includes(
      String(delivery?.type ?? delivery?.deliveryType ?? "").toUpperCase()
    );
  };
  const overs = new Map();
  deliveries.forEach((delivery) => {
    if (!legal(delivery) || idOf(delivery?.bowlerId ?? delivery?.bowlerPlayerId) !== normalizedBowlerId) return;
    const overNumber = Number(delivery?.over ?? delivery?.overNumber);
    if (!Number.isFinite(overNumber)) return;
    const current = overs.get(overNumber) || { balls: 0, runs: 0 };
    current.balls += 1;
    current.runs += Number(
      delivery?.bowlerRuns ?? delivery?.runsConceded ?? delivery?.runs ?? 0
    ) || 0;
    overs.set(overNumber, current);
  });
  const derived = [...overs.values()].filter((over) => over.balls === 6 && over.runs === 0).length;
  return Math.max(Number(savedMaidens) || 0, recorded, derived);
};

const performanceForMatch = (match) => {
  const map = new Map();
  const teams = { A: teamOfMatch(match, "A"), B: teamOfMatch(match, "B") };

  const add = (id, stats, side, bowling = false) => {
    const key = idOf(id || stats?.id || stats?.playerId || stats?.uid || stats?.name);
    if (!key) return;
    const current = map.get(key) || {
      id: key,
      name: String(stats?.name ?? stats?.playerName ?? id ?? "").trim().toLowerCase(),
      side,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      wickets: 0,
      legalBalls: 0,
      conceded: 0,
      maidens: 0,
      teamIds: new Set(),
    };
    current.teamIds.add(String(teams[side]?.id || side));
    if (bowling) {
      current.wickets += Number(stats?.wickets || 0);
      current.legalBalls += Number(stats?.legalBalls ?? stats?.balls ?? 0);
      current.conceded += Number(stats?.runs ?? stats?.runsConceded ?? 0);
      current.maidens += Number(stats?.maidens ?? 0);
    } else {
      current.runs += Number(stats?.runs || 0);
      current.balls += Number(stats?.balls || 0);
      current.fours += Number(stats?.fours || 0);
      current.sixes += Number(stats?.sixes || 0);
    }
    map.set(key, current);
  };

  inningsFor(match).forEach((innings) => {
    const battingSide = String(innings?.teamId || "A").toUpperCase() === "B" ? "B" : "A";
    const bowlingSide = battingSide === "A" ? "B" : "A";
    Object.entries(innings?.battingStats || {}).forEach(([id, stats]) => add(id, stats, battingSide));
    Object.entries(innings?.bowlingStats || {}).forEach(([id, stats]) => add(id, stats, bowlingSide, true));
    Object.entries(innings?.bowlingStats || {}).forEach(([id, stats]) => {
      const player = map.get(idOf(id));
      if (player) player.maidens = Math.max(
        player.maidens,
        getMaidenCount(innings, id, stats?.maidens)
      );
    });
  });

  return [...map.values()].map((player) => ({
    ...player,
    impact: (() => {
      const strikeRate = player.balls > 0
        ? (player.runs / player.balls) * 100
        : 0;
      const economy = player.legalBalls > 0
        ? (player.conceded / player.legalBalls) * 6
        : null;
      const battingImpact =
        player.runs * 2 +
        player.fours * 0.5 +
        player.sixes * 1.5 +
        (player.balls > 0
          ? Math.max(-4, Math.min(4, (strikeRate - 100) * 0.04))
          : 0);
      const bowlingImpact =
        player.wickets * 7 +
        (economy == null
          ? 0
          : Math.max(-8, Math.min(8, (6.5 - economy) * 2)));
      return (battingImpact + bowlingImpact) /
        Math.max(1, new Set(player.teamIds || [player.side]).size);
    })(),
  }));
};

export const getCareerMatchStats = ({ playerIds, matches = [], tournaments = [] }) => {
  const ids = new Set([...playerIds].map(idOf));
  const result = {
    testPlayed: 0,
    testWon: 0,
    testLost: 0,
    testDraw: 0,
    limitedPlayed: 0,
    limitedWon: 0,
    limitedLost: 0,
    limitedDraw: 0,
    tournamentPlayed: 0,
    tournamentWon: 0,
    tournamentLost: 0,
    manOfMatch: 0,
  };
  const tournamentParticipation = new Map();

  matches.forEach((match) => {
    const innings = inningsFor(match);
    const performances = performanceForMatch(match);
    const participantSides = new Set();
    ["A", "B"].forEach((side) => {
      const roster = rosterIds(teamOfMatch(match, side));
      if (roster.size && [...ids].some((id) => roster.has(id))) participantSides.add(side);
    });
    performances.forEach((player) => {
      if (ids.has(player.id)) participantSides.add(player.side);
    });
    if (!participantSides.size) return;

    const isTest = String(match?.matchType || "").toLowerCase() === "test";
    if (isTest) result.testPlayed += 1;
    else result.limitedPlayed += 1;

    const winner = winnerSide(match);
    const drawn = isDrawnMatch(match);
    if (participantSides.size === 1 && (winner || drawn)) {
      if (participantSides.has(winner)) {
        if (isTest) result.testWon += 1;
        else result.limitedWon += 1;
      } else if (drawn) {
        if (isTest) result.testDraw += 1;
        else result.limitedDraw += 1;
      } else {
        if (isTest) result.testLost += 1;
        else result.limitedLost += 1;
      }
    }

    const tournamentId = String(match?.tournamentId || "").trim();
    if (tournamentId) {
      const entry = tournamentParticipation.get(tournamentId) || { sides: new Set(), matches: [] };
      participantSides.forEach((side) => entry.sides.add(side));
      entry.matches.push({ match, participantSides });
      tournamentParticipation.set(tournamentId, entry);
    }

    const explicitAward = [
      match?.playerOfMatch,
      match?.playerOfTheMatch,
      match?.manOfMatch,
      match?.manOfTheMatch,
      match?.playerOfMatchId,
      match?.playerOfTheMatchId,
      match?.manOfMatchId,
      match?.manOfTheMatchId,
      match?.playerOfMatchName,
      match?.playerOfTheMatchName,
      match?.manOfMatchName,
      match?.manOfTheMatchName,
      match?.result?.playerOfMatch,
      match?.result?.playerOfTheMatch,
      match?.result?.manOfMatch,
    ].flatMap((value) => (Array.isArray(value) ? value : [value])).filter(Boolean);
    if (explicitAward.some((award) => {
      const awardId = idOf(award);
      const awardName = nameOf(award);
      return ids.has(awardId) ||
        performances.some((player) =>
          (awardId && player.id === awardId) ||
          (awardName && player.name === awardName)
        );
    })) {
      result.manOfMatch += 1;
    } else if (winner && participantSides.has(winner) && performances.length) {
      const winnerPlayers = performances.filter((player) => player.side === winner);
      const best = [...winnerPlayers].sort((a, b) => b.impact - a.impact)[0];
      if (best && ids.has(best.id)) result.manOfMatch += 1;
    }
  });

  tournamentParticipation.forEach((entry, tournamentId) => {
    result.tournamentPlayed += 1;
    const tournament = tournaments.find((item) => String(item?.id || item?.tournamentId) === tournamentId);
    const final = [...entry.matches]
      .filter(({ match }) => String(match?.tournamentMatchType || "").toLowerCase() === "final")
      .sort((a, b) => new Date(b.match?.createdAt || 0) - new Date(a.match?.createdAt || 0))[0];
    const winner = winnerSide(final?.match) ||
      (tournament && final?.match && ["A", "B"].find((side) => {
        const team = teamOfMatch(final.match, side);
        return [idOf(tournament?.winnerId), nameOf(tournament?.winnerName)]
          .includes(idOf(team)) ||
          [idOf(tournament?.winnerId), nameOf(tournament?.winnerName)]
            .includes(nameOf(team?.name));
      }));
    if (winner && [...entry.sides].some((side) => side === winner)) result.tournamentWon += 1;
    else if (winner) result.tournamentLost += 1;
  });

  return result;
};
