import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { auth, db } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";
import { calculateCompetitionPlayerAward } from "./competitionPlayerAwards";

const SERIES = "series";
const MATCHES = "matches";
const MATCH_RECORD_COLLECTIONS = [
  "innings",
  "deliveries",
  "battingStats",
  "bowlingStats",
  "matchPlayers",
];
const MATCH_ID_CHUNK_SIZE = 10;
const DELETE_BATCH_SIZE = 450;

const idOf = (value) =>
  String(
    typeof value === "object"
      ? value?.id ?? value?.uid ?? value?.teamId ?? value?._id ?? ""
      : value ?? ""
  ).trim();

const normalize = (value) => idOf(value).toLowerCase();
const now = () => new Date().toISOString();
const isCompleted = (match) =>
  ["finished", "completed"].includes(String(match?.status || "").toLowerCase());

const matchWinnerSide = (match) => {
  const values = [
    match?.winnerId,
    match?.winnerTeamId,
    match?.winner,
    match?.result?.winnerId,
    match?.result?.winnerTeamId,
    match?.result?.winner,
  ]
    .map(normalize)
    .filter(Boolean);
  if (values.some((value) => ["draw", "tie"].includes(value))) return "draw";

  for (const side of ["A", "B"]) {
    const teamId = normalize(
      side === "A"
        ? match?.teamAId ?? match?.teamA?.teamId ?? match?.teamA?.id
        : match?.teamBId ?? match?.teamB?.teamId ?? match?.teamB?.id
    );
    const teamName = normalize(
      side === "A"
        ? match?.teamAName ?? match?.teamA?.name
        : match?.teamBName ?? match?.teamB?.name
    );
    if (
      values.some(
        (value) =>
          value === side.toLowerCase() ||
          value === teamId ||
          value === teamName
      )
    ) {
      return side;
    }
  }

  const resultText = String(
    match?.resultText ?? match?.result?.text ?? ""
  ).toLowerCase();
  if (resultText.includes("draw") || resultText.includes("tie")) return "draw";
  return null;
};

const inningsForMatch = (match) => {
  const saved = [
    ...(Array.isArray(match?.testInnings) ? match.testInnings : []),
    ...(Array.isArray(match?.innings) ? match.innings : []),
    ...(Array.isArray(match?.inningsData) ? match.inningsData : []),
    match?.firstInningsData,
    match?.secondInningsData,
  ].filter(Boolean);
  const byNumber = new Map();
  saved.forEach((inning, index) => {
    const explicitNumber = Number(inning?.inningsNumber);
    const explicitIndex = Number(inning?.inningsIndex);
    const number =
      Number.isInteger(explicitNumber) && explicitNumber > 0
        ? explicitNumber
        : Number.isInteger(explicitIndex) && explicitIndex >= 0
          ? explicitIndex + 1
          : index + 1;
    const previous = byNumber.get(number);
    byNumber.set(number, previous ? { ...previous, ...inning } : inning);
  });
  return [...byNumber.entries()]
    .sort(([left], [right]) => left - right)
    .map(([number, inning]) => ({ ...inning, inningsNumber: number }));
};

const statEntries = (stats) =>
  Array.isArray(stats)
    ? stats.filter(Boolean).map((stat, index) => [
        idOf(stat?.playerId ?? stat?.uid ?? stat?.id ?? stat?.name) ||
          `player-${index}`,
        stat,
      ])
    : stats && typeof stats === "object"
      ? Object.entries(stats).filter(([, stat]) => Boolean(stat))
      : [];

const inningsNumberOfStat = (stat) => {
  const number = Number(stat?.inningsNumber ?? stat?.innings);
  if (Number.isInteger(number) && number > 0) return number;
  const index = Number(stat?.inningsIndex);
  if (Number.isInteger(index) && index >= 0) return index + 1;
  const match = String(stat?.inningsId || "").match(/_innings_(\d+)$/i);
  return match ? Number(match[1]) : null;
};

const byMatchId = (records) => {
  const index = new Map();
  records.forEach((record) => {
    const matchId = normalize(record?.matchId ?? record?.matchID ?? record?.match_id);
    if (!matchId) return;
    index.set(matchId, [...(index.get(matchId) || []), record]);
  });
  return index;
};

const playerStatIndex = (records, matchId, inningNumber) =>
  (records.get(normalize(matchId)) || []).filter((record) => {
    const number = inningsNumberOfStat(record);
    return number === null || number === inningNumber;
  });

