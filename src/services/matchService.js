import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";

const MATCHES = "matches";
const INNINGS = "innings";
const DELIVERIES = "deliveries";
const BATTING_STATS = "battingStats";
const BOWLING_STATS = "bowlingStats";
const FIRESTORE_TIMEOUT_MS = 10000;
const OFFLINE_MATCH_QUEUE = "cricket_offline_match_queue";
const OFFLINE_TEAM_QUEUE = "cricket_offline_team_queue";

const readOfflineQueue = () => {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_MATCH_QUEUE) || "[]");
  } catch {
    return [];
  }
};

const writeOfflineQueue = (queue) => {
  localStorage.setItem(OFFLINE_MATCH_QUEUE, JSON.stringify(queue));
};

const queueOfflineMatch = (match) => {
  const queue = readOfflineQueue().filter(
    (item) => String(item.id) !== String(match.id)
  );
  queue.push(clean({ ...match, offlinePending: true }));
  writeOfflineQueue(queue);
};

const queueOfflineTeam = (team) => {
  const queue = (() => {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_TEAM_QUEUE) || "[]");
    } catch {
      return [];
    }
  })().filter((item) => String(item.id || item.teamId) !== String(team.id || team.teamId));
  queue.push(clean(team));
  localStorage.setItem(OFFLINE_TEAM_QUEUE, JSON.stringify(queue));
};

