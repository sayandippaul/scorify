import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
} from "firebase/firestore";
import { auth, db } from "../firebase/firebase";

export const TOURNAMENT_TEAM_COUNTS = [3, 4, 5, 6, 8, 10, 12];

const TOURNAMENTS = "tournaments";
const MATCHES = "matches";

const idOf = (value) => String(value ?? "").trim();
const nameOf = (value) => String(value ?? "").trim();
const now = () => new Date().toISOString();

export const getCurrentTournamentUser = () => auth.currentUser;

export const validateTournamentSetup = ({
  name,
  teamCount,
  teams = [],
}) => {
  const errors = [];
  const cleanName = nameOf(name);
  const count = Number(teamCount);

  if (!cleanName) errors.push("Tournament name is required.");
  if (!TOURNAMENT_TEAM_COUNTS.includes(count)) {
    errors.push("Choose 3, 4, 5, 6, 8, 10 or 12 teams.");
  }
  if (teams.length !== count) errors.push(`Exactly ${count} teams are required.`);

  const names = teams.map((team) => nameOf(team.name).toLowerCase());
  if (names.some((teamName) => !teamName)) {
    errors.push("Every team must have a name.");
  }
  if (new Set(names).size !== names.length) {
    errors.push("Team names must be unique.");
  }

  teams.forEach((team) => {
    const players = Array.isArray(team.playerIds) ? team.playerIds : [];
    if (!players.length) errors.push(`${nameOf(team.name) || "Each team"} needs at least one player.`);
    if (players.length > 11) errors.push(`${nameOf(team.name) || "A team"} cannot have more than 11 players.`);
  });

  const assigned = teams.flatMap((team) => team.playerIds || []).map(idOf);
  if (new Set(assigned).size !== assigned.length) {
    errors.push("A player can belong to only one tournament team.");
  }

  return { valid: errors.length === 0, errors, name: cleanName, teamCount: count };
};

const shuffle = (items) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};

export const buildGroups = (teams) => {
  if (teams.length <= 5) {
    return [{ id: "A", name: "Group A", teamIds: teams.map((team) => team.id) }];
  }

  const shuffled = shuffle(teams);
  const half = teams.length / 2;
  return [
    { id: "A", name: "Group A", teamIds: shuffled.slice(0, half).map((team) => team.id) },
    { id: "B", name: "Group B", teamIds: shuffled.slice(half).map((team) => team.id) },
  ];
};

export const generateLeagueFixtures = (tournament) => {
  const teamsById = new Map((tournament.teams || []).map((team) => [team.id, team]));
  const fixtures = [];

  (tournament.groups || []).forEach((group) => {
    const groupTeams = group.teamIds.map((id) => teamsById.get(id)).filter(Boolean);
    for (let left = 0; left < groupTeams.length; left += 1) {
      for (let right = left + 1; right < groupTeams.length; right += 1) {
        const teamA = groupTeams[left];
        const teamB = groupTeams[right];
        const fixtureId = `${tournament.id}-league-${group.id}-${teamA.id}-${teamB.id}`;
        fixtures.push({
          id: fixtureId,
          tournamentId: tournament.id,
          tournamentMatchType: "league",
          groupId: group.id,
          teamAId: teamA.id,
          teamBId: teamB.id,
          teamAName: teamA.name,
          teamBName: teamB.name,
          status: "scheduled",
          matchId: null,
        });
      }
    }
  });

  return fixtures;
};

const generateKnockoutFixtures = (tournament) => {
  const fixtures = [];
  const addFixture = (id, type) => fixtures.push({
    id: `${tournament.id}-${id}`,
    tournamentId: tournament.id,
    tournamentMatchType: type,
    groupId: null,
    teamAId: null,
    teamBId: null,
    teamAName: "TBD",
    teamBName: "TBD",
    status: "scheduled",
    matchId: null,
  });

  if ((tournament.groups || []).length === 1) {
    addFixture("final", "final");
    if ((tournament.teamCount || tournament.teams?.length || 0) >= 5) {
      addFixture("semi-1", "semi_final");
    }
  } else if ((tournament.groups || []).length === 2) {
    addFixture("semi-1", "semi_final");
    addFixture("semi-2", "semi_final");
    addFixture("final", "final");
  }
  return fixtures;
};