const addLeaders = (target, entries, fields) => {
  entries.forEach(([key, stat]) => {
    const playerId = normalize(
      stat?.playerId ?? stat?.playerUid ?? stat?.uid ?? stat?.id ?? key
    );
    if (!playerId) return;
    const current = target.get(playerId) || {
      playerId,
      playerName: String(stat?.playerName ?? stat?.name ?? "Unknown Player"),
      value: 0,
    };
    const rawValue = fields
      .map((field) => stat?.[field])
      .find((value) => value !== null && value !== undefined);
    current.value += Number.isFinite(Number(rawValue))
      ? Number(rawValue)
      : 0;
    if (
      current.playerName === "Unknown Player" &&
      (stat?.playerName || stat?.name)
    ) {
      current.playerName = String(stat.playerName || stat.name);
    }
    target.set(playerId, current);
  });
};

export const calculateSeriesProgress = (series, matches = []) => {
  const teamIds = Array.isArray(series?.teamIds) ? series.teamIds : [];
  const teamNames = Array.isArray(series?.teamNames) ? series.teamNames : [];
  const completed = matches.filter(isCompleted);
  const results = {
    A: { wins: 0, losses: 0, draws: 0 },
    B: { wins: 0, losses: 0, draws: 0 },
  };

  completed.forEach((match) => {
    const winner = matchWinnerSide(match);
    if (winner === "draw" || winner === null) {
      results.A.draws += 1;
      results.B.draws += 1;
      return;
    }
    results[winner].wins += 1;
    results[winner === "A" ? "B" : "A"].losses += 1;
  });

  const expected = Number(series?.numberOfMatches || matches.length);
  const isFinished = expected > 0 && completed.length >= expected;
  const isLive = matches.some(
    (match) => String(match?.status || "").toLowerCase() === "live"
  );
  const status = isFinished
    ? "COMPLETED"
    : isLive
      ? "LIVE"
      : "NOT STARTED";
  const teamAName = teamNames[0] || "Team A";
  const teamBName = teamNames[1] || "Team B";
  const winsA = results.A.wins;
  const winsB = results.B.wins;
  let resultLabel = `${teamAName} ${winsA}-${winsB} ${teamBName}`;

  if (isFinished) {
    if (winsA === winsB) {
      resultLabel = `Series Drawn ${winsA}-${winsB}`;
    } else {
      resultLabel = `Series Winner: ${winsA > winsB ? teamAName : teamBName}`;
    }
  } else if (winsA === winsB) {
    resultLabel = `Series tied ${winsA}-${winsB}`;
  } else {
    resultLabel = `${winsA > winsB ? teamAName : teamBName} leads ${winsA}-${winsB}`;
  }

  return {
    status,
    completedMatches: completed.length,
    results,
    resultLabel,
    teamIds,
    teamNames,
  };
};

export const calculateSeriesStatistics = (
  matches = [],
  {
    inningsRecords = [],
    battingStats = [],
    bowlingStats = [],
  } = {}
) => {
  const completed = matches.filter(isCompleted);
  const inningsByMatch = byMatchId(inningsRecords);
  const battingByMatch = byMatchId(battingStats);
  const bowlingByMatch = byMatchId(bowlingStats);
  const runsByPlayer = new Map();
  const wicketsByPlayer = new Map();
  let inningsCount = 0;
  let totalInningsRuns = 0;
  let highestInningsScore = null;

  completed.forEach((match) => {
    const matchId = idOf(match?.id ?? match?.matchId);
    const innings = inningsForMatch(match);
    const knownNumbers = new Set(innings.map((inning) => inning.inningsNumber));
    (inningsByMatch.get(normalize(matchId)) || []).forEach((record, index) => {
      const number = inningsNumberOfStat(record) ?? index + 1;
      if (knownNumbers.has(number)) return;
      knownNumbers.add(number);
      innings.push({
        ...record,
        inningsNumber: number,
        teamId: record?.battingTeamId ?? record?.teamId,
        teamName: record?.battingTeamName ?? record?.teamName,
      });
    });

    innings.forEach((inning, index) => {
      const scoreValue = inning?.runs ?? inning?.totalRuns;
      if (scoreValue === null || scoreValue === undefined) return;
      const score = Number(scoreValue);
      if (!Number.isFinite(score)) return;
      inningsCount += 1;
      totalInningsRuns += score;
      if (!highestInningsScore || score > highestInningsScore.runs) {
        highestInningsScore = {
          runs: score,
          team:
            inning?.teamName ??
            (String(inning?.teamId).toUpperCase() === "B"
              ? match?.teamBName
              : match?.teamAName) ??
            "Unknown team",
          match: String(
            match?.name ??
              match?.matchName ??
              `${match?.seriesName || "Series"} Match ${
                match?.seriesMatchNumber || ""
              }`.trim()
          ),
          inningsNumber:
            Number(inning?.inningsNumber ?? index + 1),
        };
      }

      const number = Number(inning?.inningsNumber ?? index + 1);
      let battingEntries = statEntries(inning?.battingStats);
      let bowlingEntries = statEntries(inning?.bowlingStats);
      if (!battingEntries.length) {
        battingEntries = playerStatIndex(
          battingByMatch,
          matchId,
          number
        ).map((stat, statIndex) => [
          idOf(stat?.playerId ?? stat?.id) || `bat-${statIndex}`,
          stat,
        ]);
      }
      if (!bowlingEntries.length) {
        bowlingEntries = playerStatIndex(
          bowlingByMatch,
          matchId,
          number
        ).map((stat, statIndex) => [
          idOf(stat?.playerId ?? stat?.id) || `bowl-${statIndex}`,
          stat,
        ]);
      }
      addLeaders(runsByPlayer, battingEntries, ["runs", "battingRuns"]);
      addLeaders(wicketsByPlayer, bowlingEntries, ["wickets", "wicketCount"]);
    });
  });

  const leader = (players) =>
    [...players.values()].sort(
      (left, right) =>
        right.value - left.value ||
        left.playerName.localeCompare(right.playerName)
    )[0] || null;

  return {
    highestRunScorer: leader(runsByPlayer),
    highestWicketTaker: leader(wicketsByPlayer),
    highestInningsScore,
    averageInningsScore: inningsCount
      ? totalInningsRuns / inningsCount
      : null,
    completedInnings: inningsCount,
    playerOfCompetition: calculateCompetitionPlayerAward(completed, {
      inningsRecords,
      battingStats,
      bowlingStats,
    }),
  };
};

