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

const performanceForMatch = (match) => {
  const map = new Map();
  const teams = { A: teamOfMatch(match, "A"), B: teamOfMatch(match, "B") };

  const add = (id, stats, side, bowling = false) => {
    const key = idOf(id || stats?.id || stats?.playerId || stats?.uid || stats?.name);
    if (!key) return;
    const current = map.get(key) || {
      id: key,
      side,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      wickets: 0,
      legalBalls: 0,
      conceded: 0,
    };
    if (bowling) {
      current.wickets += Number(stats?.wickets || 0);
      current.legalBalls += Number(stats?.legalBalls ?? stats?.balls ?? 0);
      current.conceded += Number(stats?.runs ?? stats?.runsConceded ?? 0);
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
  });

  return [...map.values()].map((player) => ({
    ...player,
    impact:
      player.runs +
      player.fours * 0.5 +
      player.sixes * 1.5 +
      player.wickets * 30 +
      (player.legalBalls
        ? Math.max(-8, Math.min(8, (6.5 - (player.conceded / player.legalBalls) * 6) * 2))
        : 0),
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

    if (winner && participantSides.has(winner) && performances.length) {
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