const matchDocumentForFixture = (tournament, fixture) => {
  const teamA = (tournament.teams || []).find((team) => team.id === fixture.teamAId);
  const teamB = (tournament.teams || []).find((team) => team.id === fixture.teamBId);
  const playersA = teamA?.players || [];
  const playersB = teamB?.players || [];
  return {
    id: fixture.id,
    matchId: fixture.id,
    tournamentId: tournament.id,
    tournamentName: tournament.name,
    tournamentMatchType: fixture.tournamentMatchType,
    tournamentFixtureId: fixture.id,
    tournamentGroup: fixture.groupId,
    tournamentCreatedBy: tournament.createdBy,
    createdBy: tournament.createdBy,
    teamAId: fixture.teamAId,
    teamBId: fixture.teamBId,
    teamAName: fixture.teamAName,
    teamBName: fixture.teamBName,
    teamA: teamA ? { id: "A", teamId: teamA.id, name: teamA.name, players: playersA } : null,
    teamB: teamB ? { id: "B", teamId: teamB.id, name: teamB.name, players: playersB } : null,
    teamAPlayers: playersA,
    teamBPlayers: playersB,
    matchType: "limited-overs",
    status: fixture.status,
    createdAt: tournament.createdAt,
    updatedAt: tournament.updatedAt,
  };
};