export const loadSeriesStatistics = async (matches = []) => {
  const matchIds = matches
    .filter(isCompleted)
    .map((match) => idOf(match?.id ?? match?.matchId))
    .filter(Boolean);
  const records = {
    inningsRecords: [],
    battingStats: [],
    bowlingStats: [],
  };

  for (let index = 0; index < matchIds.length; index += MATCH_ID_CHUNK_SIZE) {
    const ids = matchIds.slice(index, index + MATCH_ID_CHUNK_SIZE);
    const [inningsSnapshot, battingSnapshot, bowlingSnapshot] =
      await Promise.all(
        [
          "innings",
          "battingStats",
          "bowlingStats",
        ].map((collectionName) =>
          getDocs(
            query(
              collection(db, collectionName),
              where("matchId", "in", ids)
            )
          )
        )
      );
    records.inningsRecords.push(
      ...inningsSnapshot.docs.map((item) => ({ ...item.data(), id: item.id }))
    );
    records.battingStats.push(
      ...battingSnapshot.docs.map((item) => ({ ...item.data(), id: item.id }))
    );
    records.bowlingStats.push(
      ...bowlingSnapshot.docs.map((item) => ({ ...item.data(), id: item.id }))
    );
  }
  return calculateSeriesStatistics(matches, records);
};

export const subscribeToSeries = (onChange, onError) =>
  onSnapshot(
    collection(db, SERIES),
    (snapshot) =>
      onChange(
        snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))
      ),
    onError
  );

export const subscribeToSeriesMatches = (seriesId, onChange, onError) =>
  onSnapshot(
    query(collection(db, MATCHES), where("seriesId", "==", String(seriesId))),
    (snapshot) =>
      onChange(
        snapshot.docs
          .map((item) => ({ ...item.data(), id: item.id }))
          .sort(
            (left, right) =>
              Number(left.seriesMatchNumber || 0) -
              Number(right.seriesMatchNumber || 0)
          )
      ),
    onError
  );

export const subscribeToAllSeriesMatches = (onChange, onError) =>
  onSnapshot(
    query(collection(db, MATCHES), where("seriesId", "!=", null)),
    (snapshot) =>
      onChange(
        snapshot.docs.map((item) => ({ ...item.data(), id: item.id }))
      ),
    onError
  );