const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${FIRESTORE_TIMEOUT_MS / 1000}s.`)),
        FIRESTORE_TIMEOUT_MS
      );
    }),
  ]);

const currentUserId = () =>
  auth.currentUser?.uid ||
  (() => {
    try {
      const saved =
        localStorage.getItem("cricket_remembered_auth") ||
        sessionStorage.getItem("cricket_auth_session");
      return saved ? JSON.parse(saved)?.id || null : null;
    } catch {
      return null;
    }
  })();

const isoValue = (value) =>
  value?.toDate ? value.toDate().toISOString() : value || null;

const normalizeTimestampFields = (value) => {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isoValue(item)])
  );
};

const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, clean(item)])
  );
};

const playerId = (player) => String(player?.id ?? player?.uid ?? player?._id ?? "");
const playerName = (player) => player?.name || player?.playerName || "Unknown Player";

const playerFields = (player) => ({
  playerId: playerId(player),
  playerName: playerName(player),
  playerEmail: player?.email || "",
  role: player?.role || player?.type || "Player",
  battingPosition: player?.battingPosition || null,
  battingHand: player?.battingHand || null,
  bowlingHand: player?.bowlingHand || null,
  bowlingStyle: player?.bowlingStyle || null,
});

const matchFields = (match, ownerId = currentUserId()) => clean({
  ...match,
  matchId: String(match.id),
  id: undefined,
  createdBy: match.createdBy || ownerId || null,
  createdAt: match.createdAt || new Date().toISOString(),
  startedAt: match.startedAt || null,
  completedAt: match.completedAt || match.finishedAt || null,
  updatedAt: new Date().toISOString(),
  teamAId: match.teamAId || "A",
  teamAName: match.teamAName || match.teamA?.name || "Team A",
  teamBId: match.teamBId || "B",
  teamBName: match.teamBName || match.teamB?.name || "Team B",
  tossWinnerId: match.tossWinnerId || match.secondTossWinner?.id || null,
  tossWinnerName: match.tossWinnerName || match.secondTossWinner?.name || null,
  tossDecision: match.tossDecision || match.secondTossDecision || null,
  battingTeamId: match.battingTeamId || null,
  battingTeamName: match.battingTeamName || match.battingTeam || null,
  bowlingTeamId: match.bowlingTeamId || null,
  bowlingTeamName: match.bowlingTeamName || match.bowlingTeam || null,
  overs: Number(match.overs || 0),
  currentInnings: Number(match.currentInnings ?? match.scoringState?.inningsIndex ?? 0),
  winnerId: match.result?.winnerId || null,
  winnerName: match.result?.winner || match.winner || null,
  result: match.result?.text || match.resultText || null,
});

const writeInnings = async (match, inningsData, inningsNumber) => {
  if (!inningsData) return;
  const inningsId = `${match.id}_innings_${inningsNumber}`;
  const battingTeamId = inningsData.teamId || (inningsNumber === 1 ? match.battingTeamId : match.battingTeamId === "A" ? "B" : "A");
  const battingTeamName = inningsData.teamName || (battingTeamId === "A" ? match.teamAName : match.teamBName);
  const bowlingTeamId = battingTeamId === "A" ? "B" : "A";
  const bowlingTeamName = bowlingTeamId === "A" ? match.teamAName : match.teamBName;
  const balls = Number(inningsData.balls || 0);
  const runs = Number(inningsData.runs || 0);

  await withTimeout(setDoc(doc(db, INNINGS, inningsId), clean({
    inningsId,
    matchId: String(match.id),
    inningsNumber,
    battingTeamId,
    battingTeamName,
    bowlingTeamId,
    bowlingTeamName,
    status: inningsNumber === Number(match.currentInnings || 0) + 1 && match.status === "live" ? "live" : "completed",
    runs,
    wickets: Number(inningsData.wickets || 0),
    balls,
    legalBalls: balls,
    overs: `${Math.floor(balls / 6)}.${balls % 6}`,
    target: inningsNumber === 2 ? Number(match.firstInningsScore || 0) + 1 : null,
    requiredRuns: inningsNumber === 2 ? Math.max(0, Number(match.firstInningsScore || 0) + 1 - runs) : null,
    requiredBalls: inningsNumber === 2 ? Math.max(0, Number(match.overs || 0) * 6 - balls) : null,
    runRate: balls ? Number(((runs / balls) * 6).toFixed(2)) : 0,
    requiredRunRate: inningsNumber === 2 && Number(match.overs || 0) * 6 > balls
      ? Number((((Number(match.firstInningsScore || 0) + 1 - runs) / (Number(match.overs || 0) * 6 - balls)) * 6).toFixed(2))
      : 0,
    startedAt: inningsData.startedAt || match.startedAt || new Date().toISOString(),
    completedAt: match.status === "finished" ? match.completedAt || match.finishedAt || new Date().toISOString() : null,
  })), "Firestore innings update");
};

const writeCollections = async (match, { full = false } = {}) => {
  const state = match.scoringState || {};
  const inningsNumber = Number(state.inningsIndex || 0) + 1;
  const currentInnings = {
    teamId: match.battingTeamId,
    teamName: match.battingTeam,
    runs: state.inningsRuns,
    wickets: state.inningsWickets,
    balls: state.legalBalls,
    battingStats: state.battingStats,
    bowlingStats: state.bowlingStats,
    deliveries: state.deliveries,
    extras: state.extras,
    fallOfWickets: state.fallOfWickets,
  };

  await writeInnings(match, match.firstInningsData, 1);
  await writeInnings(match, currentInnings, inningsNumber);

  const rosterWrites = full ? [
    ...(match.teamA?.players || match.teamAPlayers || []).map((player) => ({
      player,
      teamId: "A",
      teamName: match.teamAName || match.teamA?.name || "Team A",
    })),
    ...(match.teamB?.players || match.teamBPlayers || []).map((player) => ({
      player,
      teamId: "B",
      teamName: match.teamBName || match.teamB?.name || "Team B",
    })),
  ].map(({ player, teamId, teamName }) => {
    const matchPlayerId = `${match.id}_${teamId}_${playerId(player)}`;
    return setDoc(doc(db, "matchPlayers", matchPlayerId), clean({
      matchPlayerId,
      matchId: String(match.id),
      ...playerFields(player),
      teamId,
      teamName,
      isPlaying: true,
      createdAt: match.createdAt || new Date().toISOString(),
    }), { merge: true });
  }) : [];

  const deliveries = full
    ? state.deliveries || []
    : (state.deliveries || []).filter(
      (delivery) =>
        Number(delivery.over) === Number(state.currentOver || 1)
    );
  const deliveryWrites = deliveries.map((delivery, index) => {
    const deliveryId = String(delivery.id || `${match.id}_${inningsNumber}_${index + 1}`);
    return setDoc(doc(db, DELIVERIES, deliveryId), clean({
      ...delivery,
      deliveryId,
      matchId: String(match.id),
      inningsId: `${match.id}_innings_${inningsNumber}`,
      overNumber: delivery.over || 0,
      ballNumber: delivery.ball || 0,
      legalBall: Boolean(delivery.validBall),
      strikerId: delivery.strikerId || null,
      strikerName: delivery.strikerName || null,
      nonStrikerId: delivery.nonStrikerId || null,
      nonStrikerName: delivery.nonStrikerName || null,
      bowlerId: delivery.bowlerId || null,
      bowlerName: delivery.bowlerName || null,
      batsmanRuns: Number(delivery.batterRuns || 0),
      extras: Number(delivery.extras || 0),
      totalRuns: Number(delivery.runs || 0),
      extraType: delivery.type || null,
      isWide: delivery.type === "WD",
      isNoBall: delivery.type === "NB",
      isBye: delivery.type === "BYE",
      isLegBye: delivery.type === "LB",
      isPenalty: false,
      wicket: delivery.wicket || null,
      wicketType: delivery.wicket?.type || null,
      dismissedPlayerId: delivery.wicket?.batterId || null,
      dismissedPlayerName: delivery.wicket?.batterName || null,
      fielderId: delivery.wicket?.fielderId || null,
      fielderName: delivery.wicket?.fielder || null,
      createdAt: delivery.createdAt || new Date().toISOString(),
    }));
  });

  const battingWrites = Object.values(state.battingStats || {}).map((stat) => {
    const battingStatId = `${match.id}_${inningsNumber}_bat_${stat.id}`;
    return setDoc(doc(db, BATTING_STATS, battingStatId), clean({
      ...stat,
      battingStatId,
      matchId: String(match.id),
      inningsId: `${match.id}_innings_${inningsNumber}`,
      playerId: stat.id,
      playerName: stat.name,
      teamId: match.battingTeamId,
      teamName: match.battingTeam,
      dotBalls: Number(stat.dotBalls || 0),
      strikeRate: stat.balls ? Number(((stat.runs / stat.balls) * 100).toFixed(2)) : 0,
      dismissalType: stat.dismissal || null,
      dismissedByName: stat.bowler || null,
      createdAt: stat.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  });

  const bowlingWrites = Object.values(state.bowlingStats || {}).map((stat) => {
    const bowlingStatId = `${match.id}_${inningsNumber}_bowl_${stat.id}`;
    return setDoc(doc(db, BOWLING_STATS, bowlingStatId), clean({
      ...stat,
      bowlingStatId,
      matchId: String(match.id),
      inningsId: `${match.id}_innings_${inningsNumber}`,
      playerId: stat.id,
      playerName: stat.name,
      teamId: match.bowlingTeamId,
      teamName: match.bowlingTeam,
      overs: `${Math.floor(Number(stat.legalBalls || 0) / 6)}.${Number(stat.legalBalls || 0) % 6}`,
      balls: Number(stat.legalBalls || 0),
      maidens: Number(stat.maidens || 0),
      runsConceded: Number(stat.runs || 0),
      economy: stat.legalBalls ? Number(((stat.runs / stat.legalBalls) * 6).toFixed(2)) : 0,
      createdAt: stat.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  });

  await withTimeout(Promise.all([
    ...rosterWrites,
    ...deliveryWrites,
    ...battingWrites,
    ...bowlingWrites,
  ]), "Firestore over flush");
};

export const saveMatch = async (match, ownerId = currentUserId()) => {
  if (
    match.createdBy &&
    ownerId &&
    String(match.createdBy) !== String(ownerId)
  ) {
    throw new Error("Only the person who started this match can update its score.");
  }

  const data = matchFields(match, ownerId);
  queueOfflineMatch({ ...match, ...data, id: String(match.id) });
  const result = { ...match, ...data, id: String(match.id), offlinePending: true };

  try {
    withTimeout(
      setDoc(doc(db, MATCHES, String(match.id)), data, { merge: true }),
      "Firestore match update"
    ).then(() => {
      const queue = readOfflineQueue().filter(
        (item) => String(item.id) !== String(match.id)
      );
      writeOfflineQueue(queue);
    }).catch((error) => {
      console.error("Match upload postponed:", error);
    });
    return result;
  } catch (error) {
    return result;
  }
};

export const syncOfflineMatches = async () => {
  const queue = readOfflineQueue();
  if (!queue.length || !navigator.onLine) return;

  const remaining = [];
  for (const match of queue) {
    try {
      const data = matchFields(match, currentUserId());
      await withTimeout(
        setDoc(doc(db, MATCHES, String(match.id)), data, { merge: true }),
        "Offline match upload"
      );
      await writeCollections({ ...match, ...data }, { full: true });
    } catch (error) {
      console.error("Offline match upload postponed:", error);
      remaining.push(match);
    }
  }
  writeOfflineQueue(remaining);
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    syncOfflineMatches().catch((error) =>
      console.error("Offline match sync failed:", error)
    );
  });
  if (navigator.onLine) {
    setTimeout(() => {
      syncOfflineMatches().catch((error) =>
        console.error("Initial offline match sync failed:", error)
      );
    }, 0);
  }
}

export const deleteMatchCascade = async (matchId, ownerId = currentUserId()) => {
  const id = String(matchId);
  const matchRef = doc(db, MATCHES, id);
  const matchSnapshot = await withTimeout(getDocs(query(collection(db, MATCHES), where("matchId", "==", id))), "Firestore match lookup");
  const matchData = matchSnapshot.docs[0]?.data();

  if (
    matchData?.createdBy &&
    String(matchData.createdBy) !== String(ownerId) &&
    String(ownerId) !== ADMIN_ID
  ) {
    throw new Error("Only the match creator can delete this match.");
  }

  const relatedCollections = [
    "matchPlayers",
    INNINGS,
    DELIVERIES,
    BATTING_STATS,
    BOWLING_STATS,
  ];
  const deletions = [deleteDoc(matchRef)];

  for (const name of relatedCollections) {
    const snapshot = await withTimeout(
      getDocs(query(collection(db, name), where("matchId", "==", id))),
      `Firestore ${name} lookup`
    );
    snapshot.docs.forEach((item) => deletions.push(deleteDoc(item.ref)));
  }

  await withTimeout(Promise.all(deletions), "Firestore match deletion");
};

export const flushMatchData = async (
  match,
  { full = false } = {}
) => {
  const ownerId = currentUserId();
  if (
    match.createdBy &&
    ownerId &&
    String(match.createdBy) !== String(ownerId)
  ) {
    throw new Error("Only the match creator can save match details.");
  }

  try {
    await writeCollections(match, { full });
  } catch (error) {
    queueOfflineMatch(match);
    throw error;
  }
};

export const subscribeToMatches = (onChange, onError) =>
  onSnapshot(query(collection(db, MATCHES)), (snapshot) => {
    const remoteMatches = snapshot.docs.map((item) => ({
      ...normalizeTimestampFields(item.data()),
      id: item.id,
    }));
    const pending = readOfflineQueue();
    const byId = new Map(remoteMatches.map((match) => [String(match.id), match]));
    pending.forEach((match) => byId.set(String(match.id), match));
    onChange([...byId.values()]);
  }, onError);

export const subscribeToMatch = (matchId, onChange, onError) =>
  onSnapshot(doc(db, MATCHES, String(matchId)), (snapshot) => {
    if (!snapshot.exists()) {
      const local = readOfflineQueue().find(
        (match) => String(match.id) === String(matchId)
      );
      onChange(local || null);
      return;
    }
    const remote = { ...normalizeTimestampFields(snapshot.data()), id: snapshot.id };
    const local = readOfflineQueue().find(
      (match) => String(match.id) === String(matchId)
    );
    const remoteTime = new Date(remote.updatedAt || 0).getTime();
    const localTime = new Date(local?.updatedAt || 0).getTime();
    onChange(local && localTime > remoteTime ? local : remote);
  }, onError);

export const subscribeToPlayers = (onChange, onError) => {
  getDocs(collection(db, "players")).then((snapshot) => {
    onChange(snapshot.docs.map((item) => ({
      id: item.id,
      uid: item.id,
      ...normalizeTimestampFields(item.data()),
    })));
  }).catch(onError);
  return () => {};
};

export const subscribeToTeams = (onChange, onError) => {
  getDocs(collection(db, "teams")).then((snapshot) => {
    onChange(snapshot.docs.map((item) => ({
      id: item.id,
      teamId: item.id,
      ...normalizeTimestampFields(item.data()),
    })));
  }).catch(onError);
  return () => {};
};

export const subscribeToTeamPlayers = (onChange, onError) => {
  getDocs(collection(db, "teamPlayers")).then((snapshot) => {
    onChange(snapshot.docs.map((item) => ({
      id: item.id,
      ...normalizeTimestampFields(item.data()),
    })));
  }).catch(onError);
  return () => {};
};

export const saveTeam = async (team, ownerId = currentUserId()) => {
  const teamId = String(team.teamId || team.id || crypto.randomUUID());
  const players = Array.from(
    new Map(
      (team.players || []).map((player) => [
        String(playerId(player)),
        player,
      ]).filter(([id]) => id && id !== "undefined" && id !== "null")
    ).values()
  );
  const teamData = clean({
    teamId,
    teamName: team.teamName || team.name,
    shortName: team.shortName || (team.teamName || team.name || "Team").slice(0, 3).toUpperCase(),
    captainId: team.captainId || team.captain?.id || null,
    captainName: team.captainName || team.captain?.name || null,
    playerIds: players.map((player) => playerId(player)),
    createdBy: team.createdBy || ownerId || null,
    createdAt: team.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const result = { ...team, ...teamData, id: teamId, name: teamData.teamName };
  queueOfflineTeam(result);

  const upload = async () => {
    await withTimeout(
      setDoc(doc(db, "teams", teamId), teamData, { merge: true }),
      "Firestore team update"
    );
    await Promise.all(players.map((player) => {
      const teamPlayerId = `${teamId}_${playerId(player)}`;
      return setDoc(doc(db, "teamPlayers", teamPlayerId), clean({
        teamPlayerId,
        teamId,
        ...playerFields(player),
        joinedAt: new Date().toISOString(),
      }), { merge: true });
    }));
  };

  try {
    await upload();
    const queue = JSON.parse(localStorage.getItem(OFFLINE_TEAM_QUEUE) || "[]")
      .filter((item) => String(item.id || item.teamId) !== teamId);
    localStorage.setItem(OFFLINE_TEAM_QUEUE, JSON.stringify(queue));
  } catch (error) {
    console.error("Team upload postponed:", error);
  }

  return result;
};

export const getCurrentUserId = currentUserId;