export const createTournament = async ({
  name,
  teams,
  createdBy,
  createdByUser,
}) => {
  const tournamentId = `tournament-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedTeams = teams.map((team, index) => ({
    id: `${tournamentId}-team-${index + 1}`,
    name: nameOf(team.name),
    playerIds: [...new Set((team.playerIds || []).map(idOf))],
    players: team.players || [],
  }));
  const groups = buildGroups(normalizedTeams);
  const tournament = {
    id: tournamentId,
    name: nameOf(name),
    createdBy: idOf(createdBy),
    adminUid: idOf(import.meta.env.VITE_ADMIN_UID),
    createdByUser: createdByUser || null,
    teamCount: normalizedTeams.length,
    teams: normalizedTeams,
    groups,
    fixtures: [],
    status: "UPCOMING",
    winnerId: null,
    winnerName: null,
    statistics: {},
    createdAt: now(),
    updatedAt: now(),
  };

  const fixtures = [
    ...generateLeagueFixtures(tournament),
    ...generateKnockoutFixtures(tournament),
  ];
  tournament.fixtures = fixtures;
  await setDoc(doc(db, TOURNAMENTS, tournamentId), tournament);

  await Promise.all(fixtures.map((fixture) =>
    setDoc(doc(db, MATCHES, fixture.id), matchDocumentForFixture(tournament, fixture), { merge: true })
  ));

  return tournament;
};

export const subscribeToTournaments = (onChange, onError) =>
  onSnapshot(
    collection(db, TOURNAMENTS),
    (snapshot) => onChange(snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))),
    onError
  );

export const getTournament = async (id) => {
  const snapshot = await getDoc(doc(db, TOURNAMENTS, String(id)));
  return snapshot.exists() ? { ...snapshot.data(), id: snapshot.id } : null;
};

export const getTournamentMatches = async (tournamentId) => {
  const snapshot = await getDocs(collection(db, MATCHES));
  return snapshot.docs
    .map((item) => ({ ...item.data(), id: item.id }))
    .filter((match) => idOf(match.tournamentId) === idOf(tournamentId));
};

const inningsForMatch = (match) => {
  if (Array.isArray(match.testInnings) && match.testInnings.length) return match.testInnings;
  return [match.firstInningsData, match.secondInningsData].filter(Boolean);
};

export const calculateTournamentStandings = (tournament, matches = []) => {
  const stats = new Map((tournament.teams || []).map((team) => [
    team.id,
    {
      teamId: team.id,
      teamName: team.name,
      groupId: (tournament.groups || []).find((group) => group.teamIds.includes(team.id))?.id || "A",
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      points: 0,
      runsScored: 0,
      ballsFaced: 0,
      runsConceded: 0,
      ballsBowled: 0,
    },
  ]));

  matches
    .filter((match) => match.tournamentMatchType === "league" && ["finished", "completed"].includes(String(match.status).toLowerCase()))
    .forEach((match) => {
      const teamA = stats.get(match.teamAId) ||
        [...stats.values()].find((item) => item.teamName === (match.teamAName || match.teamA?.name));
      const teamB = stats.get(match.teamBId) ||
        [...stats.values()].find((item) => item.teamName === (match.teamBName || match.teamB?.name));
      if (!teamA || !teamB) return;

      const result = String(match.winner || match.result?.winner || "").toLowerCase();
      const draw = result === "draw" || result === "tie" || String(match.resultText || "").toLowerCase().includes("draw");
      teamA.matchesPlayed += 1;
      teamB.matchesPlayed += 1;
      if (draw) {
        teamA.draws += 1;
        teamB.draws += 1;
        teamA.points += 1;
        teamB.points += 1;
      } else {
        const winnerIsA = result === "a" || result === String(match.teamAName || "").toLowerCase();
        const winner = winnerIsA ? teamA : teamB;
        const loser = winnerIsA ? teamB : teamA;
        winner.wins += 1;
        winner.points += 2;
        loser.losses += 1;
      }

      const innings = inningsForMatch(match);
      innings.forEach((inning) => {
        const batting = inning.teamId === "A" ? teamA : teamB;
        const bowling = inning.teamId === "A" ? teamB : teamA;
        if (!batting || !bowling) return;
        batting.runsScored += Number(inning.runs || 0);
        batting.ballsFaced += Number(inning.balls || 0);
        bowling.runsConceded += Number(inning.runs || 0);
        bowling.ballsBowled += Number(inning.balls || 0);
      });
    });

  return [...stats.values()]
    .map((item) => ({
      ...item,
      nrr: item.ballsFaced && item.ballsBowled
        ? (item.runsScored * 6 / item.ballsFaced) - (item.runsConceded * 6 / item.ballsBowled)
        : 0,
    }))
    .sort((a, b) => b.points - a.points || b.nrr - a.nrr || a.teamName.localeCompare(b.teamName, undefined, { sensitivity: "base" }));
};

export const calculateNetRunRate = (stats) =>
  stats?.ballsFaced && stats?.ballsBowled
    ? (Number(stats.runsScored || 0) * 6 / stats.ballsFaced) -
      (Number(stats.runsConceded || 0) * 6 / stats.ballsBowled)
    : 0;

export const calculateTournamentStatistics = (matches, players = []) => {
  const playerNames = new Map(players.map((player) => [idOf(player.id || player.uid), player.name]));
  const batting = new Map();
  const bowling = new Map();
  const battingNames = new Map();
  const bowlingNames = new Map();
  let highestInningsScore = null;
  let inningsCount = 0;
  let inningsRuns = 0;

  matches
    .filter((match) => ["finished", "completed"].includes(String(match.status).toLowerCase()))
    .forEach((match) => {
      inningsForMatch(match).forEach((inning) => {
        const score = Number(inning.runs || 0);
        inningsCount += 1;
        inningsRuns += score;
        if (!highestInningsScore || score > highestInningsScore.runs) {
          highestInningsScore = {
            runs: score,
            match: `${match.teamAName || "Team A"} vs ${match.teamBName || "Team B"}`,
            team: inning.teamName || "",
          };
        }
        Object.entries(inning.battingStats || {}).forEach(([id, stat]) => {
          const playerId = idOf(stat.playerId || stat.uid || id);
          batting.set(playerId, (batting.get(playerId) || 0) + Number(stat.runs || 0));
          battingNames.set(playerId, stat.playerName || playerNames.get(playerId) || "Unknown Player");
        });
        Object.entries(inning.bowlingStats || {}).forEach(([id, stat]) => {
          const playerId = idOf(stat.playerId || stat.uid || id);
          bowling.set(playerId, (bowling.get(playerId) || 0) + Number(stat.wickets || 0));
          bowlingNames.set(playerId, stat.playerName || playerNames.get(playerId) || "Unknown Player");
        });
      });
    });

  const best = (map, names) => {
    const item = [...map.entries()].sort((a, b) => b[1] - a[1])[0];
    return item ? { player: names.get(item[0]) || "Unknown Player", value: item[1] } : null;
  };
  return {
    highestBatsman: best(batting, battingNames),
    highestBowler: best(bowling, bowlingNames),
    highestInningsScore,
    averageInningsScore: inningsCount ? inningsRuns / inningsCount : 0,
  };
};

const completedMatch = (match) =>
  ["finished", "completed"].includes(String(match?.status || "").toLowerCase()) ||
  Boolean(match?.winner || match?.result?.winner || match?.resultText);

const winnerForMatch = (match, tournament, matches = []) => {
  const result = String(match?.winner || match?.result?.winner || "").toLowerCase();
  const teams = tournament.teams || [];

  const matchType = String(match?.tournamentMatchType || "").toLowerCase()
    .replace(/[\s_-]+/g, "-");
  const isKnockout = matchType === "final" || matchType.startsWith("semi-");
  const isDraw =
    result === "draw" ||
    result === "tie" ||
    String(match?.resultText || "").toLowerCase().includes("draw");

  if (isDraw && isKnockout) {
    const standings = calculateTournamentStandings(tournament, matches);
    const teamA = standings.find((standing) =>
      idOf(standing.teamId) === idOf(match?.teamAId) ||
      nameOf(standing.teamName).toLowerCase() === nameOf(match?.teamAName).toLowerCase()
    );
    const teamB = standings.find((standing) =>
      idOf(standing.teamId) === idOf(match?.teamBId) ||
      nameOf(standing.teamName).toLowerCase() === nameOf(match?.teamBName).toLowerCase()
    );

    if (teamA && teamB) {
      const teamARank = standings.indexOf(teamA);
      const teamBRank = standings.indexOf(teamB);
      return teams.find((team) => idOf(team.id) === idOf(
        teamARank <= teamBRank ? teamA.teamId : teamB.teamId
      )) || null;
    }
  }

  if (isDraw) return null;

  return teams.find((team) =>
    team.id === match?.winnerId ||
    team.name.toLowerCase() === result ||
    (result === "a" && team.id === match?.teamAId) ||
    (result === "b" && team.id === match?.teamBId)
  ) || null;
};

export const syncTournamentStructure = async (tournament, matches) => {
  const leagueMatches = matches.filter((match) => match.tournamentMatchType === "league");
  const allLeagueComplete = leagueMatches.length > 0 && leagueMatches.every(completedMatch);
  const existing = tournament.fixtures || [];
  const scheduledKnockouts = generateKnockoutFixtures(tournament);
  const existingIds = new Set(existing.map((fixture) => fixture.id));
  const missingKnockouts = scheduledKnockouts.filter((fixture) => !existingIds.has(fixture.id));
  if (!allLeagueComplete) {
    if (!missingKnockouts.length) return tournament;
    const fixtures = [...existing, ...missingKnockouts];
    await Promise.all(missingKnockouts.map((fixture) =>
      setDoc(doc(db, MATCHES, fixture.id), matchDocumentForFixture({
        ...tournament,
        updatedAt: now(),
      }, fixture), { merge: true })
    ));
    const updated = { ...tournament, fixtures, updatedAt: now() };
    await setDoc(doc(db, TOURNAMENTS, tournament.id), updated, { merge: true });
    return updated;
  }

  const standings = calculateTournamentStandings(tournament, matches);
  const groups = tournament.groups || [];
  const definitions = [];
  const addDefinition = (id, type, groupId, teamA, teamB) => definitions.push({
    id: `${tournament.id}-${id}`,
    tournamentId: tournament.id,
    tournamentMatchType: type,
    groupId: groupId || null,
    teamAId: teamA?.teamId || null,
    teamBId: teamB?.teamId || null,
    teamAName: teamA?.teamName || "TBD",
    teamBName: teamB?.teamName || "TBD",
    status: "scheduled",
  });

  if (groups.length === 1) {
    const table = standings.filter((item) => item.groupId === groups[0].id);
    if (table.length === 3 || table.length === 4) {
      addDefinition("final", "final", null, table[0], table[1]);
    } else if (table.length >= 5) {
      const semi = existing.find((fixture) => fixture.tournamentMatchType === "semi_final" && fixture.id.endsWith("-semi-1"));
      const semiWinner = semi && winnerForMatch(
        matches.find((match) => String(match.tournamentFixtureId) === String(semi.id)),
        tournament,
        matches
      );
      addDefinition("semi-1", "semi_final", null, table[1], table[2]);
      addDefinition("final", "final", null, table[0], semiWinner ? { teamId: semiWinner.id, teamName: semiWinner.name } : null);
    }
  } else if (groups.length === 2) {
    const tables = groups.map((group) => standings.filter((item) => item.groupId === group.id));
    const [tableA, tableB] = tables;
    const semiOne = existing.find((fixture) => fixture.id.endsWith("-semi-1"));
    const semiTwo = existing.find((fixture) => fixture.id.endsWith("-semi-2"));
    const winnerOne = semiOne && winnerForMatch(
      matches.find((match) => String(match.tournamentFixtureId) === String(semiOne.id)),
      tournament,
      matches
    );
    const winnerTwo = semiTwo && winnerForMatch(
      matches.find((match) => String(match.tournamentFixtureId) === String(semiTwo.id)),
      tournament,
      matches
    );
    addDefinition("semi-1", "semi_final", null, tableA[0], tableB[1]);
    addDefinition("semi-2", "semi_final", null, tableB[0], tableA[1]);
    addDefinition("final", "final", null, winnerOne ? { teamId: winnerOne.id, teamName: winnerOne.name } : null, winnerTwo ? { teamId: winnerTwo.id, teamName: winnerTwo.name } : null);
  }

  const byId = new Map(existing.map((fixture) => [fixture.id, fixture]));
  definitions.forEach((definition) => byId.set(definition.id, { ...byId.get(definition.id), ...definition, status: byId.get(definition.id)?.status || "scheduled" }));
  const fixtures = [...byId.values()];

  await Promise.all(definitions.map((definition) => {
    const existingFixture = existing.find((fixture) => fixture.id === definition.id);
    const fixture = {
      ...existingFixture,
      ...definition,
      status: existingFixture?.status || definition.status || "scheduled",
    };
    return setDoc(doc(db, MATCHES, fixture.id), matchDocumentForFixture({
      ...tournament,
      updatedAt: now(),
    }, fixture), { merge: true });
  }));

  const finalMatch = matches.find((match) => String(match.tournamentFixtureId) === `${tournament.id}-final`);
  const finalWinner = finalMatch && completedMatch(finalMatch)
    ? winnerForMatch(finalMatch, tournament, matches)
    : null;
  const status = finalWinner ? "FINISHED" : matches.some((match) => ["live", "unfinished"].includes(String(match.status).toLowerCase())) ? "LIVE" : "UPCOMING";
  const updated = { ...tournament, fixtures, status, winnerId: finalWinner?.id || null, winnerName: finalWinner?.name || null, updatedAt: now() };
  await setDoc(doc(db, TOURNAMENTS, tournament.id), updated, { merge: true });
  return updated;
};