export const createSeries = async ({
  name,
  numberOfMatches,
  teams,
  createdBy,
}) => {
  const cleanName = String(name || "").trim();
  const count = Number(numberOfMatches);
  if (!cleanName) throw new Error("Enter a series name.");
  if (!Number.isInteger(count) || count < 2 || count > 10) {
    throw new Error("Choose between 2 and 10 matches.");
  }
  if (!Array.isArray(teams) || teams.length !== 2) {
    throw new Error("Select two teams for the series.");
  }

  const [teamA, teamB] = teams;
  const teamAId = idOf(teamA?.teamId ?? teamA?.id);
  const teamBId = idOf(teamB?.teamId ?? teamB?.id);
  if (!teamAId || !teamBId || teamAId === teamBId) {
    throw new Error("Select two different teams.");
  }
  if (!String(createdBy || auth.currentUser?.uid || "")) {
    throw new Error("Sign in before creating a series.");
  }

  const seriesReference = doc(collection(db, SERIES));
  const seriesId = seriesReference.id;
  const timestamp = now();
  const teamNames = [
    String(teamA?.name || "Team A"),
    String(teamB?.name || "Team B"),
  ];
  const series = {
    id: seriesId,
    name: cleanName,
    createdBy: String(createdBy || auth.currentUser?.uid || ""),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "not_started",
    numberOfMatches: count,
    teamIds: [teamAId, teamBId],
    teamNames,
  };
  const batch = writeBatch(db);
  batch.set(seriesReference, series);

  Array.from({ length: count }, (_, index) => index + 1).forEach(
    (seriesMatchNumber) => {
      const matchReference = doc(collection(db, MATCHES));
      const matchName = `${cleanName} Match ${seriesMatchNumber}`;
      const playersA = Array.isArray(teamA?.players) ? teamA.players : [];
      const playersB = Array.isArray(teamB?.players) ? teamB.players : [];
      batch.set(matchReference, {
        id: matchReference.id,
        matchId: matchReference.id,
        name: matchName,
        matchName,
        seriesId,
        seriesName: cleanName,
        seriesMatchNumber,
        matchType: "limited-overs",
        competitionType: "series",
        status: "scheduled",
        createdBy: series.createdBy,
        createdAt: timestamp,
        updatedAt: timestamp,
        teamAId,
        teamBId,
        teamAName: teamNames[0],
        teamBName: teamNames[1],
        teamA: {
          id: "A",
          teamId: teamAId,
          name: teamNames[0],
          captain: teamA?.captain ?? null,
          players: playersA,
          teamPlayers: playersA,
        },
        teamB: {
          id: "B",
          teamId: teamBId,
          name: teamNames[1],
          captain: teamB?.captain ?? null,
          players: playersB,
          teamPlayers: playersB,
        },
        teamAPlayers: playersA,
        teamBPlayers: playersB,
      });
    }
  );

  await batch.commit();
  return series;
};

export const deleteSeriesCascade = async (seriesId) => {
  if (
    !ADMIN_UID ||
    String(auth.currentUser?.uid || "") !== String(ADMIN_UID)
  ) {
    throw new Error("Only the admin can delete a series.");
  }
  const id = String(seriesId);
  const matchSnapshot = await getDocs(
    query(collection(db, MATCHES), where("seriesId", "==", id))
  );
  const matches = matchSnapshot.docs.map((item) => ({
    id: item.id,
    data: item.data(),
    reference: item.ref,
  }));
  const matchIds = matches.map((match) => match.id);
  const references = matches.map((match) => match.reference);

  for (const matchId of matchIds) {
    const commentaryRoot = collection(db, "commentary", matchId, "innings");
    const inningsSnapshot = await getDocs(commentaryRoot);
    for (const inning of inningsSnapshot.docs) {
      references.push(inning.ref);
      const oversSnapshot = await getDocs(
        collection(db, "commentary", matchId, "innings", inning.id, "overs")
      );
      for (const over of oversSnapshot.docs) {
        references.push(over.ref);
        const ballsSnapshot = await getDocs(
          collection(
            db,
            "commentary",
            matchId,
            "innings",
            inning.id,
            "overs",
            over.id,
            "balls"
          )
        );
        ballsSnapshot.docs.forEach((ball) => references.push(ball.ref));
      }
    }
  }

  for (
    let index = 0;
    index < matchIds.length;
    index += MATCH_ID_CHUNK_SIZE
  ) {
    const ids = matchIds.slice(index, index + MATCH_ID_CHUNK_SIZE);
    const relatedSnapshots = await Promise.all(
      MATCH_RECORD_COLLECTIONS.map((collectionName) =>
        getDocs(
          query(
            collection(db, collectionName),
            where("matchId", "in", ids)
          )
        )
      )
    );
    relatedSnapshots.forEach((snapshot) =>
      snapshot.docs.forEach((item) => references.push(item.ref))
    );
  }

  for (
    let index = 0;
    index < references.length;
    index += DELETE_BATCH_SIZE
  ) {
    const batch = writeBatch(db);
    references
      .slice(index, index + DELETE_BATCH_SIZE)
      .forEach((reference) => batch.delete(reference));
    await batch.commit();
  }

  await deleteDoc(doc(db, SERIES, id));
  return matches.length;
};
