import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./scoring.css";
import { calculateWinPrediction } from "../services/winPrediction";
import {
  getCurrentUserId,
  flushMatchData,
  saveMatch,
  subscribeToMatch,
  saveTeam,
  deleteTeam,
  pruneTeamPlayers,
  getTeamsOnce,
  getPlayersOnce,
  getMatchesOnce,
  getCareerStatsOnce,
} from "../services/matchService";

/* =========================================================
   HELPERS
========================================================= */

function ScoringWinPredictionCard({ prediction, live = true }) {
  const fairPrediction = fairLiveWinPrediction(prediction, live);
  if (!fairPrediction) return null;
  const a = Math.round(Number(fairPrediction.A || 0));
  const b = Math.round(Number(fairPrediction.B || 0));
  return (
    <section className="win-prediction-card" aria-label="Live win prediction">
      <div className="win-prediction-header">
        <div>
          <p className="win-prediction-eyebrow">LIVE WIN PREDICTION</p>
          <small>{fairPrediction.phase === "pre-match" ? "PRE-MATCH" : fairPrediction.phase === "finished" ? "FINAL" : "LIVE"}{fairPrediction.h2hIncluded ? " • H2H included" : ""}</small>
        </div>
        <span className="win-prediction-live-dot" />
      </div>
      <div className="win-prediction-team">
        <div className="win-prediction-label"><strong>{fairPrediction.teamA}</strong><b>{a}%</b></div>
        <div className="win-prediction-track"><span className="win-prediction-fill win-prediction-fill-a" style={{ width: `${a}%` }} /></div>
      </div>
      <div className="win-prediction-team">
        <div className="win-prediction-label"><strong>{fairPrediction.teamB}</strong><b>{b}%</b></div>
        <div className="win-prediction-track"><span className="win-prediction-fill win-prediction-fill-b" style={{ width: `${b}%` }} /></div>
      </div>
      {fairPrediction.metrics && (
        <div className="win-prediction-metrics">
          {fairPrediction.metrics.runsRequired != null && <span><small>Required</small><b>{fairPrediction.metrics.runsRequired}</b></span>}
          <span><small>Current RR</small><b>{Number(fairPrediction.metrics.currentRR || 0).toFixed(2)}</b></span>
          {fairPrediction.metrics.runsRequired != null && <span><small>Required RR</small><b>{Number.isFinite(fairPrediction.metrics.requiredRR) ? Number(fairPrediction.metrics.requiredRR).toFixed(2) : "—"}</b></span>}
          <span><small>Recent 6 Balls</small><b>{fairPrediction.metrics.recentSixRuns}</b></span>
        </div>
      )}
    </section>
  );
}


const PLAYER_ID = (player) =>
  String(
    player?.id ??
      player?._id ??
      player?.playerId ??
      player?.name ??
      ""
  );

const PLAYER_NAME = (player) =>
  player?.name ||
  player?.playerName ||
  "Unknown Player";

/* =========================================================
   CAREER STATS
   Career numbers are stored differently across the app,
   so every known field name is checked here.
========================================================= */

const CAREER_RUNS = (player, careerStats) => {
  const id = String(PLAYER_ID(player));

  const aggregated = careerStats?.runsByPlayer?.[id];
  if (aggregated !== undefined) {
    const parsedAggregate = Number(aggregated);
    return Number.isFinite(parsedAggregate) ? parsedAggregate : 0;
  }

  const value =
    player?.careerRuns ??
    player?.totalRuns ??
    player?.runsScored ??
    player?.career?.runs ??
    player?.stats?.runs ??
    player?.stats?.totalRuns ??
    player?.battingStats?.runs ??
    player?.runs ??
    0;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const CAREER_WICKETS = (player, careerStats) => {
  const id = String(PLAYER_ID(player));

  const aggregated = careerStats?.wicketsByPlayer?.[id];
  if (aggregated !== undefined) {
    const parsedAggregate = Number(aggregated);
    return Number.isFinite(parsedAggregate) ? parsedAggregate : 0;
  }

  const value =
    player?.careerWickets ??
    player?.totalWickets ??
    player?.wicketsTaken ??
    player?.career?.wickets ??
    player?.stats?.wickets ??
    player?.stats?.totalWickets ??
    player?.bowlingStats?.wickets ??
    player?.wickets ??
    0;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const UNIQUE_PLAYERS = (players = []) => {
  const map = new Map();

  players.forEach((player) => {
    const id = PLAYER_ID(player);

    if (id && !map.has(id)) {
      map.set(id, player);
    }
  });

  return [...map.values()];
};

const TEAM_PLAYERS = (team, fallback = []) => {
  if (!team) return UNIQUE_PLAYERS(fallback);

  return UNIQUE_PLAYERS(
    team.players ||
      team.teamPlayers ||
      team.members ||
      fallback
  );
};

const formatOvers = (balls = 0) => {
  return `${Math.floor(Number(balls) / 6)}.${Number(balls) % 6}`;
};

const strikeRate = (runs, balls) => {
  if (!balls) return "0.00";
  return ((runs / balls) * 100).toFixed(2);
};

const economy = (runs, balls) => {
  if (!balls) return "0.00";
  return ((runs / balls) * 6).toFixed(2);
};

const makeBatter = (player, order) => ({
  id: PLAYER_ID(player),
  name: PLAYER_NAME(player),
  battingOrder: order,
  runs: 0,
  balls: 0,
  fours: 0,
  sixes: 0,
  status: "yet",
  dismissal: null,
  fielder: null,
  bowler: null,
});

const makeBowler = (player) => ({
  id: PLAYER_ID(player),
  name: PLAYER_NAME(player),
  legalBalls: 0,
  runs: 0,
  wickets: 0,
  maidens: 0,
});

const emptyExtras = () => ({
  nb: 0,
  wd: 0,
  bye: 0,
  lb: 0,
});

const clone = (value) =>
  JSON.parse(JSON.stringify(value));

const isBowlerWicket = (type) =>
  [
    "Bowled",
    "Caught",
    "Caught & Bowled",
    "LBW",
    "Stumped",
    "Hit Wicket",
    "Boundary Wicket",
  ].includes(type);

const getBallTimelineLabel = (ball) => {
  if (!ball) return "";

  if (ball.type === "NB") {
    const batRuns = Number(ball.batterRuns || 0);
    const hasWicket = !!ball.wicket;

    if (hasWicket) {
      return batRuns > 0 ? `nb+${batRuns} w` : "nb w";
    }

    return batRuns > 0 ? `nb+${batRuns}` : "nb";
  }

  if (ball.type === "WD") {
    const extra = Math.max(0, Number(ball.runs || 0) - 1);
    const hasWicket = !!ball.wicket;
    const label = extra > 0 ? `wd+${extra}` : "wd";
    return hasWicket ? `${label} w` : label;
  }

  if (ball.type === "BYE") {
    const label = `b${Number(ball.runs || 0)}`;
    return ball.wicket ? `${label} w` : label;
  }

  if (ball.type === "LB") {
    const label = `lb${Number(ball.runs || 0)}`;
    return ball.wicket ? `${label} w` : label;
  }

  if (ball.type === "WICKET") {
    const runs = Number(ball.runs || 0);
    return runs > 0 ? `${runs} w` : "w";
  }

  if (ball.type === "DEAD") {
    return "dead";
  }

  const runs = Number(ball.runs || 0);
  return ball.wicket ? `${runs} w` : String(runs);
};

const getBallTimelineTitle = (ball) => {
  if (!ball) return "";
  const wicket = ball.wicket?.type ? ` • ${ball.wicket.type}` : "";
  return `Ball ${ball.ball || ""}: ${getBallTimelineLabel(ball)}${wicket}`;
};


const saveMatchEverywhere = (updated, matchId) =>
  saveMatch({ ...updated, id: updated?.id || matchId }).catch((error) => {
    console.error("Unable to update match in Firebase:", error);
  });

const wicketsInHand = (teamSize, wickets) => {
  const totalWickets = Math.max(0, Number(teamSize || 0));
  const wicketsLost = Number(wickets || 0);

  return Math.max(
    0,
    totalWickets - wicketsLost
  );
};

/*
 * Live cricket predictions should never display an absolute
 * 100/0 outcome while the match is still active.
 * Finished-match predictions remain unchanged.
 */
const FAIR_MIN_WIN_CHANCE = 10;

const fairLiveWinPrediction = (prediction, live = true) => {
  if (!prediction || !live) {
    return prediction;
  }

  const rawA = Number(prediction.A);
  const rawB = Number(prediction.B);

  if (!Number.isFinite(rawA) || !Number.isFinite(rawB)) {
    return prediction;
  }

  const total = rawA + rawB;
  const normalizedA =
    total > 0
      ? (Math.max(0, Math.min(100, rawA)) / total) * 100
      : 50;

  // Never expose an absolute 100/0 while the match is still live.
  // Scorify can continue a chase with one batsman remaining.
  const fairA = Math.min(
    100 - FAIR_MIN_WIN_CHANCE,
    Math.max(FAIR_MIN_WIN_CHANCE, normalizedA)
  );
  const fairB = 100 - fairA;

  return {
    ...prediction,
    A: Number(fairA.toFixed(2)),
    B: Number(fairB.toFixed(2)),
  };
};

/* =========================================================
   SQUAD HELPERS
========================================================= */

const ROSTER_IDS = (players = []) =>
  players.map((player) => String(PLAYER_ID(player)));

const SAME_ROSTER = (a = [], b = []) => {
  const first = [...ROSTER_IDS(a)].sort();
  const second = [...ROSTER_IDS(b)].sort();

  if (first.length !== second.length) return false;

  return first.every((id, index) => id === second[index]);
};

const MERGE_PLAYER_LIST = (existing = [], incoming = []) => {
  const map = new Map();

  [...existing, ...incoming].forEach((player) => {
    const id = PLAYER_ID(player);
    if (id && !map.has(id)) {
      map.set(id, player);
    }
  });

  return [...map.values()];
};

/* =========================================================
   SQUAD DATA SOURCES
========================================================= */

const loadPlayerPool = async () => {
  try {
    const players = await getPlayersOnce();

    if (Array.isArray(players) && players.length) {
      return UNIQUE_PLAYERS(players);
    }
  } catch (error) {
    console.warn("Unable to load players:", error);
  }

  /* Fall back to every player already saved inside a team. */
  try {
    const savedTeams = await getTeamsOnce();

    return UNIQUE_PLAYERS(
      (savedTeams || []).flatMap((team) => TEAM_PLAYERS(team))
    );
  } catch (error) {
    console.warn("Unable to load teams:", error);
    return [];
  }
};

const TEAM_LABEL = (team) =>
  String(team?.teamName || team?.name || "").trim().toLowerCase();

const MATCH_USES_TEAM = (item, teamId, teamName) => {
  const ids = [
    item?.teamAId,
    item?.teamBId,
    item?.teamA?.id,
    item?.teamB?.id,
  ]
    .filter(Boolean)
    .map((value) => String(value));

  const names = [
    item?.teamAName,
    item?.teamBName,
    item?.teamA?.name,
    item?.teamB?.name,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  if (
    teamId &&
    teamId !== "A" &&
    teamId !== "B" &&
    ids.includes(String(teamId))
  ) {
    return true;
  }

  if (
    teamName &&
    names.includes(String(teamName).trim().toLowerCase())
  ) {
    return true;
  }

  return false;
};

/*
 * Team composition changed during the match.
 *
 * CASE 1: the original team has already played other matches.
 *         -> store the new composition as "<name> changed".
 *            Every existing team stays untouched.
 *
 * CASE 2: the original team has never played before.
 *         -> store the final composition under the same name
 *            and remove the starting team record.
 */
const syncTeamCompositionToDatabase = async ({
  match,
  matchId,
  baseRosters,
  finalRosters,
}) => {
  if (!baseRosters || !finalRosters) return;

  const changedTeams = ["A", "B"].filter(
    (teamId) =>
      !SAME_ROSTER(
        baseRosters[teamId] || [],
        finalRosters[teamId] || []
      )
  );

  if (!changedTeams.length) return;

  const [savedTeams, allMatches] = await Promise.all([
    getTeamsOnce().catch(() => []),
    getMatchesOnce().catch(() => []),
  ]);

  for (const teamId of changedTeams) {
    const originalName =
      (teamId === "A"
        ? match?.teamAName || match?.teamA?.name
        : match?.teamBName || match?.teamB?.name) ||
      `Team ${teamId}`;

    /*
     * matchFields() stores "A" / "B" when no real team id was
     * recorded, so the saved team is matched by name first.
     */
    const savedTeam =
      (savedTeams || []).find(
        (team) =>
          TEAM_LABEL(team) ===
          String(originalName).trim().toLowerCase()
      ) || null;

    const rawId =
      savedTeam?.id ||
      savedTeam?.teamId ||
      (teamId === "A" ? match?.teamAId : match?.teamBId) ||
      match?.[teamId === "A" ? "teamA" : "teamB"]?.id ||
      null;

    const originalId =
      rawId && rawId !== "A" && rawId !== "B" ? String(rawId) : null;

    const players = finalRosters[teamId] || [];

    const playedBefore = (allMatches || []).some(
      (item) =>
        String(item?.id || item?.matchId || "") !== String(matchId) &&
        MATCH_USES_TEAM(item, originalId, originalName)
    );

    try {
      if (playedBefore) {
        /* CASE 1 — keep every old team, add a renamed copy. */
        await saveTeam({
          ...(savedTeam || {}),
          id: `${originalId || teamId}_changed_${Date.now()}`,
          teamId: undefined,
          name: `${originalName} changed`,
          teamName: `${originalName} changed`,
          players,
        });
      } else if (originalId) {
        /* CASE 2 — same name, starting composition replaced. */
        await saveTeam({
          ...(savedTeam || {}),
          id: originalId,
          teamId: originalId,
          name: originalName,
          teamName: originalName,
          players,
        });

        await pruneTeamPlayers(
          originalId,
          players.map((player) => String(PLAYER_ID(player)))
        ).catch((error) =>
          console.warn("Unable to clean old team players:", error)
        );
      } else {
        /* No saved record existed — create one, drop the old id. */
        const newId = `${teamId}_${Date.now()}`;

        await saveTeam({
          id: newId,
          teamId: newId,
          name: originalName,
          teamName: originalName,
          players,
        });

        if (savedTeam?.id) {
          await deleteTeam(savedTeam.id).catch((error) =>
            console.warn("Unable to remove starting team:", error)
          );
        }
      }
    } catch (error) {
      console.error("Unable to sync team composition:", error);
    }
  }
};

/* =========================================================
   COMPONENT
========================================================= */

export default function Scoring() {
  const { matchId } = useParams();
  const navigate = useNavigate();

  /* -------------------------------------------------------
     MATCH
  ------------------------------------------------------- */

  const [match, setMatch] = useState(null);
  const lastFlushedBallRef = useRef(0);

  /* -------------------------------------------------------
     SCREEN
     opening | scoring | finished
  ------------------------------------------------------- */

  const [screen, setScreen] = useState("opening");

  /* -------------------------------------------------------
     INNINGS
  ------------------------------------------------------- */

  const [inningsIndex, setInningsIndex] = useState(0);

  const [inningsRuns, setInningsRuns] = useState(0);
  const [inningsWickets, setInningsWickets] =
    useState(0);

  const [legalBalls, setLegalBalls] = useState(0);
  const [currentOver, setCurrentOver] = useState(0);

  /* -------------------------------------------------------
     SQUADS (live team composition)
  ------------------------------------------------------- */

  const [rosters, setRosters] = useState(null);
  const [rosterHistory, setRosterHistory] = useState(null);
  const [baseRosters, setBaseRosters] = useState(null);

  const [showSquadModal, setShowSquadModal] = useState(false);
  const [squadTeamTab, setSquadTeamTab] = useState("A");
  const [playerPool, setPlayerPool] = useState([]);
  const [poolLoaded, setPoolLoaded] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerRuns, setNewPlayerRuns] = useState("");
  const [newPlayerWickets, setNewPlayerWickets] = useState("");

  /* -------------------------------------------------------
     CAREER STATS
     Total runs / wickets aggregated from every past match's
     battingStats / bowlingStats records, keyed by player id.
  ------------------------------------------------------- */

  const [careerStats, setCareerStats] = useState({
    runsByPlayer: {},
    wicketsByPlayer: {},
  });

  useEffect(() => {
    let cancelled = false;

    getCareerStatsOnce(matchId)
      .then((stats) => {
        if (!cancelled && stats) {
          setCareerStats(stats);
        }
      })
      .catch((error) => {
        console.warn("Unable to load career stats:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [matchId]);

  /* -------------------------------------------------------
     BATTERS
  ------------------------------------------------------- */

  const [strikerId, setStrikerId] = useState("");
  const [nonStrikerId, setNonStrikerId] =
    useState("");

  const [battingMode, setBattingMode] =
    useState(2);

  /* -------------------------------------------------------
     BOWLER
  ------------------------------------------------------- */

  const [currentBowlerId, setCurrentBowlerId] =
    useState("");

  /* -------------------------------------------------------
     OPENING / BOWLER / BATTER MODALS
  ------------------------------------------------------- */

  const [showOpenerModal, setShowOpenerModal] =
    useState(false);

  const [showBowlerModal, setShowBowlerModal] =
    useState(false);

  const [showBatterModal, setShowBatterModal] =
    useState(false);

  /* -------------------------------------------------------
     WICKET
  ------------------------------------------------------- */

  const [showWicketModal, setShowWicketModal] =
    useState(false);

  const [wicketType, setWicketType] =
    useState("Bowled");

  const [wicketBatterId, setWicketBatterId] =
    useState("");

  const [wicketFielderId, setWicketFielderId] =
    useState("");

  const [wicketRuns, setWicketRuns] =
    useState(0);

  /*
   * Two-batter Run Out:
   * explicitly record where both batters finished when the
   * wicket was effected.
   */
  const [runOutDismissedPosition, setRunOutDismissedPosition] =
    useState("striker");

  const [runOutOtherPosition, setRunOutOtherPosition] =
    useState("nonStriker");

  /* -------------------------------------------------------
     NEW BATSMAN
  ------------------------------------------------------- */

  const [pendingReplacement, setPendingReplacement] =
    useState(null);

  /* -------------------------------------------------------
     EXTRA PANEL
  ------------------------------------------------------- */

  const [extraPanel, setExtraPanel] =
    useState(null);
  const extraPanelRef = useRef(null);

  /*
    null
    NB
    WD
    BYE
    LB
  */

  const [extraRuns, setExtraRuns] =
    useState(null);

  useEffect(() => {
    if (!extraPanel) return;

    window.requestAnimationFrame(() => {
      const panel = extraPanelRef.current;
      panel?.focus({ preventScroll: true });
      panel?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    });
  }, [extraPanel]);

  const [nbMode, setNbMode] =
    useState(null);

  /* Special wicket controls for NB / WD */
  const [nbWicketType, setNbWicketType] = useState(null);
  const [nbWicketBatterId, setNbWicketBatterId] = useState("");
  const [nbWicketFielderId, setNbWicketFielderId] = useState("");
  const [wdWicketBatterId, setWdWicketBatterId] = useState("");
  const [wdWicketFielderId, setWdWicketFielderId] = useState("");

  /*
    BAT
    BYE
  */

  /* -------------------------------------------------------
     SCORE DATA
  ------------------------------------------------------- */

  const [currentOverBalls, setCurrentOverBalls] =
    useState([]);

  const [deliveries, setDeliveries] =
    useState([]);

  const [battingStats, setBattingStats] =
    useState({});

  const [bowlingStats, setBowlingStats] =
    useState({});

  const [extras, setExtras] =
    useState(emptyExtras());

  const [fallOfWickets, setFallOfWickets] =
    useState([]);

  const [completedOvers, setCompletedOvers] =
    useState([]);

  /* -------------------------------------------------------
     FREE HIT
  ------------------------------------------------------- */

  const [freeHit, setFreeHit] =
    useState(false);

  /* -------------------------------------------------------
     HISTORY
  ------------------------------------------------------- */

  const [history, setHistory] =
    useState([]);

  /* -------------------------------------------------------
     RESULT
  ------------------------------------------------------- */

  const [result, setResult] =
    useState(null);

  /* -------------------------------------------------------
     SCORECARD TAB
  ------------------------------------------------------- */

  const [scorecardTab, setScorecardTab] =
    useState("A");

  /* =========================================================
     LOAD MATCH
  ========================================================= */

  useEffect(() => {
    const applyMatch = (saved) => {
      if (!saved) return;
      let localPending = null;
      try {
        localPending = JSON.parse(
          sessionStorage.getItem(`cricket_pending_match_${matchId}`) || "null"
        );
      } catch {
        localPending = null;
      }
      const savedTime = new Date(saved.updatedAt || 0).getTime();
      const localTime = new Date(localPending?.updatedAt || 0).getTime();
      const currentUserId = getCurrentUserId();
      const restored =
        localPending &&
        localPending.createdBy === currentUserId &&
        localTime > savedTime
          ? { ...saved, ...localPending }
          : saved;
      setMatch(restored);

      /* -------------------------------------------------------
         RESUME SAVED SCORING STATE
         Everything required to continue a live innings is saved
         inside the match record.
      ------------------------------------------------------- */

      const savedState = restored.scoringState;
      const hasStartedInnings = Boolean(
        savedState && Object.keys(savedState.battingStats || {}).length
      );

      /* -------------------------------------------------------
         SQUADS
         The live composition is restored first so every other
         calculation uses the correct players.
      ------------------------------------------------------- */

      const matchRosters = {
        A: UNIQUE_PLAYERS(
          restored.teamAPlayers ||
            restored.teamA?.players ||
            restored.teamA?.teamPlayers ||
            []
        ),
        B: UNIQUE_PLAYERS(
          restored.teamBPlayers ||
            restored.teamB?.players ||
            restored.teamB?.teamPlayers ||
            []
        ),
      };

      const restoredRosters = savedState?.rosters
        ? {
            A: UNIQUE_PLAYERS(savedState.rosters.A || []),
            B: UNIQUE_PLAYERS(savedState.rosters.B || []),
          }
        : matchRosters;

      const restoredBase = savedState?.baseRosters
        ? {
            A: UNIQUE_PLAYERS(savedState.baseRosters.A || []),
            B: UNIQUE_PLAYERS(savedState.baseRosters.B || []),
          }
        : matchRosters;

      const restoredHistory = savedState?.rosterHistory
        ? {
            A: MERGE_PLAYER_LIST(
              savedState.rosterHistory.A || [],
              restoredRosters.A
            ),
            B: MERGE_PLAYER_LIST(
              savedState.rosterHistory.B || [],
              restoredRosters.B
            ),
          }
        : {
            A: MERGE_PLAYER_LIST(matchRosters.A, restoredRosters.A),
            B: MERGE_PLAYER_LIST(matchRosters.B, restoredRosters.B),
          };

      setRosters(restoredRosters);
      setBaseRosters(restoredBase);
      setRosterHistory(restoredHistory);

      if (savedState) {
        setInningsIndex(savedState.inningsIndex ?? 0);
        setInningsRuns(savedState.inningsRuns ?? 0);
        setInningsWickets(savedState.inningsWickets ?? 0);
        setLegalBalls(savedState.legalBalls ?? 0);
        setCurrentOver(savedState.currentOver ?? 0);

        setStrikerId(savedState.strikerId ?? "");
        setNonStrikerId(savedState.nonStrikerId ?? "");
        setBattingMode(savedState.battingMode ?? 2);
        setCurrentBowlerId(savedState.currentBowlerId ?? "");

        setCurrentOverBalls(savedState.currentOverBalls ?? []);
        setDeliveries(savedState.deliveries ?? []);
        setBattingStats(savedState.battingStats ?? {});
        setBowlingStats(savedState.bowlingStats ?? {});
        setExtras(savedState.extras ?? emptyExtras());
        setFallOfWickets(savedState.fallOfWickets ?? []);
        setCompletedOvers(savedState.completedOvers ?? []);
        setFreeHit(savedState.freeHit ?? false);
        setHistory(savedState.history ?? []);
        setPendingReplacement(savedState.pendingReplacement ?? null);
        setResult(savedState.result ?? saved.result ?? null);
        setScorecardTab(savedState.scorecardTab ?? "A");
      } else if (restored.result) {
        setResult(restored.result);
      }

      if (restored.status === "finished" || restored.status === "completed") {
        setScreen("finished");
      } else if (restored.status === "live" && hasStartedInnings) {
        setScreen("scoring");
      } else {
        setScreen("opening");
      }
    };

    const unsubscribe = subscribeToMatch(
      matchId,
      applyMatch,
      (error) => console.error("Unable to load Firebase match:", error)
    );

    return unsubscribe;
  }, [matchId]);

  /* =========================================================
     TEAMS
  ========================================================= */

  const teams = useMemo(() => {
    if (!match) return null;

    const teamAPlayers =
      rosters?.A ||
      match.teamAPlayers ||
      match.teamA?.players ||
      match.teamA?.teamPlayers ||
      [];

    const teamBPlayers =
      rosters?.B ||
      match.teamBPlayers ||
      match.teamB?.players ||
      match.teamB?.teamPlayers ||
      [];

    return {
      A: {
        id: "A",
        name:
          match.teamAName ||
          match.teamA?.name ||
          "Team A",
        players: UNIQUE_PLAYERS(
          teamAPlayers
        ),
      },

      B: {
        id: "B",
        name:
          match.teamBName ||
          match.teamB?.name ||
          "Team B",
        players: UNIQUE_PLAYERS(
          teamBPlayers
        ),
      },
    };
  }, [match, rosters]);

  /* =========================================================
     FIRST BATTING TEAM
  ========================================================= */

  const firstBattingTeamId = useMemo(() => {
    if (!match) return "A";

    const storedId = String(match.battingTeamId || "").toUpperCase();
    if (storedId === "A" || storedId === "B") {
      return storedId;
    }

    const battingName = String(match.battingTeam || "")
      .trim()
      .toLowerCase();
    const nameA = String(
      match.teamAName || match.teamA?.name || ""
    )
      .trim()
      .toLowerCase();
    const nameB = String(
      match.teamBName || match.teamB?.name || ""
    )
      .trim()
      .toLowerCase();

    if (battingName && battingName === nameB && battingName !== nameA) {
      return "B";
    }

    if (battingName && battingName === nameA) {
      return "A";
    }

    return "A";
  }, [match]);

  /* =========================================================
     CURRENT TEAMS
  ========================================================= */

  const battingTeam = useMemo(() => {
    if (!teams) return null;

    if (inningsIndex === 0) {
      return teams[firstBattingTeamId];
    }

    return teams[
      firstBattingTeamId === "A"
        ? "B"
        : "A"
    ];
  }, [
    teams,
    inningsIndex,
    firstBattingTeamId,
  ]);

  const bowlingTeam = useMemo(() => {
    if (!teams || !battingTeam) {
      return null;
    }

    return battingTeam.id === "A"
      ? teams.B
      : teams.A;
  }, [teams, battingTeam]);

  /* =========================================================
     CURRENT PLAYERS
  ========================================================= */

  const striker = useMemo(() => {
    if (!battingTeam) return null;

    return battingTeam.players.find(
      (player) =>
        PLAYER_ID(player) ===
        String(strikerId)
    );
  }, [battingTeam, strikerId]);

  const nonStriker = useMemo(() => {
    if (!battingTeam) return null;

    return battingTeam.players.find(
      (player) =>
        PLAYER_ID(player) ===
        String(nonStrikerId)
    );
  }, [
    battingTeam,
    nonStrikerId,
  ]);

  const currentBowler = useMemo(() => {
    if (!bowlingTeam) return null;

    return bowlingTeam.players.find(
      (player) =>
        PLAYER_ID(player) ===
        String(currentBowlerId)
    );
  }, [
    bowlingTeam,
    currentBowlerId,
  ]);

  /* =========================================================
     PREDICTION INPUT
     The prediction always uses the live composition so a
     player joining / leaving / switching team immediately
     changes team strength and win percentage.
  ========================================================= */

  const predictionMatch = useMemo(() => {
    if (!match) return match;

    if (!rosters) return match;

    return {
      ...match,
      teamAPlayers: rosters.A,
      teamBPlayers: rosters.B,
      teamA: {
        ...(match.teamA || {}),
        players: rosters.A,
        teamPlayers: rosters.A,
      },
      teamB: {
        ...(match.teamB || {}),
        players: rosters.B,
        teamPlayers: rosters.B,
      },
    };
  }, [match, rosters]);

  /* =========================================================
     PERSIST MATCH
  ========================================================= */

  const persistMatch = (extra = {}) => {
    if (!match) return match;

    const updated = {
      ...match,
      ...extra,
      updatedAt:
        new Date().toISOString(),
    };

    // Keep the newest point locally so a refresh cannot restore an older
    // Firebase snapshot while the write is still in progress.
    try {
      sessionStorage.setItem(
        `cricket_pending_match_${matchId}`,
        JSON.stringify(updated)
      );
    } catch (error) {
      console.warn("Unable to cache match state locally:", error);
    }

    saveMatchEverywhere(updated, matchId);
    if (extra.firstInningsData || extra.status === "finished") {
      flushMatchData(updated, { full: true }).catch((error) => {
        console.error("Unable to flush match data:", error);
      });
    }
    setMatch(updated);
    return updated;
  };

  /* =========================================================
     OPENERS
  ========================================================= */

  const startInnings = () => {
    setShowOpenerModal(true);
  };

  const confirmOpeners = () => {
    if (!strikerId) {
      alert("Select the striker.");
      return;
    }

    if (
      battingMode === 2 &&
      !nonStrikerId
    ) {
      alert(
        "Select a non-striker or choose 1 Batter mode."
      );
      return;
    }

    if (
      battingMode === 2 &&
      strikerId === nonStrikerId
    ) {
      alert(
        "Striker and non-striker must be different."
      );
      return;
    }

    if (!currentBowlerId) {
      alert("Select the opening bowler.");
      return;
    }

    const newBatting = {};

    battingTeam.players.forEach(
      (player, index) => {
        newBatting[
          PLAYER_ID(player)
        ] = makeBatter(
          player,
          index + 1
        );
      }
    );

    if (strikerId) {
      newBatting[strikerId].status =
        "not out";
    }

    if (
      battingMode === 2 &&
      nonStrikerId
    ) {
      newBatting[
        nonStrikerId
      ].status = "not out";
    }

    const newBowling = {};

    bowlingTeam.players.forEach(
      (player) => {
        newBowling[
          PLAYER_ID(player)
        ] = makeBowler(player);
      }
    );

    setBattingStats(newBatting);
    setBowlingStats(newBowling);

    setShowOpenerModal(false);
    setScreen("scoring");

    persistMatch({
      status: "live",
      inningsStartedAt:
        new Date().toISOString(),
    });
  };

  /* =========================================================
     AVAILABLE BATTERS
  ========================================================= */

  const availableBatters =
    battingTeam?.players.filter(
      (player) => {
        const stats =
          battingStats[
            PLAYER_ID(player)
          ];

        return (
          stats &&
          stats.status === "yet"
        );
      }
    ) || [];

  /* =========================================================
     NEW BATSMAN
  ========================================================= */

  const selectNewBatsman = (player) => {
    if (
      !player ||
      !pendingReplacement
    ) {
      return;
    }

    const id = PLAYER_ID(player);

    const nextStats = {
      ...battingStats,
      [id]: {
        ...battingStats[id],
        status: "not out",
      },
    };

    setBattingStats(nextStats);

    if (battingMode === 1 || pendingReplacement.slot === "striker") {
      setStrikerId(id);
    }

    if (battingMode === 1) {
      setNonStrikerId("");
    } else if (pendingReplacement.slot === "nonStriker") {
      setNonStrikerId(id);
    }

    const overEnded =
      pendingReplacement.overEnded;

    setPendingReplacement(null);
    setShowBatterModal(false);

    /*
     * If wicket was on ball 6,
     * the over-end reversal happens
     * AFTER the new batter enters.
     */

    if (
      overEnded &&
      battingMode === 2
    ) {
      setTimeout(() => {
        setStrikerId((currentStriker) => {
          setNonStrikerId(
            currentStriker
          );

          return nonStrikerId;
        });
      }, 0);

      setCurrentBowlerId("");
      setScreen("scoring");
      return;
    }

    setScreen("scoring");
  };

  /* =========================================================
     BOWLER
  ========================================================= */

  const bowlerHasBowledPreviousOver =
    (id) => {
      if (!completedOvers.length) {
        return false;
      }

      const last =
        completedOvers[
          completedOvers.length - 1
        ];

      return (
        String(last.bowlerId) ===
        String(id)
      );
    };

  const bowlerHasBowledCurrentOver =
    (id) => {
      return currentOverBalls.some(
        (ball) =>
          String(ball.bowlerId) ===
          String(id)
      );
    };

  const canSelectBowler = (player) => {
    const id = PLAYER_ID(player);

    /*
     * BOTH player cannot bowl while
     * currently batting.
     */

    if (
      id === String(strikerId) ||
      id === String(nonStrikerId)
    ) {
      return false;
    }

    /*
     * Replacement cannot be same bowler.
     */

    if (
      id === String(currentBowlerId)
    ) {
      return false;
    }

    /*
     * Cannot bowl previous over.
     */

    if (
      bowlerHasBowledPreviousOver(id)
    ) {
      return false;
    }

    /*
     * Cannot already have bowled
     * part of current over.
     */

    if (
      bowlerHasBowledCurrentOver(id)
    ) {
      return false;
    }

    return true;
  };

  const selectBowler = (id) => {
    if (!id) return;

    setCurrentBowlerId(
      String(id)
    );

    setShowBowlerModal(false);
  };

  /* =========================================================
     STRIKE
  ========================================================= */

  const swapStrike = () => {
    if (
      battingMode !== 2 ||
      !nonStrikerId
    ) {
      return;
    }

    const old = strikerId;

    setStrikerId(nonStrikerId);
    setNonStrikerId(old);
  };

  const applyOddRunStrike = (runs) => {
    if (
      battingMode !== 2 ||
      !nonStrikerId
    ) {
      return;
    }

    if (
      Number(runs) % 2 === 1
    ) {
      swapStrike();
    }
  };

  /* =========================================================
     HISTORY SNAPSHOT
  ========================================================= */

  const makeSnapshot = () => ({
    inningsRuns,
    inningsWickets,
    legalBalls,
    currentOver,
    strikerId,
    nonStrikerId,
    currentBowlerId,
    battingMode,
    currentOverBalls:
      clone(currentOverBalls),
    deliveries:
      clone(deliveries),
    battingStats:
      clone(battingStats),
    bowlingStats:
      clone(bowlingStats),
    extras:
      clone(extras),
    fallOfWickets:
      clone(fallOfWickets),
    completedOvers:
      clone(completedOvers),
    freeHit,
  });

  const pushHistory = () => {
    setHistory((prev) => [
      ...prev,
      makeSnapshot(),
    ]);
  };

  /* =========================================================
     RESTORE SNAPSHOT
  ========================================================= */

  const restoreSnapshot = (snapshot) => {
    setInningsRuns(
      snapshot.inningsRuns
    );

    setInningsWickets(
      snapshot.inningsWickets
    );

    setLegalBalls(
      snapshot.legalBalls
    );

    setCurrentOver(
      snapshot.currentOver
    );

    setStrikerId(
      snapshot.strikerId
    );

    setNonStrikerId(
      snapshot.nonStrikerId
    );

    setCurrentBowlerId(
      snapshot.currentBowlerId
    );

    setBattingMode(
      snapshot.battingMode
    );

    setCurrentOverBalls(
      snapshot.currentOverBalls
    );

    setDeliveries(
      snapshot.deliveries
    );

    setBattingStats(
      snapshot.battingStats
    );

    setBowlingStats(
      snapshot.bowlingStats
    );

    setExtras(
      snapshot.extras
    );

    setFallOfWickets(
      snapshot.fallOfWickets
    );

    setCompletedOvers(
      snapshot.completedOvers
    );

    setFreeHit(
      snapshot.freeHit
    );

    setPendingReplacement(null);
    setExtraPanel(null);
    setShowWicketModal(false);
    setShowBatterModal(false);
  };

  /* =========================================================
     UNDO BALL
  ========================================================= */

  const undoBall = () => {
    if (!history.length) {
      return;
    }

    const previous =
      history[history.length - 1];

    restoreSnapshot(previous);

    setHistory((prev) =>
      prev.slice(0, -1)
    );
  };

  /* =========================================================
     UNDO OVER
  ========================================================= */

  const undoOver = () => {
    if (!history.length) {
      return;
    }

    /*
     * Find snapshots belonging to
     * the current over.
     */

    const currentOverNumber =
      currentOver;

    let targetIndex = -1;

    for (
      let i = history.length - 1;
      i >= 0;
      i--
    ) {
      if (
        history[i].currentOver ===
        currentOverNumber
      ) {
        targetIndex = i;
      }
    }

    /*
     * If current over is empty,
     * undo previous completed over.
     */

    if (targetIndex === -1) {
      const previousOver =
        currentOver - 1;

      for (
        let i = history.length - 1;
        i >= 0;
        i--
      ) {
        if (
          history[i].currentOver ===
          previousOver
        ) {
          targetIndex = i;
        }
      }
    }

    if (targetIndex === -1) {
      alert(
        "No over available to undo."
      );
      return;
    }

    restoreSnapshot(
      history[targetIndex]
    );

    setHistory((prev) =>
      prev.slice(0, targetIndex)
    );
  };



  /* =========================================================
     FINISH MATCH
  ========================================================= */

  const finishMatch = (
    winner,
    text,
    finalValues = {},
    finalInningsData = null
  ) => {
    const scoreA = Number(
      finalValues.scoreA ??
        (battingTeam?.id === "A"
          ? inningsRuns
          : Number(match?.scoreA || 0))
    );
    const scoreB = Number(
      finalValues.scoreB ??
        (battingTeam?.id === "B"
          ? inningsRuns
          : Number(match?.scoreB || 0))
    );
    const wicketsA = Number(
      finalValues.wicketsA ??
        (battingTeam?.id === "A"
          ? inningsWickets
          : Number(match?.wicketsA || 0))
    );
    const wicketsB = Number(
      finalValues.wicketsB ??
        (battingTeam?.id === "B"
          ? inningsWickets
          : Number(match?.wicketsB || 0))
    );

    const finalResult = {
      winner,
      text,
      teamA: teams?.A?.name,
      teamB: teams?.B?.name,
      scoreA,
      scoreB,
      wicketsA,
      wicketsB,
    };

    const secondInningsData = finalInningsData || {
      teamId: battingTeam?.id,
      teamName: battingTeam?.name,
      runs: inningsRuns,
      wickets: inningsWickets,
      balls: legalBalls,
      battingStats,
      bowlingStats,
      extras,
      deliveries,
      fallOfWickets,
      completedOvers,
    };

    setResult(finalResult);

    const finalRosters = rosters
      ? {
          A: UNIQUE_PLAYERS(rosters.A || []),
          B: UNIQUE_PLAYERS(rosters.B || []),
        }
      : null;

    const updatedMatch = persistMatch({
      status: "finished",
      result: finalResult,
      winner,
      resultText: text,
      scoreA,
      scoreB,
      wicketsA,
      wicketsB,
      secondInningsData,
      ...(finalRosters
        ? {
            teamAPlayers: finalRosters.A,
            teamBPlayers: finalRosters.B,
            finalRosters,
            startingRosters: baseRosters,
          }
        : {}),
      finishedAt:
        new Date().toISOString(),
    });

    /*
     * Team composition changes made during the match are
     * written back to the database once the result is declared.
     */
    if (finalRosters && baseRosters) {
      syncTeamCompositionToDatabase({
        match: updatedMatch || match,
        matchId,
        baseRosters,
        finalRosters,
      }).catch((error) => {
        console.error("Unable to sync teams:", error);
      });
    }

    setScreen("finished");
  };

  /* =========================================================
     FINISH INNINGS
  ========================================================= */

  const finishCurrentInnings = (
    finalRuns = inningsRuns,
    finalWickets = inningsWickets,
    finalBalls = legalBalls,
    finalInningsData = null
  ) => {
    if (inningsIndex === 0) {
      const inningsData = finalInningsData || {
        teamId: battingTeam.id,
        teamName: battingTeam.name,
        runs: finalRuns,
        wickets: finalWickets,
        balls: finalBalls,
        battingStats,
        bowlingStats,
        extras,
        deliveries,
        fallOfWickets,
        completedOvers,
      };

      /*
       * Save first innings.
       */

      persistMatch({
        firstInningsScore:
          finalRuns,
        firstInningsTeam:
          battingTeam.name,
        firstInningsTeamId:
          battingTeam.id,
        scoreA:
          battingTeam.id === "A"
            ? finalRuns
            : match.scoreA || 0,
        scoreB:
          battingTeam.id === "B"
            ? finalRuns
            : match.scoreB || 0,
        wicketsA:
          battingTeam.id === "A"
            ? finalWickets
            : match.wicketsA || 0,
        wicketsB:
          battingTeam.id === "B"
            ? finalWickets
            : match.wicketsB || 0,
        firstInningsData: {
          ...inningsData,
        },
      });

      /*
       * SECOND INNINGS
       */

      setInningsIndex(1);

      setInningsRuns(0);
      setInningsWickets(0);
      setLegalBalls(0);
      setCurrentOver(0);

      setStrikerId("");
      setNonStrikerId("");
      setCurrentBowlerId("");

      setBattingStats({});
      setBowlingStats({});

      setCurrentOverBalls([]);
      setDeliveries([]);

      setExtras(
        emptyExtras()
      );

      setFallOfWickets([]);
      setCompletedOvers([]);

      setFreeHit(false);

      setHistory([]);

      setPendingReplacement(null);
      setShowBatterModal(false);

      setScreen("opening");

      return;
    }

    /*
     * SECOND INNINGS COMPLETE
     */

    const firstScore =
      Number(
        match.firstInningsScore || 0
      );

    if (finalRuns > firstScore) {
      const remaining = wicketsInHand(
        battingTeam?.players?.length,
        finalWickets
      );

      finishMatch(
        battingTeam.name,
        `${battingTeam.name} won by ${remaining} wicket${
          remaining === 1 ? "" : "s"
        }`,
        {
          scoreA: battingTeam.id === "A" ? finalRuns : match.scoreA || 0,
          scoreB: battingTeam.id === "B" ? finalRuns : match.scoreB || 0,
          wicketsA: battingTeam.id === "A" ? finalWickets : match.wicketsA || 0,
          wicketsB: battingTeam.id === "B" ? finalWickets : match.wicketsB || 0,
        }
      );
      return;
    }

    if (finalRuns === firstScore) {
      finishMatch(
        null,
        "Match drawn",
        {
          scoreA: battingTeam.id === "A" ? finalRuns : match.scoreA || 0,
          scoreB: battingTeam.id === "B" ? finalRuns : match.scoreB || 0,
          wicketsA: battingTeam.id === "A" ? finalWickets : match.wicketsA || 0,
          wicketsB: battingTeam.id === "B" ? finalWickets : match.wicketsB || 0,
        }
      );
      return;
    }

    const firstTeam =
      match.firstInningsTeam ||
      teams[firstBattingTeamId]
        .name;

    finishMatch(
      firstTeam,
      `${firstTeam} won by ${
        firstScore - finalRuns
      } run${
        firstScore - finalRuns === 1 ? "" : "s"
      }`,
      {
        scoreA: battingTeam.id === "A" ? finalRuns : match.scoreA || 0,
        scoreB: battingTeam.id === "B" ? finalRuns : match.scoreB || 0,
        wicketsA: battingTeam.id === "A" ? finalWickets : match.wicketsA || 0,
        wicketsB: battingTeam.id === "B" ? finalWickets : match.wicketsB || 0,
      }
    );
  };

  /* =========================================================
     CHECK INNINGS
  ========================================================= */

  const checkInningsEnd = (
    runs,
    wickets,
    balls,
    finalInningsData = null
  ) => {
    /*
     * Chase completed.
     */

    if (inningsIndex === 1) {
      const target =
        Number(
          match.firstInningsScore || 0
        );

      const totalBatters =
        battingTeam?.players?.length || 0;
      const wicketsExhausted =
        totalBatters > 0 &&
        wickets >= totalBatters;
      const oversExhausted =
        balls >= Number(match.overs || 3) * 6;

      if (runs > target) {
        const wicketsRemaining =
          wicketsInHand(
            battingTeam?.players?.length,
            wickets
          );

        finishMatch(
          battingTeam.name,
          `${battingTeam.name} won by ${wicketsRemaining} wicket${
            wicketsRemaining === 1 ? "" : "s"
          }`,
          {
            scoreA: battingTeam.id === "A" ? runs : match.scoreA || 0,
            scoreB: battingTeam.id === "B" ? runs : match.scoreB || 0,
            wicketsA: battingTeam.id === "A" ? wickets : match.wicketsA || 0,
            wicketsB: battingTeam.id === "B" ? wickets : match.wicketsB || 0,
          },
          finalInningsData
        );

        return true;
      }

      if (runs === target && (wicketsExhausted || oversExhausted)) {
        finishMatch(
          null,
          "Match drawn",
          {
            scoreA: battingTeam.id === "A" ? runs : match.scoreA || 0,
            scoreB: battingTeam.id === "B" ? runs : match.scoreB || 0,
            wicketsA: battingTeam.id === "A" ? wickets : match.wicketsA || 0,
            wicketsB: battingTeam.id === "B" ? wickets : match.wicketsB || 0,
          },
          finalInningsData
        );

        return true;
      }
    }

    /*
     * CUSTOM LOCAL-CRICKET RULE:
     * A team may continue with ONE batsman.
     * Therefore the innings ends only when
     * every available batsman has been dismissed.
     *
     * Example:
     * 2 players -> wicket 1 = single-batsman mode
     *               wicket 2 = innings over
     *
     * 3 players -> wicket 1 = 2 batsmen remain
     *               wicket 2 = single-batsman mode
     *               wicket 3 = innings over
     */

    const totalBatters =
      battingTeam?.players?.length || 0;

    if (
      totalBatters > 0 &&
      wickets >= totalBatters
    ) {
      finishCurrentInnings(runs, wickets, balls, finalInningsData);
      return true;
    }

    /*
     * SQUAD CHANGE RULE:
     * If players have left the batting side, the innings ends
     * as soon as nobody is left who can bat, even when the
     * wicket count is lower than the original squad size.
     */

    const statsForCheck =
      finalInningsData?.battingStats || battingStats;

    const rosterForCheck =
      finalInningsData?.battingPlayers ||
      battingTeam?.players ||
      [];

    const availableCount = rosterForCheck.filter(
      (player) =>
        (statsForCheck[PLAYER_ID(player)]?.status || "yet") !==
        "out"
    ).length;

    if (
      rosterForCheck.length >= 0 &&
      availableCount === 0
    ) {
      finishCurrentInnings(runs, wickets, balls, finalInningsData);
      return true;
    }

    /*
     * Overs completed.
     */

    if (
      balls >=
      Number(match.overs || 3) * 6
    ) {
      finishCurrentInnings(runs, wickets, balls, finalInningsData);
      return true;
    }

    return false;
  };

  const getRemainingBatters = (stats, dismissedId = "") => {
    const seen = new Set();
    return (battingTeam?.players || []).filter((player) => {
      const id = String(PLAYER_ID(player));
      if (!id || seen.has(id) || id === String(dismissedId)) {
        return false;
      }
      seen.add(id);
      return stats[id]?.status !== "out";
    });
  };

  useEffect(() => {
    if (pendingReplacement && availableBatters.length === 0) {
      setPendingReplacement(null);
      setShowBatterModal(false);
    }
  }, [pendingReplacement, availableBatters.length]);

  /* =========================================================
     SQUAD MANAGEMENT
     Add / remove / transfer a player while the match is live.
     Past statistics are never modified, only the future
     batting and bowling options change.
  ========================================================= */

  const openSquadManager = async () => {
    setShowSquadModal(true);
    setSquadTeamTab(battingTeam?.id || "A");

    if (poolLoaded) return;

    try {
      const pool = await loadPlayerPool();
      setPlayerPool(UNIQUE_PLAYERS(pool));
    } catch (error) {
      console.warn("Unable to load player pool:", error);
      setPlayerPool([]);
    } finally {
      setPoolLoaded(true);
    }
  };

  const rememberInHistory = (teamId, player) => {
    setRosterHistory((prev) => {
      const base = prev || { A: [], B: [] };

      return {
        ...base,
        [teamId]: MERGE_PLAYER_LIST(base[teamId] || [], [player]),
      };
    });
  };

  /*
   * Everything that has to follow a squad change:
   * stats bootstrap, active slots, single-batsman mode
   * and automatic innings end.
   */
  const reconcileAfterSquadChange = (nextRosters) => {
    setRosters(nextRosters);

    if (screen !== "scoring") {
      return;
    }

    const battingId = battingTeam?.id;
    if (!battingId) return;

    const bowlingId = battingId === "A" ? "B" : "A";

    const battingPlayers = nextRosters[battingId] || [];
    const bowlingPlayers = nextRosters[bowlingId] || [];

    /* Stats for new players, existing stats never touched. */
    const nextBatting = clone(battingStats);
    let order = Object.keys(nextBatting).length;

    battingPlayers.forEach((player) => {
      const id = PLAYER_ID(player);
      if (!nextBatting[id]) {
        order += 1;
        nextBatting[id] = makeBatter(player, order);
      }
    });

    const nextBowling = clone(bowlingStats);

    bowlingPlayers.forEach((player) => {
      const id = PLAYER_ID(player);
      if (!nextBowling[id]) {
        nextBowling[id] = makeBowler(player);
      }
    });

    const battingIds = new Set(ROSTER_IDS(battingPlayers));
    const bowlingIds = new Set(ROSTER_IDS(bowlingPlayers));

    const strikerStillIn =
      strikerId && battingIds.has(String(strikerId));

    const nonStrikerStillIn =
      nonStrikerId && battingIds.has(String(nonStrikerId));

    const bowlerStillIn =
      currentBowlerId && bowlingIds.has(String(currentBowlerId));

    if (!strikerStillIn) setStrikerId("");
    if (!nonStrikerStillIn) setNonStrikerId("");
    if (!bowlerStillIn) setCurrentBowlerId("");

    const remaining = battingPlayers.filter(
      (player) =>
        (nextBatting[PLAYER_ID(player)]?.status || "yet") !== "out"
    );

    setBattingStats(nextBatting);
    setBowlingStats(nextBowling);

    /* Nobody can bat any more -> innings ends automatically. */
    if (remaining.length === 0) {
      setPendingReplacement(null);
      setShowBatterModal(false);

      checkInningsEnd(
        inningsRuns,
        inningsWickets,
        legalBalls,
        {
          teamId: battingTeam.id,
          teamName: battingTeam.name,
          runs: inningsRuns,
          wickets: inningsWickets,
          balls: legalBalls,
          battingStats: nextBatting,
          bowlingStats: nextBowling,
          battingPlayers,
          extras,
          deliveries,
          fallOfWickets,
          completedOvers,
        }
      );

      return;
    }

    /* Exactly one batsman left -> single-batsman mode. */
    if (remaining.length === 1) {
      const lastId = PLAYER_ID(remaining[0]);

      nextBatting[lastId] = {
        ...nextBatting[lastId],
        status: "not out",
      };

      setBattingStats(nextBatting);
      setBattingMode(1);
      setStrikerId(lastId);
      setNonStrikerId("");
      setPendingReplacement(null);
      setShowBatterModal(false);
      return;
    }

    /* Two or more remain -> refill the empty slot if needed. */
    const freeBatters = battingPlayers.filter(
      (player) =>
        (nextBatting[PLAYER_ID(player)]?.status || "yet") === "yet"
    );

    if (!strikerStillIn && freeBatters.length) {
      setPendingReplacement({ slot: "striker", overEnded: false });
      return;
    }

    if (
      battingMode === 2 &&
      !nonStrikerStillIn &&
      freeBatters.length
    ) {
      setPendingReplacement({ slot: "nonStriker", overEnded: false });
    }
  };

  const addPlayerToTeam = (player, teamId) => {
    if (!player || !rosters) return;

    const id = PLAYER_ID(player);
    if (!id) return;

    const alreadyIn =
      ROSTER_IDS(rosters.A).includes(id) ||
      ROSTER_IDS(rosters.B).includes(id);

    if (alreadyIn) {
      alert("This player is already playing this match.");
      return;
    }

    const nextRosters = {
      ...rosters,
      [teamId]: [...(rosters[teamId] || []), player],
    };

    rememberInHistory(teamId, player);
    reconcileAfterSquadChange(nextRosters);
  };

  const removePlayerFromTeam = (playerId, teamId) => {
    if (!rosters) return;

    const confirmed = window.confirm(
      "Remove this player from the match? Past statistics stay in the scorecard."
    );

    if (!confirmed) return;

    const nextRosters = {
      ...rosters,
      [teamId]: (rosters[teamId] || []).filter(
        (player) => String(PLAYER_ID(player)) !== String(playerId)
      ),
    };

    reconcileAfterSquadChange(nextRosters);
  };

  const movePlayerToOtherTeam = (playerId, fromTeamId) => {
    if (!rosters) return;

    const toTeamId = fromTeamId === "A" ? "B" : "A";

    const player = (rosters[fromTeamId] || []).find(
      (item) => String(PLAYER_ID(item)) === String(playerId)
    );

    if (!player) return;

    const confirmed = window.confirm(
      "Move this player to the other team? Past statistics stay unchanged."
    );

    if (!confirmed) return;

    const nextRosters = {
      ...rosters,
      [fromTeamId]: (rosters[fromTeamId] || []).filter(
        (item) => String(PLAYER_ID(item)) !== String(playerId)
      ),
      [toTeamId]: [...(rosters[toTeamId] || []), player],
    };

    rememberInHistory(toTeamId, player);
    reconcileAfterSquadChange(nextRosters);
  };

  const addBrandNewPlayer = (teamId) => {
    const name = newPlayerName.trim();

    if (!name) {
      alert("Enter the player name.");
      return;
    }

    const player = {
      id: `player_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      name,
      careerRuns: Number(newPlayerRuns || 0) || 0,
      careerWickets: Number(newPlayerWickets || 0) || 0,
    };

    addPlayerToTeam(player, teamId);

    setNewPlayerName("");
    setNewPlayerRuns("");
    setNewPlayerWickets("");
  };

  const handleEndInnings = () => {
  // Prevent ending an already finished match
  if (screen === "finished") {
    return;
  }

  // Confirm before ending innings
  const confirmed = window.confirm(
    `Are you sure you want to end ${inningsIndex === 0 ? "the first" : "the second"} innings?`
  );

  if (!confirmed) {
    return;
  }

  // Finish the current innings using the existing logic
  finishCurrentInnings();
};
  /* =========================================================
     COMPLETE OVER
  ========================================================= */

  const completeOver = (
    bowlerId,
    completedBalls = currentOverBalls
  ) => {
    const overBalls = completedBalls;

    const bowlerRuns =
      overBalls.reduce(
        (sum, ball) =>
          sum +
          Number(
            ball.bowlerRuns || 0
          ),
        0
      );

    const validCount =
      overBalls.filter(
        (ball) =>
          ball.validBall
      ).length;

    /*
     * A maiden is only awarded
     * when the bowler completed all
     * six legal balls of that over
     * and conceded zero bowler runs.
     */

    const maiden =
      validCount === 6 &&
      bowlerRuns === 0 &&
      overBalls.every(
        (ball) =>
          String(ball.bowlerId) ===
          String(bowlerId)
      );

    setCompletedOvers(
      (prev) => [
        ...prev,
        {
          over: currentOver + 1,
          bowlerId,
          maiden,
        },
      ]
    );

    /*
     * An odd run on the last legal ball already changes strike.
     * Only an even last legal ball needs the over-end swap.
     */

    if (
      battingMode === 2 &&
      strikerId &&
      nonStrikerId
    ) {
      const lastValid =
        [...overBalls]
          .reverse()
          .find(
            (ball) =>
              ball.validBall
          );

      /*
       * If last ball was odd,
       * delivery already swapped.
       * The following swap returns
       * the original striker.
       */

      if (lastValid) {
        const lastRuns =
          Number(
            lastValid.runs || 0
          );

        const lastStrikerId = lastValid.strikerId || strikerId;
        const lastNonStrikerId = lastValid.nonStrikerId || nonStrikerId;

        if (lastRuns % 2 === 1) {
          // Odd bat runs and odd byes both leave the same batsman on strike
          // for the next over.
          setStrikerId(lastStrikerId);
          setNonStrikerId(lastNonStrikerId);
        } else {
          setStrikerId(lastNonStrikerId);
          setNonStrikerId(lastStrikerId);
        }
      } else {
        swapStrike();
      }
    }

    setCurrentOver(
      (prev) => prev + 1
    );

    setCurrentOverBalls([]);

    setCurrentBowlerId("");
  };

  /* =========================================================
     NORMAL RUN
  ========================================================= */

  const recordNormalRun = (
    runs
  ) => {
    if (
      !striker ||
      !currentBowler
    ) {
      alert(
        "Select striker and bowler first."
      );
      return;
    }

    pushHistory();

    const run =
      Number(runs);

    const strikerKey =
      PLAYER_ID(striker);

    const bowlerKey =
      PLAYER_ID(currentBowler);

    const newBatting =
      clone(battingStats);

    const batter =
      newBatting[strikerKey];

    batter.status =
      "not out";

    batter.runs += run;
    batter.balls += 1;

    if (run === 4) {
      batter.fours += 1;
    }

    if (run === 6) {
      batter.sixes += 1;
    }

    const newBowling =
      clone(bowlingStats);

    newBowling[
      bowlerKey
    ].legalBalls += 1;

    newBowling[
      bowlerKey
    ].runs += run;

    const newRuns =
      inningsRuns + run;

    const newBalls =
      legalBalls + 1;

    const ball = {
      id:
        `ball_${Date.now()}_${Math.random()}`,

      innings:
        inningsIndex + 1,

      over: currentOver + 1,

      ball:
        (legalBalls % 6) + 1,

      type: "RUN",

      runs: run,

      batterRuns: run,

      bowlerRuns: run,

      extras: 0,

      validBall: true,

      strikerId:
        strikerKey,

      strikerName:
        PLAYER_NAME(striker),

      nonStrikerId:
        nonStrikerId || null,

      bowlerId:
        bowlerKey,

      bowlerName:
        PLAYER_NAME(
          currentBowler
        ),

      wicket: null,
    };

    setBattingStats(
      newBatting
    );

    setBowlingStats(
      newBowling
    );

    setInningsRuns(
      newRuns
    );

    setLegalBalls(
      newBalls
    );

    setDeliveries(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    setCurrentOverBalls(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    applyOddRunStrike(run);

    /*
     * Any valid ball after NB
     * consumes free hit.
     */

    setFreeHit(false);

    const inningsEnded =
      checkInningsEnd(
        newRuns,
        inningsWickets,
        newBalls,
        {
          teamId: battingTeam.id,
          teamName: battingTeam.name,
          runs: newRuns,
          wickets: inningsWickets,
          balls: newBalls,
          battingStats: newBatting,
          bowlingStats: newBowling,
          extras,
          deliveries: [...deliveries, ball],
          fallOfWickets,
          completedOvers,
        }
      );

    if (inningsEnded) {
      return;
    }

    if (
      newBalls % 6 === 0
    ) {
      completeOver(bowlerKey, [...currentOverBalls, ball]);
    }
  };

  /* =========================================================
     DEAD BALL
  ========================================================= */

  const recordDeadBall = () => {
    if (!currentBowler) {
      alert(
        "Select a bowler first."
      );
      return;
    }

    pushHistory();

    const ball = {
      id:
        `dead_${Date.now()}`,

      innings:
        inningsIndex + 1,

      over:
        currentOver + 1,

      ball:
        currentOverBalls.length + 1,

      type: "DEAD",

      runs: 0,

      batterRuns: 0,

      bowlerRuns: 0,

      extras: 0,

      validBall: false,

      strikerId:
        striker
          ? PLAYER_ID(striker)
          : null,

      strikerName:
        striker
          ? PLAYER_NAME(striker)
          : null,

      bowlerId:
        PLAYER_ID(
          currentBowler
        ),

      bowlerName:
        PLAYER_NAME(
          currentBowler
        ),

      wicket: null,
    };

    setDeliveries(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    setCurrentOverBalls(
      (prev) => [
        ...prev,
        ball,
      ]
    );
  };

  /* =========================================================
     NO BALL
========================================================= */

  const recordNoBall = (mode, runs, wicket = null) => {
    if (!striker || !currentBowler) {
      alert("Select striker and bowler first.");
      return false;
    }

    if (wicket && !["Run out", "Boundary Wicket"].includes(wicket.type)) {
      alert("On a No Ball, only Run out or Boundary Wicket is allowed.");
      return false;
    }
    if (wicket?.type === "Run out" && !wicket.fielderId) {
      alert("Select the fielder for Run out.");
      return false;
    }
    if (wicket?.type === "Boundary Wicket" && String(wicket.batterId) !== String(strikerId)) {
      alert("Boundary Wicket on a No Ball can only dismiss the striker.");
      return false;
    }
    if (wicket?.type === "Run out") {
      const activeBatters = [strikerId, nonStrikerId].filter(Boolean).map(String);
      if (!activeBatters.includes(String(wicket.batterId))) {
        alert("Run out can only dismiss the striker or non-striker.");
        return false;
      }
    }

    pushHistory();
    const extra = Number(runs);

    // Boundary Wicket is a wicket-only event on a No Ball:
    // NB penalty = 1, batsman runs = 0, bye = 0.
    const isBoundaryWicket =
      wicket?.type === "Boundary Wicket";

    if (isBoundaryWicket && mode === "BYE") {
      alert("Bye cannot be selected with Boundary Wicket.");
      return false;
    }

    const batRuns = isBoundaryWicket
      ? 0
      : mode === "BAT"
      ? extra
      : 0;

    const byeRuns = isBoundaryWicket
      ? 0
      : mode === "BYE"
      ? extra
      : 0;

    const total = 1 + batRuns + byeRuns;
    const strikerBefore = strikerId;
    const nonStrikerBefore = nonStrikerId;
    const dismissedId = wicket?.batterId ? String(wicket.batterId) : null;
    const strikerKey = PLAYER_ID(striker);
    const bowlerKey = PLAYER_ID(currentBowler);

    const newBatting = clone(battingStats);
    if (newBatting[strikerKey]) {
      newBatting[strikerKey].runs += batRuns;

      // A batsman-facing No Ball counts as a ball faced.
      // A No Ball taken as BYE does not.
      if (mode === "BAT" && !isBoundaryWicket) {
        newBatting[strikerKey].balls += 1;
      }

      if (batRuns === 4) newBatting[strikerKey].fours += 1;
      if (batRuns === 6) newBatting[strikerKey].sixes += 1;
    }

    const newBowling = clone(bowlingStats);
    if (newBowling[bowlerKey]) {
      // Bowler gets NB penalty + batsman runs.
      // Bye runs on a No Ball are NOT charged to the bowler.
      newBowling[bowlerKey].runs += 1 + batRuns;
    }

    const newExtras = clone(extras);
    newExtras.nb += 1;
    newExtras.bye += byeRuns;

    const newRuns = inningsRuns + total;
    const newWickets = wicket ? inningsWickets + 1 : inningsWickets;

    const dismissedPlayer = dismissedId
      ? battingTeam?.players?.find(p => String(PLAYER_ID(p)) === dismissedId)
      : null;
    const fielder = wicket?.fielderId
      ? bowlingTeam?.players?.find(p => String(PLAYER_ID(p)) === String(wicket.fielderId))
      : null;

    if (wicket && dismissedId && newBatting[dismissedId]) {
      newBatting[dismissedId] = {
        ...newBatting[dismissedId],
        status: "out",
        dismissal: wicket.type,
        fielder: fielder ? PLAYER_NAME(fielder) : null,
        bowler: PLAYER_NAME(currentBowler),
      };
    }

    /* Boundary Wicket is credited to the bowler; Run out is not. */
    if (
      wicket?.type !== "Run out" &&
      wicket?.type === "Boundary Wicket" &&
      newBowling[bowlerKey]
    ) {
      newBowling[bowlerKey].wickets += 1;
    }

    const ball = {
      id: `nb_${Date.now()}_${Math.random()}`,
      innings: inningsIndex + 1,
      over: currentOver + 1,
      ball: currentOverBalls.length + 1,
      type: "NB",
      runs: total,
      batterRuns: batRuns,
      bowlerRuns: 1 + batRuns,
      extras: total - batRuns,
      noBallRuns: 1,
      byeRuns,
      validBall: false,
      strikerId: strikerBefore,
      strikerName: PLAYER_NAME(striker),
      nonStrikerId: nonStrikerBefore || null,
      bowlerId: bowlerKey,
      bowlerName: PLAYER_NAME(currentBowler),
      wicket: wicket ? {
        type: wicket.type,
        batterId: dismissedId,
        batterName: dismissedPlayer ? PLAYER_NAME(dismissedPlayer) : "",
        fielder: fielder ? PLAYER_NAME(fielder) : null,
        bowler: PLAYER_NAME(currentBowler),
        runs: batRuns,
      } : null,
      freeHit: true,
    };

    setBattingStats(newBatting);
    setBowlingStats(newBowling);
    setExtras(newExtras);
    setInningsRuns(newRuns);
    setInningsWickets(newWickets);
    setDeliveries(prev => [...prev, ball]);
    setCurrentOverBalls(prev => [...prev, ball]);

    const chaseEnded = checkInningsEnd(
      newRuns,
      newWickets,
      legalBalls,
      {
        teamId: battingTeam.id,
        teamName: battingTeam.name,
        runs: newRuns,
        wickets: newWickets,
        balls: legalBalls,
        battingStats: newBatting,
        bowlingStats: newBowling,
        extras: newExtras,
        deliveries: [...deliveries, ball],
        fallOfWickets,
        completedOvers,
      }
    );

    if (chaseEnded) {
      return true;
    }

    /* NB penalty is not a completed run for strike purposes. */
    applyOddRunStrike(extra);

    if (wicket && dismissedId) {
      const wasStriker = String(dismissedId) === String(strikerBefore);
      const wasNonStriker = String(dismissedId) === String(nonStrikerBefore);
      const remaining = getRemainingBatters(newBatting, dismissedId);

      /* Remove the dismissed batter from the active slot. */
      if (wasStriker) setStrikerId("");
      if (wasNonStriker) setNonStrikerId("");

      if (remaining.length === 1) {
        const lastId = PLAYER_ID(remaining[0]);
        newBatting[lastId] = { ...newBatting[lastId], status: "not out" };
        setBattingStats(newBatting);
        setBattingMode(1);
        setStrikerId(lastId);
        setNonStrikerId("");
        setPendingReplacement(null);
      } else if (remaining.length > 1) {
        setBattingMode(battingMode);
        setPendingReplacement({
          slot: battingMode === 1 || wasStriker ? "striker" : "nonStriker",
          overEnded: false,
        });
      } else {
        setPendingReplacement(null);
      }

      setFallOfWickets(prev => [...prev, {
        wicket: newWickets,
        score: newRuns,
        batter: dismissedPlayer ? PLAYER_NAME(dismissedPlayer) : "",
        over: formatOvers(legalBalls),
      }]);
    }

    /* NB is not legal; the next legal delivery remains free hit. */
    setFreeHit(true);
    return true;
  };

  /* =========================================================
     WIDE
  ========================================================= */

  const recordWide = (keeperRuns, wicket = null) => {
    if (!currentBowler) {
      alert("Select a bowler first.");
      return false;
    }
    if (wicket && wicket.type !== "Stumped") {
      alert("On a Wide, only Stumped is allowed.");
      return false;
    }
    if (wicket && !wicket.batterId) {
      alert("Select the batter for Stumping.");
      return false;
    }
    if (wicket && !wicket.fielderId) {
      alert("Select the wicketkeeper/fielder for Stumping.");
      return false;
    }

    pushHistory();
    const extra = Number(keeperRuns);
    const total = 1 + extra;
    const bowlerKey = PLAYER_ID(currentBowler);
    const strikerBefore = strikerId;
    const nonStrikerBefore = nonStrikerId;
    const dismissedId = wicket?.batterId ? String(wicket.batterId) : null;
    const newBowling = clone(bowlingStats);
    const newBatting = clone(battingStats);

    if (newBowling[bowlerKey]) {
      newBowling[bowlerKey].runs += total;
      if (wicket?.type === "Stumped") newBowling[bowlerKey].wickets += 1;
    }

    const dismissedPlayer = dismissedId
      ? battingTeam?.players?.find(p => String(PLAYER_ID(p)) === dismissedId)
      : null;
    const fielder = wicket?.fielderId
      ? bowlingTeam?.players?.find(p => String(PLAYER_ID(p)) === String(wicket.fielderId))
      : null;

    if (wicket && dismissedId && newBatting[dismissedId]) {
      newBatting[dismissedId] = {
        ...newBatting[dismissedId],
        status: "out",
        dismissal: "Stumped",
        fielder: fielder ? PLAYER_NAME(fielder) : null,
        bowler: PLAYER_NAME(currentBowler),
      };
    }

    const newExtras = clone(extras);
    newExtras.wd += total;
    const newRuns = inningsRuns + total;
    const newWickets = wicket ? inningsWickets + 1 : inningsWickets;

    const ball = {
      id: `wd_${Date.now()}_${Math.random()}`,
      innings: inningsIndex + 1,
      over: currentOver + 1,
      ball: currentOverBalls.length + 1,
      type: "WD",
      runs: total,
      batterRuns: 0,
      bowlerRuns: total,
      extras: total,
      wideRuns: total,
      keeperExtraRuns: extra,
      validBall: false,
      strikerId: strikerBefore || null,
      strikerName: striker ? PLAYER_NAME(striker) : null,
      nonStrikerId: nonStrikerBefore || null,
      bowlerId: bowlerKey,
      bowlerName: PLAYER_NAME(currentBowler),
      wicket: wicket ? {
        type: "Stumped",
        batterId: dismissedId,
        batterName: dismissedPlayer ? PLAYER_NAME(dismissedPlayer) : "",
        fielder: fielder ? PLAYER_NAME(fielder) : null,
        bowler: PLAYER_NAME(currentBowler),
        runs: 0,
      } : null,
    };

    setBattingStats(newBatting);
    setBowlingStats(newBowling);
    setExtras(newExtras);
    setInningsRuns(newRuns);
    setInningsWickets(newWickets);
    setDeliveries(prev => [...prev, ball]);
    setCurrentOverBalls(prev => [...prev, ball]);

    const chaseEnded = checkInningsEnd(
      newRuns,
      newWickets,
      legalBalls,
      {
        teamId: battingTeam.id,
        teamName: battingTeam.name,
        runs: newRuns,
        wickets: newWickets,
        balls: legalBalls,
        battingStats: newBatting,
        bowlingStats: newBowling,
        extras: newExtras,
        deliveries: [...deliveries, ball],
        fallOfWickets,
        completedOvers,
      }
    );

    if (chaseEnded) {
      return true;
    }

    /* Only completed wide runs can change strike. */
    applyOddRunStrike(extra);

    if (wicket && dismissedId) {
      const wasStriker = String(dismissedId) === String(strikerBefore);
      const wasNonStriker = String(dismissedId) === String(nonStrikerBefore);
      const remaining = getRemainingBatters(newBatting, dismissedId);

      if (wasStriker) setStrikerId("");
      if (wasNonStriker) setNonStrikerId("");

      if (remaining.length === 1) {
        const lastId = PLAYER_ID(remaining[0]);
        newBatting[lastId] = { ...newBatting[lastId], status: "not out" };
        setBattingStats(newBatting);
        setBattingMode(1);
        setStrikerId(lastId);
        setNonStrikerId("");
        setPendingReplacement(null);
      } else if (remaining.length > 1) {
        setBattingMode(battingMode);
        setPendingReplacement({
          slot: battingMode === 1 || wasStriker ? "striker" : "nonStriker",
          overEnded: false,
        });
      } else {
        setPendingReplacement(null);
      }

      setFallOfWickets(prev => [...prev, {
        wicket: newWickets,
        score: newRuns,
        batter: dismissedPlayer ? PLAYER_NAME(dismissedPlayer) : "",
        over: formatOvers(legalBalls),
      }]);
    }

    /* Wide is not legal, so it does not consume free hit. */
    return true;
  };

  /* =========================================================
     BYE
  ========================================================= */

  const recordBye = (
    runs
  ) => {
    if (
      !striker ||
      !currentBowler
    ) {
      alert(
        "Select striker and bowler first."
      );
      return;
    }

    pushHistory();

    const bye =
      Number(runs);

    if (pendingReplacement) {
      return;
    }

    const bowlerKey =
      PLAYER_ID(currentBowler);

    const strikerKey =
      PLAYER_ID(striker);

    const newBowling =
      clone(bowlingStats);

    newBowling[
      bowlerKey
    ].legalBalls += 1;

    const newExtras =
      clone(extras);

    newExtras.bye += bye;

    const newRuns =
      inningsRuns + bye;

    const newBalls =
      legalBalls + 1;

    const ball = {
      id:
        `bye_${Date.now()}_${Math.random()}`,

      innings:
        inningsIndex + 1,

      over:
        currentOver + 1,

      ball:
        (legalBalls % 6) + 1,

      type: "BYE",

      runs: bye,

      batterRuns: 0,

      bowlerRuns: 0,

      extras: bye,

      byeRuns: bye,

      validBall: true,

      strikerId:
        strikerKey,

      strikerName:
        PLAYER_NAME(striker),

      bowlerId:
        bowlerKey,

      bowlerName:
        PLAYER_NAME(
          currentBowler
        ),

      wicket: null,
    };

    setBowlingStats(
      newBowling
    );

    setExtras(
      newExtras
    );

    setInningsRuns(
      newRuns
    );

    setLegalBalls(
      newBalls
    );

    setDeliveries(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    setCurrentOverBalls(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    applyOddRunStrike(
      bye
    );

    setFreeHit(false);

    const ended =
      checkInningsEnd(
        newRuns,
        inningsWickets,
        newBalls,
        {
          teamId: battingTeam.id,
          teamName: battingTeam.name,
          runs: newRuns,
          wickets: inningsWickets,
          balls: newBalls,
          battingStats,
          bowlingStats: newBowling,
          extras: newExtras,
          deliveries: [...deliveries, ball],
          fallOfWickets,
          completedOvers,
        }
      );

    if (ended) return;

    if (
      newBalls % 6 === 0
    ) {
      completeOver(bowlerKey, [...currentOverBalls, ball]);
    }
  };

  /* =========================================================
     LEG BYE
  ========================================================= */

  const recordLegBye = (
    runs
  ) => {
    if (
      !striker ||
      !currentBowler
    ) {
      alert(
        "Select striker and bowler first."
      );
      return;
    }

    pushHistory();

    const lb =
      Number(runs);

    if (pendingReplacement) {
      return;
    }

    const bowlerKey =
      PLAYER_ID(currentBowler);

    const strikerKey =
      PLAYER_ID(striker);

    const newBowling =
      clone(bowlingStats);

    newBowling[
      bowlerKey
    ].legalBalls += 1;

    const newExtras =
      clone(extras);

    newExtras.lb += lb;

    const newRuns =
      inningsRuns + lb;

    const newBalls =
      legalBalls + 1;

    const ball = {
      id:
        `lb_${Date.now()}_${Math.random()}`,

      innings:
        inningsIndex + 1,

      over:
        currentOver + 1,

      ball:
        (legalBalls % 6) + 1,

      type: "LB",

      runs: lb,

      batterRuns: 0,

      bowlerRuns: 0,

      extras: lb,

      legByeRuns: lb,

      validBall: true,

      strikerId:
        strikerKey,

      strikerName:
        PLAYER_NAME(striker),

      bowlerId:
        bowlerKey,

      bowlerName:
        PLAYER_NAME(
          currentBowler
        ),

      wicket: null,
    };

    setBowlingStats(
      newBowling
    );

    setExtras(
      newExtras
    );

    setInningsRuns(
      newRuns
    );

    setLegalBalls(
      newBalls
    );

    setDeliveries(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    setCurrentOverBalls(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    applyOddRunStrike(
      lb
    );

    setFreeHit(false);

    const ended =
      checkInningsEnd(
        newRuns,
        inningsWickets,
        newBalls,
        {
          teamId: battingTeam.id,
          teamName: battingTeam.name,
          runs: newRuns,
          wickets: inningsWickets,
          balls: newBalls,
          battingStats,
          bowlingStats,
          extras: newExtras,
          deliveries: [...deliveries, ball],
          fallOfWickets,
          completedOvers,
        }
      );

    if (ended) return;

    if (
      newBalls % 6 === 0
    ) {
      completeOver(bowlerKey, [...currentOverBalls, ball]);
    }
  };

  /* =========================================================
     WICKET OPEN
  ========================================================= */

  const openWicket = () => {
    if (
      !striker ||
      !currentBowler
    ) {
      alert(
        "Select striker and bowler first."
      );
      return;
    }

    setWicketBatterId(
      PLAYER_ID(striker)
    );

    /*
     * Free hit allows only:
     * Run Out
     * Boundary Wicket
     */

    setWicketType(
      freeHit
        ? "Run out"
        : "Bowled"
    );

    setWicketFielderId("");
    setWicketRuns(0);
    setRunOutDismissedPosition("striker");
    setRunOutOtherPosition("nonStriker");

    setShowWicketModal(true);
  };

  /* =========================================================
     VALID WICKET TYPES
  ========================================================= */

  const wicketTypes = [
    "Bowled",
    "Caught",
    "Caught & Bowled",
    "Run out",
    "Stumped",
    "LBW",
    "Hit Wicket",
    "Hit the Ball Twice",
    "Obstructing the Field",
    "Timed out",
    "Boundary Wicket",
    "Retired out",
  ];

  const legalFreeHitWickets = [
    "Run out",
    "Boundary Wicket",
  ];

  /* =========================================================
     WICKET SAVE
  ========================================================= */

  const saveWicket = () => {
    if (!wicketBatterId) {
      alert(
        "Select the batter."
      );
      return;
    }

    if (wicketType === "Boundary Wicket" && String(wicketBatterId) !== String(strikerId)) {
      alert("Boundary Wicket can only dismiss the striker.");
      return;
    }

    if (wicketType === "Run out") {
      const activeBatters = [strikerId, nonStrikerId].filter(Boolean).map(String);
      if (!activeBatters.includes(String(wicketBatterId))) {
        alert("Run out can only dismiss the striker or non-striker.");
        return;
      }
    }

    /*
     * Free-hit restriction.
     */

    if (
      freeHit &&
      !legalFreeHitWickets.includes(
        wicketType
      )
    ) {
      alert(
        "During free hit, only Run Out or Boundary Out is allowed."
      );
      return;
    }

    /*
     * Fielder required.
     */

    if (
      [
        "Caught",
        "Run out",
        "Stumped",
        "Obstructing the Field",
      ].includes(wicketType) &&
      !wicketFielderId
    ) {
      alert(
        "Select the fielder."
      );
      return;
    }


    /*
     * Run out completed runs.
     */

    if (
      wicketType ===
        "Run out" &&
      Number(wicketRuns) < 0
    ) {
      return;
    }

    if (
      wicketType === "Run out" &&
      battingMode === 2
    ) {
      const validPositions =
        ["striker", "nonStriker"].includes(
          runOutDismissedPosition
        ) &&
        ["striker", "nonStriker"].includes(
          runOutOtherPosition
        ) &&
        runOutDismissedPosition !== runOutOtherPosition;

      if (!validPositions) {
        alert(
          "Select the final position of both batters."
        );
        return;
      }
    }

    pushHistory();

    const dismissedPlayer =
      battingTeam.players.find(
        (player) =>
          PLAYER_ID(player) ===
          String(
            wicketBatterId
          )
      );

    if (!dismissedPlayer) {
      return;
    }

    const dismissedId =
      PLAYER_ID(
        dismissedPlayer
      );

    const strikerBefore =
      strikerId;

    const nonStrikerBefore =
      nonStrikerId;

    /*
     * Determine where dismissed
     * batter is standing.
     */

    const dismissedSlot =
      dismissedId ===
      String(strikerBefore)
        ? "striker"
        : "nonStriker";

    const otherBatterId =
      dismissedSlot === "striker"
        ? nonStrikerBefore
        : strikerBefore;

    const finalRunOutStrikerId =
      wicketType === "Run out" &&
      battingMode === 2
        ? runOutDismissedPosition === "striker"
          ? dismissedId
          : otherBatterId
        : strikerBefore;

    const finalRunOutNonStrikerId =
      wicketType === "Run out" &&
      battingMode === 2
        ? runOutDismissedPosition === "nonStriker"
          ? dismissedId
          : otherBatterId
        : nonStrikerBefore;

    const dismissedFinalSlot =
      wicketType === "Run out" &&
      battingMode === 2
        ? runOutDismissedPosition
        : dismissedSlot;

    const run =
      Number(wicketRuns || 0);

    let ballRuns = 0;
    let batterRuns = 0;
    let bowlerRuns = 0;

    /*
     * Boundary Wicket = wicket only.
     * It scores 0 runs and dismisses only the selected batter.
     */

    if (
      wicketType ===
      "Boundary Wicket"
    ) {
      ballRuns = 0;
      batterRuns = 0;
      bowlerRuns = 0;
    }

    /*
     * Run Out
     */

    if (
      wicketType ===
      "Run out"
    ) {
      ballRuns = run;

      /*
       * For this local scorer,
       * completed runs are assigned
       * to the striker.
       */

      batterRuns = run;
      bowlerRuns = 0;
    }

    /*
     * Normal wicket = 0 runs.
     */

    const validBall = true;

    const newRuns =
      inningsRuns +
      ballRuns;

    const newBalls =
      legalBalls + 1;

    const newWickets =
      inningsWickets + 1;

    const newBatting =
      clone(battingStats);

    newBatting[
      dismissedId
    ] = {
      ...newBatting[
        dismissedId
      ],

      status: "out",

      dismissal:
        wicketType,

      fielder:
        wicketFielderId
          ? PLAYER_NAME(
              bowlingTeam.players.find(
                (player) =>
                  PLAYER_ID(player) ===
                  String(
                    wicketFielderId
                  )
              )
            )
          : null,

      bowler:
        PLAYER_NAME(
          currentBowler
        ),
    };

    /*
     * Add completed boundary/run
     * to striker.
     */

    if (
      batterRuns > 0 &&
      strikerId &&
      newBatting[strikerId]
    ) {
      newBatting[
        strikerId
      ].runs +=
        batterRuns;

      if (batterRuns === 4) {
        newBatting[
          strikerId
        ].fours += 1;
      }

      if (batterRuns === 6) {
        newBatting[
          strikerId
        ].sixes += 1;
      }
    }

    /*
     * Valid ball = one ball faced.
     */

    if (
      strikerId &&
      newBatting[strikerId]
    ) {
      newBatting[
        strikerId
      ].balls += 1;
    }

    const bowlerKey =
      PLAYER_ID(
        currentBowler
      );

    const newBowling =
      clone(bowlingStats);

    newBowling[
      bowlerKey
    ].legalBalls += 1;

    newBowling[
      bowlerKey
    ].runs += bowlerRuns;

    // Run Out is never a bowler wicket.
    // Boundary Wicket and normal bowler dismissals are credited.
    if (
      wicketType !== "Run out" &&
      isBowlerWicket(wicketType)
    ) {
      newBowling[bowlerKey].wickets += 1;
    }

    const fielder =
      wicketFielderId
        ? bowlingTeam.players.find(
            (player) =>
              PLAYER_ID(player) ===
              String(
                wicketFielderId
              )
          )
        : null;

    const wicketInfo = {
      type: wicketType,

      batterId:
        dismissedId,

      batterName:
        PLAYER_NAME(
          dismissedPlayer
        ),

      fielder:
        fielder
          ? PLAYER_NAME(
              fielder
            )
          : null,

      bowler:
        PLAYER_NAME(
          currentBowler
        ),

      runs: ballRuns,

      ...(wicketType === "Run out" &&
      battingMode === 2
        ? {
            finalPosition: runOutDismissedPosition,
            otherBatterFinalPosition:
              runOutOtherPosition,
            finalStrikerId:
              finalRunOutStrikerId || null,
            finalNonStrikerId:
              finalRunOutNonStrikerId || null,
          }
        : {}),
    };

    const ball = {
      id:
        `wicket_${Date.now()}_${Math.random()}`,

      innings:
        inningsIndex + 1,

      over:
        currentOver + 1,

      ball:
        (legalBalls % 6) + 1,

      type: "WICKET",

      runs: ballRuns,

      batterRuns,

      bowlerRuns,

      extras: 0,

      validBall,

      strikerId:
        strikerBefore,

      strikerName:
        striker
          ? PLAYER_NAME(striker)
          : "",

      nonStrikerId:
        nonStrikerBefore ||
        null,

      bowlerId:
        bowlerKey,

      bowlerName:
        PLAYER_NAME(
          currentBowler
        ),

      wicket:
        wicketInfo,
    };

    const newFow = [
      ...fallOfWickets,

      {
        wicket:
          newWickets,

        score:
          newRuns,

        batter:
          PLAYER_NAME(
            dismissedPlayer
          ),

        over:
          formatOvers(
            newBalls
          ),
      },
    ];

    setBattingStats(
      newBatting
    );

    setBowlingStats(
      newBowling
    );

    setInningsRuns(
      newRuns
    );

    setLegalBalls(
      newBalls
    );

    setInningsWickets(
      newWickets
    );

    setFallOfWickets(
      newFow
    );

    setDeliveries(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    setCurrentOverBalls(
      (prev) => [
        ...prev,
        ball,
      ]
    );

    setShowWicketModal(false);

    /*
     * For two-batter Run Out, the final positions selected
     * above are authoritative. Do not auto-swap on odd runs.
     */
    if (
      wicketType === "Run out" &&
      battingMode === 2
    ) {
      setStrikerId(
        finalRunOutStrikerId === dismissedId
          ? ""
          : finalRunOutStrikerId || ""
      );

      setNonStrikerId(
        finalRunOutNonStrikerId === dismissedId
          ? ""
          : finalRunOutNonStrikerId || ""
      );
    } else {
      /*
       * Existing strike movement for completed
       * runs before wicket.
       */
      if (
        wicketType ===
          "Run out" &&
        run % 2 === 1
      ) {
        if (
          battingMode === 2
        ) {
          const temp =
            strikerId;

          setStrikerId(
            nonStrikerId
          );

          setNonStrikerId(
            temp
          );
        }
      }

      /*
       * Existing removal of dismissed player.
       */
      if (
        dismissedSlot ===
        "striker"
      ) {
        setStrikerId("");
      } else {
        setNonStrikerId("");
      }
    }

    /*
     * Free hit ends after a valid
     * delivery.
     */

    setFreeHit(false);

    /*
     * Check innings end.
     */

    const ended =
      checkInningsEnd(
        newRuns,
        newWickets,
        newBalls,
        {
          teamId: battingTeam.id,
          teamName: battingTeam.name,
          runs: newRuns,
          wickets: newWickets,
          balls: newBalls,
          battingStats: newBatting,
          bowlingStats: newBowling,
          extras,
          deliveries: [...deliveries, ball],
          fallOfWickets: newFow,
          completedOvers,
        }
      );

    if (ended) {
      return;
    }

    /*
     * If this was ball 6,
     * mark over ended.
     */

    const overEnded =
      newBalls % 6 === 0;

    /*
     * =====================================================
     * FIND REMAINING BATSMEN
     * =====================================================
     */

    const remainingBatsmen =
      getRemainingBatters(newBatting, dismissedId);

    /*
     * =====================================================
     * SINGLE-BATSMAN MODE
     * =====================================================
     *
     * When exactly one batsman remains,
     * do NOT open the replacement menu.
     * Put that batsman directly on strike.
     */

    if (remainingBatsmen.length === 1) {
      const lastBatsman =
        remainingBatsmen[0];

      const lastBatsmanId =
        PLAYER_ID(lastBatsman);

      /*
       * The last batsman is now active.
       */
      newBatting[lastBatsmanId] = {
        ...newBatting[lastBatsmanId],
        status: "not out",
      };

      setBattingStats(newBatting);

      setBattingMode(1);

      setStrikerId(lastBatsmanId);

      setNonStrikerId("");

      /*
       * CRITICAL:
       * Never show the new-batsman menu.
       */
      setPendingReplacement(null);

      /*
       * If ball 6 completed the over,
       * ask for the next bowler.
       */
      if (overEnded) {
        setCurrentBowlerId("");
      }

      setScreen("scoring");

      return;
    }

    /*
     * =====================================================
     * NO BATSMAN REMAINS
     * =====================================================
     */

    if (remainingBatsmen.length === 0) {
      setBattingMode(1);

      setStrikerId("");

      setNonStrikerId("");

      setPendingReplacement(null);

      setScreen("scoring");

      return;
    }

    /*
     * =====================================================
     * TWO OR MORE BATSMEN REMAIN
     * =====================================================
     *
     * Only in this case should the
     * replacement-batsman menu appear.
     */

    setBattingMode(battingMode);

    setPendingReplacement({
      slot:
        battingMode === 1
          ? "striker"
          : dismissedFinalSlot,
      overEnded,
    });

    /*
     * If over ended, next bowler
     * appears after replacement.
     */
    if (overEnded) {
      setCurrentBowlerId("");
    }

    setScreen("scoring");
  };

  /* =========================================================
     HANDLE SPECIAL WICKET FROM NB
  ========================================================= */

  const handleWicketAfterDelivery = (
    wicket,
    validBall
  ) => {
    /*
     * Kept as a separate hook point
     * for future special NB wicket
     * handling.
     */

    if (!wicket) return;

    /*
     * The NB delivery itself has
     * already been recorded.
     *
     * We only mark the selected
     * batter as dismissed here.
     */

    const dismissedId =
      wicket.batterId;

    if (!dismissedId) return;

    const newStats =
      clone(battingStats);

    if (
      newStats[dismissedId]
    ) {
      newStats[
        dismissedId
      ].status = "out";

      newStats[
        dismissedId
      ].dismissal =
        wicket.type;

      newStats[
        dismissedId
      ].fielder =
        wicket.fielder ||
        null;

      newStats[
        dismissedId
      ].bowler =
        PLAYER_NAME(
          currentBowler
        );
    }

    setBattingStats(
      newStats
    );

    const slot =
      dismissedId ===
      String(strikerId)
        ? "striker"
        : "nonStriker";

    if (
      slot === "striker"
    ) {
      setStrikerId("");
    } else {
      setNonStrikerId("");
    }

    /*
     * A no-ball is not a legal ball, so the
     * over does not end here.
     */

    const remainingBatsmen =
      getRemainingBatters(newStats, dismissedId);

    /*
     * If exactly one batsman remains,
     * continue directly in single-batsman mode.
     */
    if (remainingBatsmen.length === 1) {
      const lastBatsman =
        remainingBatsmen[0];

      const lastBatsmanId =
        PLAYER_ID(lastBatsman);

      newStats[lastBatsmanId] = {
        ...newStats[lastBatsmanId],
        status: "not out",
      };

      setBattingStats(newStats);
      setBattingMode(1);
      setStrikerId(lastBatsmanId);
      setNonStrikerId("");
      setPendingReplacement(null);
      setScreen("scoring");
      return;
    }

    /*
     * No batsman remains.
     */
    if (remainingBatsmen.length === 0) {
      setBattingMode(1);
      setStrikerId("");
      setNonStrikerId("");
      setPendingReplacement(null);
      setScreen("scoring");
      return;
    }

    /*
     * Two or more batsmen remain, so
     * show the replacement menu.
     */
    setBattingMode(battingMode);
    setPendingReplacement({
      slot: battingMode === 1 ? "striker" : slot,
      overEnded: false,
    });
  };

  /* =========================================================
     RETIRED HURT
  ========================================================= */

  const retireHurt = () => {
    if (!striker) return;

    pushHistory();

    const id =
      PLAYER_ID(striker);

    const next =
      clone(battingStats);

    next[id].status =
      "retired hurt";

    next[id].dismissal =
      "Retired hurt";

    setBattingStats(next);

    setStrikerId("");

    setPendingReplacement({
      slot: "striker",
      overEnded: false,
    });

    setShowWicketModal(false);
  };

  /* =========================================================
     AI SUGGESTION STATE
  ========================================================= */

  const [batterSuggestionIndex, setBatterSuggestionIndex] =
    useState(0);

  const [bowlerSuggestionIndex, setBowlerSuggestionIndex] =
    useState(0);

  const [batterSuggestionMessage, setBatterSuggestionMessage] =
    useState("");

  const [bowlerSuggestionMessage, setBowlerSuggestionMessage] =
    useState("");


  /* =========================================================
     AI BATTER CANDIDATES
  ========================================================= */

  const batterSuggestionCandidates = useMemo(() => {
    if (!availableBatters.length) {
      return [];
    }

    /*
     * availableBatters already contains only players
     * whose battingStats status is "yet".
     *
     * Therefore:
     * - Out players are excluded
     * - Current batsmen are excluded
     *
     * We still explicitly protect the current striker
     * and non-striker here so that the AI can NEVER
     * suggest a player who is currently batting.
     */

    const currentBatterIds = new Set(
      [
        strikerId,
        nonStrikerId,
      ]
        .filter(Boolean)
        .map((id) => String(id))
    );

    const candidates =
      availableBatters.filter((player) => {
        const id = PLAYER_ID(player);

        return !currentBatterIds.has(
          String(id)
        );
      });


    /*
     * BATSMAN STRENGTH
     *
     * Priority:
     * 1. Highest total runs
     * 2. Highest strike rate
     */

    const getBattingRuns = (player) => {
      const stats =
        battingStats[
          PLAYER_ID(player)
        ] || {};

      return Number(
        stats.runs || 0
      );
    };


    const getBattingStrikeRate = (player) => {
      const stats =
        battingStats[
          PLAYER_ID(player)
        ] || {};

      const runs =
        Number(stats.runs || 0);

      const balls =
        Number(stats.balls || 0);

      if (!balls) {
        return 0;
      }

      return (
        (runs / balls) *
        100
      );
    };


    return [...candidates].sort(
      (a, b) => {
        const aRuns =
          getBattingRuns(a);

        const bRuns =
          getBattingRuns(b);


        /*
         * First priority:
         * Highest runs
         */

        if (bRuns !== aRuns) {
          return bRuns - aRuns;
        }


        /*
         * Second priority:
         * Highest strike rate
         */

        const aStrikeRate =
          getBattingStrikeRate(a);

        const bStrikeRate =
          getBattingStrikeRate(b);

        return (
          bStrikeRate -
          aStrikeRate
        );
      }
    );
  }, [
    availableBatters,
    battingStats,
    strikerId,
    nonStrikerId,
  ]);


  /* =========================================================
     NEXT BATSMAN SUGGESTION
  ========================================================= */

  const nextBatterSuggestion =
    useMemo(() => {
      if (
        !batterSuggestionCandidates.length
      ) {
        return "-";
      }

      if (
        batterSuggestionIndex >=
        batterSuggestionCandidates.length
      ) {
        return "-";
      }

      return PLAYER_NAME(
        batterSuggestionCandidates[
          batterSuggestionIndex
        ]
      );
    }, [
      batterSuggestionCandidates,
      batterSuggestionIndex,
    ]);


  /* =========================================================
     SUGGEST ANOTHER BATSMAN
  ========================================================= */

  const suggestAnotherBatter = () => {
    if (
      !batterSuggestionCandidates.length
    ) {
      setBatterSuggestionMessage(
        "No batsman left"
      );

      return;
    }

    const nextIndex =
      batterSuggestionIndex + 1;


    /*
     * No more batsmen after the
     * current suggestion.
     */

    if (
      nextIndex >=
      batterSuggestionCandidates.length
    ) {
      setBatterSuggestionIndex(
        nextIndex
      );

      setBatterSuggestionMessage(
        "No batsman left"
      );

      return;
    }


    setBatterSuggestionIndex(
      nextIndex
    );

    setBatterSuggestionMessage("");
  };


  /* =========================================================
     RESET BATTER SUGGESTION
  ========================================================= */

  useEffect(() => {
    /*
     * Reset only when the actual batting
     * situation changes.
     *
     * We deliberately DO NOT use battingStats
     * here because battingStats changes after
     * every ball and would reset "Suggest Another".
     */

    setBatterSuggestionIndex(0);
    setBatterSuggestionMessage("");
  }, [
    strikerId,
    nonStrikerId,
  ]);


  /* =========================================================
     AI BOWLER CANDIDATES
  ========================================================= */

  const bowlerSuggestionCandidates =
    useMemo(() => {
      if (
        !bowlingTeam ||
        !bowlingTeam.players ||
        !bowlingTeam.players.length
      ) {
        return [];
      }


      /*
       * IMPORTANT:
       *
       * Keep the existing canSelectBowler()
       * logic.
       *
       * This already handles:
       * - current batsmen
       * - current bowler
       * - previous-over bowler
       * - other existing bowling restrictions
       */

      const candidates =
        bowlingTeam.players.filter(
          (player) =>
            canSelectBowler(player)
        );


      /*
       * BOWLER STRENGTH
       *
       * Priority:
       * 1. Highest wickets
       * 2. Lowest economy
       */

      const getBowlerWickets =
        (player) => {
          const stats =
            bowlingStats[
              PLAYER_ID(player)
            ] || {};

          return Number(
            stats.wickets || 0
          );
        };


      const getBowlerEconomy =
        (player) => {
          const stats =
            bowlingStats[
              PLAYER_ID(player)
            ] || {};

          const runs =
            Number(
              stats.runs || 0
            );

          const balls =
            Number(
              stats.legalBalls || 0
            );


          /*
           * A bowler who has not bowled
           * any legal ball does not get an
           * artificial economy of 0.
           *
           * Otherwise an unused bowler would
           * incorrectly become the "best"
           * bowler because 0 economy looks
           * better than every real economy.
           */

          if (!balls) {
            return Number.POSITIVE_INFINITY;
          }

          return (
            (runs / balls) *
            6
          );
        };


      return [...candidates].sort(
        (a, b) => {
          const aWickets =
            getBowlerWickets(a);

          const bWickets =
            getBowlerWickets(b);


          /*
           * First priority:
           * Highest wickets
           */

          if (
            bWickets !==
            aWickets
          ) {
            return (
              bWickets -
              aWickets
            );
          }


          /*
           * Second priority:
           * Lowest economy
           */

          const aEconomy =
            getBowlerEconomy(a);

          const bEconomy =
            getBowlerEconomy(b);

          return (
            aEconomy -
            bEconomy
          );
        }
      );
    }, [
      bowlingTeam,
      bowlingStats,
      strikerId,
      nonStrikerId,
      completedOvers,
    ]);


  /* =========================================================
     NEXT BOWLER SUGGESTION
  ========================================================= */

  const nextBowlerSuggestion =
    useMemo(() => {
      if (
        !bowlerSuggestionCandidates.length
      ) {
        return "-";
      }

      if (
        bowlerSuggestionIndex >=
        bowlerSuggestionCandidates.length
      ) {
        return "-";
      }

      return PLAYER_NAME(
        bowlerSuggestionCandidates[
          bowlerSuggestionIndex
        ]
      );
    }, [
      bowlerSuggestionCandidates,
      bowlerSuggestionIndex,
    ]);


  /* =========================================================
     SUGGEST ANOTHER BOWLER
  ========================================================= */

  const suggestAnotherBowler = () => {
    if (
      !bowlerSuggestionCandidates.length
    ) {
      setBowlerSuggestionMessage(
        "No bowler left"
      );

      return;
    }

    const nextIndex =
      bowlerSuggestionIndex + 1;


    /*
     * No more eligible bowlers.
     */

    if (
      nextIndex >=
      bowlerSuggestionCandidates.length
    ) {
      setBowlerSuggestionIndex(
        nextIndex
      );

      setBowlerSuggestionMessage(
        "No bowler left"
      );

      return;
    }


    setBowlerSuggestionIndex(
      nextIndex
    );

    setBowlerSuggestionMessage("");
  };


  /* =========================================================
     RESET BOWLER SUGGESTION
  ========================================================= */

  useEffect(() => {
    /*
     * A new over means a new bowler
     * suggestion cycle.
     *
     * We use completedOvers instead of
     * bowlingStats because bowlingStats
     * changes after every delivery.
     */

    setBowlerSuggestionIndex(0);
    setBowlerSuggestionMessage("");
  }, [
    completedOvers,
  ]);
  /* =========================================================
     AUTO SAVE CURRENT SCORE + RESUME STATE
  ========================================================= */

  useEffect(() => {
    if (
      !match ||
      match.status === "finished" ||
      (match.createdBy && String(match.createdBy) !== String(getCurrentUserId()))
    ) return;

    const scoreA =
      battingTeam?.id === "A"
        ? inningsRuns
        : match.scoreA || 0;

    const scoreB =
      battingTeam?.id === "B"
        ? inningsRuns
        : match.scoreB || 0;

    const wicketsA =
      battingTeam?.id === "A"
        ? inningsWickets
        : match.wicketsA || 0;

    const wicketsB =
      battingTeam?.id === "B"
        ? inningsWickets
        : match.wicketsB || 0;

    const scoringState = {
      inningsIndex,
      inningsRuns,
      inningsWickets,
      legalBalls,
      currentOver,
      strikerId,
      nonStrikerId,
      battingMode,
      currentBowlerId,
      currentOverBalls,
      deliveries,
      battingStats,
      bowlingStats,
      extras,
      fallOfWickets,
      completedOvers,
      freeHit,
      history,
      pendingReplacement,
      result,
      scorecardTab,
      rosters,
      rosterHistory,
      baseRosters,
    };

    const updated = {
      ...match,
      scoreA,
      scoreB,
      wicketsA,
      wicketsB,
      deliveries,
      scoringState,
      ...(rosters
        ? {
            teamAPlayers: rosters.A,
            teamBPlayers: rosters.B,
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    try {
      sessionStorage.setItem(
        `cricket_pending_match_${matchId}`,
        JSON.stringify(updated)
      );
    } catch (error) {
      console.warn("Unable to cache pending match locally:", error);
    }

    if (
      legalBalls > 0 &&
      legalBalls % 6 === 0 &&
      lastFlushedBallRef.current !== legalBalls
    ) {
      lastFlushedBallRef.current = legalBalls;
      saveMatchEverywhere(updated, matchId);
      flushMatchData(updated).catch((error) => {
        console.error("Unable to flush completed over:", error);
      });
    }

    /* Save once more if the browser is being refreshed/closed. */
    return undefined;
  }, [
    match,
    matchId,
    battingTeam,
    inningsIndex,
    inningsRuns,
    inningsWickets,
    legalBalls,
    currentOver,
    strikerId,
    nonStrikerId,
    battingMode,
    currentBowlerId,
    currentOverBalls,
    deliveries,
    battingStats,
    bowlingStats,
    extras,
    fallOfWickets,
    completedOvers,
    freeHit,
    history,
    pendingReplacement,
    result,
    scorecardTab,
    rosters,
    rosterHistory,
    baseRosters,
  ]);

  /* =========================================================
     LOADING
  ========================================================= */

  if (!match || !teams) {
    return (
      <div className="scoring-page">
        <div className="loading-card">
          <div className="loading-ball">
            🏏
          </div>

          <h2>
            Loading match...
          </h2>
        </div>
      </div>
    );
  }

  const isMatchOwner =
    !match.createdBy || String(match.createdBy) === String(getCurrentUserId());

  if (!isMatchOwner) {
    const savedState = match.scoringState || {};
    const liveTeamId = savedState.inningsIndex === 1
      ? (match.battingTeamId === "A" ? "B" : "A")
      : match.battingTeamId || "A";
    const liveRuns = Number(savedState.inningsRuns ?? (liveTeamId === "A" ? match.scoreA : match.scoreB) ?? 0);
    const liveWickets = Number(savedState.inningsWickets ?? (liveTeamId === "A" ? match.wicketsA : match.wicketsB) ?? 0);

    return (
      <div className="scoring-page">
        <header className="score-header">
          <div>
            <span className="score-eyebrow">LIVE MATCH</span>
            <h1>{match.teamAName} vs {match.teamBName}</h1>
            <p>View-only live score</p>
          </div>
          <div className="live-badge"><span /> {match.status === "finished" ? "FINISHED" : "LIVE"}</div>
        </header>

        <section className="main-score-card">
          <div className="innings-team-name">{liveTeamId === "A" ? match.teamAName : match.teamBName}</div>
          <div className="big-score">{liveRuns}<span>/{liveWickets}</span></div>
          <div className="overs-text">{formatOvers(savedState.legalBalls || 0)} / {match.overs || 0} overs</div>
        </section>

        <ScoringWinPredictionCard
          live={match.status !== "finished" && match.status !== "completed"}
          prediction={calculateWinPrediction({
            match: predictionMatch || match,
            scoringState: savedState,
          })}
        />

        <section className="over-card">
          <div className="section-title"><span>LIVE DELIVERIES</span><small>{(savedState.deliveries || []).length} recorded</small></div>
          <div className="ball-grid bowling-timeline-grid">
            {(savedState.deliveries || []).slice(-12).map((ball, index) => (
              <div className="ball-slot ball-used" key={ball.id || index}>
                <strong>{getBallTimelineLabel(ball)}</strong>
              </div>
            ))}
          </div>
        </section>

        <button type="button" className="score-primary-button" onClick={() => navigate("/matches")}>← Back to Matches</button>
      </div>
    );
  }

  /* =========================================================
     FINISHED SCREEN
  ========================================================= */

/* =========================================================
   FINISHED SCREEN
========================================================= */

if (screen === "finished") {
  const fallbackScoreA = Number(match?.scoreA || 0);
  const fallbackScoreB = Number(match?.scoreB || 0);
  const fallbackWicketsA = Number(match?.wicketsA || 0);
  const fallbackWicketsB = Number(match?.wicketsB || 0);
  const fallbackFirstTeamId = match?.firstInningsTeamId === "B" ? "B" : "A";
  const fallbackChasingTeamId = fallbackFirstTeamId === "A" ? "B" : "A";
  const fallbackChasingScore = fallbackChasingTeamId === "A" ? fallbackScoreA : fallbackScoreB;
  const fallbackDefendingScore = fallbackFirstTeamId === "A" ? fallbackScoreA : fallbackScoreB;
  const fallbackChasingWickets = fallbackChasingTeamId === "A" ? fallbackWicketsA : fallbackWicketsB;
  const fallbackChasingTeam = teams?.[fallbackChasingTeamId];
  const winnerName =
    result?.winner ||
    (fallbackScoreA === fallbackScoreB
      ? ""
      : fallbackChasingScore > fallbackDefendingScore
        ? fallbackChasingTeam?.name
        : teams?.[fallbackFirstTeamId]?.name);

  const resultText =
    result?.text ||
    (fallbackScoreA === fallbackScoreB
      ? "Match drawn"
      : fallbackChasingScore > fallbackDefendingScore
        ? `${fallbackChasingTeam?.name} won by ${wicketsInHand(
            fallbackChasingTeam?.players?.length,
            fallbackChasingWickets
          )} wickets`
        : `${teams?.[fallbackFirstTeamId]?.name} won by ${fallbackDefendingScore - fallbackChasingScore} runs`);

  const scoreA = Number(
    result?.scoreA ?? match?.scoreA ?? 0
  );

  const scoreB = Number(
    result?.scoreB ?? match?.scoreB ?? 0
  );

  const wicketsA = Number(
    result?.wicketsA ?? match?.wicketsA ?? 0
  );

  const wicketsB = Number(
    result?.wicketsB ?? match?.wicketsB ?? 0
  );

  const isTie =
    result?.winner === null ||
    result?.winner === "Match tied" ||
    result?.winner === "Match drawn" ||
    resultText.toLowerCase().includes("tied") ||
    resultText.toLowerCase().includes("draw");

  return (
    <div className="scoring-page">
      <div className="finished-card">

        {/* RESULT ICON */}
        <div className="finished-icon">
          {isTie ? "🤝" : "🏆"}
        </div>

        {/* WINNER */}
        <h1 className="finished-winner">
          {isTie ? "Match Drawn" : winnerName}
        </h1>

        {/* WIN MARGIN */}
        <p className="finished-result-text">
          {resultText}
        </p>

        {/* SMALL SCORECARD */}
        <div className="finished-mini-scorecard">

          {/* TEAM A */}
          <div className="finished-team-score">
            <div className="finished-team-name">
              {teams?.A?.name || "Team A"}
            </div>

            <div className="finished-team-final-score">
              {scoreA}/{wicketsA}
            </div>

            <div className="finished-team-label">
              Final Score
            </div>
          </div>

          {/* VS */}
          <div className="finished-score-vs">
            VS
          </div>

          {/* TEAM B */}
          <div className="finished-team-score">
            <div className="finished-team-name">
              {teams?.B?.name || "Team B"}
            </div>

            <div className="finished-team-final-score">
              {scoreB}/{wicketsB}
            </div>

            <div className="finished-team-label">
              Final Score
            </div>
          </div>

        </div>

        {/* WINNING TEAM HIGHLIGHT */}
        {!isTie && (
          <div className="finished-winning-box">
            <span>🏆 Winner</span>

            <strong>
              {winnerName}
            </strong>

            <small>
              {resultText}
            </small>
          </div>
        )}
        {/* add the view scorecard button to view the full match scorecard here */}

        <button
          type="button"
          className="score-primary-button finished-back-button"
          onClick={() => navigate(`/matches/${matchId}/scorecard`)}
        >
          View Full Scorecard
        </button>
    
        {/* GO TO ALL MATCHES */}
        <button
          type="button"
          className="score-primary-button finished-back-button"
          onClick={() => navigate("/matches")}
        >
          ← Go to All Matches
        </button>
          </div>
    </div>
  );
}


  /* =========================================================
     SQUAD MODAL (shared by opening + scoring screens)
  ========================================================= */

  const squadTeam = teams[squadTeamTab];
  const squadOtherTeam = teams[squadTeamTab === "A" ? "B" : "A"];

  const poolForSquad = playerPool.filter((player) => {
    const id = String(PLAYER_ID(player));

    return (
      !ROSTER_IDS(rosters?.A || []).includes(id) &&
      !ROSTER_IDS(rosters?.B || []).includes(id)
    );
  });

  const squadModal = showSquadModal && (
    <div className="score-modal-backdrop">
      <div
        className="score-modal"
        style={{
          width: "100%",
          maxWidth: "560px",
          maxHeight: "90vh",
          overflowY: "auto",
          overflowX: "hidden",
          boxSizing: "border-box",
        }}
      >
        <div className="modal-header">
          <div>
            <span>SQUAD</span>
            <h2>Manage Players</h2>
          </div>

          <button
            className="close-button"
            onClick={() => setShowSquadModal(false)}
          >
            ×
          </button>
        </div>

        <div className="mode-selector">
          <button
            className={squadTeamTab === "A" ? "selected" : ""}
            onClick={() => setSquadTeamTab("A")}
          >
            {teams.A.name}
          </button>

          <button
            className={squadTeamTab === "B" ? "selected" : ""}
            onClick={() => setSquadTeamTab("B")}
          >
            {teams.B.name}
          </button>
        </div>

        {/* CURRENT SQUAD */}
        <div className="modal-section">
          <label>Playing now — {squadTeam?.name}</label>

          {squadTeam?.players?.length ? (
            squadTeam.players.map((player) => {
              const id = PLAYER_ID(player);

              return (
                <div
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "10px",
                    padding: "11px 13px",
                    marginBottom: "8px",
                    borderRadius: "12px",
                    border: "1px solid #d1d5db",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ fontWeight: 800 }}>
                    {PLAYER_NAME(player)}
                    <small
                      style={{
                        display: "block",
                        fontWeight: 700,
                        color: "#6b7280",
                      }}
                    >
                      {CAREER_RUNS(player, careerStats)} runs • {CAREER_WICKETS(player, careerStats)} wkts
                    </small>
                  </span>

                  <span style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={() =>
                        movePlayerToOtherTeam(id, squadTeamTab)
                      }
                      style={{
                        padding: "8px 11px",
                        borderRadius: "10px",
                        border: "1px solid #2563eb",
                        background: "#eff6ff",
                        color: "#1d4ed8",
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      → {squadOtherTeam?.name}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        removePlayerFromTeam(id, squadTeamTab)
                      }
                      style={{
                        padding: "8px 11px",
                        borderRadius: "10px",
                        border: "1px solid #ef4444",
                        background: "#fef2f2",
                        color: "#b91c1c",
                        fontWeight: 800,
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              );
            })
          ) : (
            <p className="empty-text">No players in this team</p>
          )}
        </div>

        {/* AVAILABLE PLAYERS */}
        <div className="modal-section">
          <label>Add a saved player to {squadTeam?.name}</label>

          {!poolLoaded ? (
            <p className="empty-text">Loading players...</p>
          ) : poolForSquad.length ? (
            poolForSquad.map((player) => {
              const id = PLAYER_ID(player);

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => addPlayerToTeam(player, squadTeamTab)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    minHeight: "56px",
                    padding: "12px 14px",
                    marginBottom: "9px",
                    borderRadius: "13px",
                    border: "1px solid #d1d5db",
                    background: "#ffffff",
                    color: "#111827",
                    textAlign: "left",
                    cursor: "pointer",
                    boxSizing: "border-box",
                    WebkitAppearance: "none",
                    appearance: "none",
                  }}
                >
                  <span style={{ fontWeight: 800 }}>
                    {PLAYER_NAME(player)}
                  </span>

                  <small style={{ fontWeight: 700, color: "#6b7280" }}>
                    {CAREER_RUNS(player, careerStats)} runs • {CAREER_WICKETS(player, careerStats)} wkts
                  </small>
                </button>
              );
            })
          ) : (
            <p className="empty-text">No other saved players</p>
          )}
        </div>

        {/* BRAND NEW PLAYER */}
        <div className="modal-section">
          <label>Add a new player</label>

          <input
            type="text"
            value={newPlayerName}
            placeholder="Player name"
            onChange={(e) => setNewPlayerName(e.target.value)}
            style={{
              width: "100%",
              padding: "11px 13px",
              marginBottom: "8px",
              borderRadius: "12px",
              border: "1px solid #d1d5db",
              boxSizing: "border-box",
            }}
          />

          <input
            type="number"
            value={newPlayerRuns}
            placeholder="Career runs"
            onChange={(e) => setNewPlayerRuns(e.target.value)}
            style={{
              width: "100%",
              padding: "11px 13px",
              marginBottom: "8px",
              borderRadius: "12px",
              border: "1px solid #d1d5db",
              boxSizing: "border-box",
            }}
          />

          <input
            type="number"
            value={newPlayerWickets}
            placeholder="Career wickets"
            onChange={(e) => setNewPlayerWickets(e.target.value)}
            style={{
              width: "100%",
              padding: "11px 13px",
              marginBottom: "10px",
              borderRadius: "12px",
              border: "1px solid #d1d5db",
              boxSizing: "border-box",
            }}
          />

          <button
            type="button"
            className="score-primary-button"
            onClick={() => addBrandNewPlayer(squadTeamTab)}
          >
            Add to {squadTeam?.name}
          </button>
        </div>
      </div>
    </div>
  );

  /* =========================================================
     OPENING SCREEN
  ========================================================= */

  if (screen === "opening") {
    return (
      <div className="scoring-page">

        <header className="score-header">

          <div>
            <span className="score-eyebrow">
              INNINGS{" "}
              {inningsIndex + 1}
            </span>

            <h1>
              {battingTeam.name}
            </h1>

            <p>
              {battingTeam.name}
              {" "}batting •{" "}
              {bowlingTeam.name}
              {" "}bowling
            </p>
          </div>

          <div className="live-badge">
            <span />
            LIVE
          </div>

        </header>

        <ScoringWinPredictionCard
          live={true}
          prediction={calculateWinPrediction({
            match: predictionMatch || match,
            scoringState: {
              inningsIndex,
              inningsRuns,
              inningsWickets,
              legalBalls,
              strikerId,
              nonStrikerId,
              currentBowlerId,
              battingStats,
              bowlingStats,
              deliveries,
            },
          })}
        />

        <section className="innings-start-card">

          <div className="start-ball">
            🏏
          </div>

          <h2>
            {inningsIndex === 0
              ? "Start First Innings"
              : "Start Second Innings"}
          </h2>

          <p>
            Select one or two batsmen
            and the bowler.
          </p>

          {inningsIndex === 1 && (
            <div className="target-box">
              Target:{" "}
              {Number(
                match.firstInningsScore ||
                  0
              ) + 1}
            </div>
          )}

          <button
            className="score-primary-button"
            onClick={
              startInnings
            }
          >
            Choose Openers & Bowler
          </button>

        </section>

        <section className="next-action-card">
         
          <button
            type="button"
            className="choose-bowler-button"
            onClick={openSquadManager}
          >
            👥 Manage Squad
          </button>
        </section>

        {squadModal}

        {showOpenerModal && (
          <div className="score-modal-backdrop">

            <div className="score-modal">

              <div className="modal-header">

                <div>
                  <span>
                    INNINGS SETUP
                  </span>

                  <h2>
                    Select Openers
                  </h2>
                </div>

                <button
                  className="close-button"
                  onClick={() =>
                    setShowOpenerModal(
                      false
                    )
                  }
                >
                  ×
                </button>

              </div>

              <div className="mode-selector">

                <button
                  className={
                    battingMode === 1
                      ? "selected"
                      : ""
                  }
                  onClick={() => {
                    setBattingMode(1);
                    setNonStrikerId("");
                  }}
                >
                  1 Batter
                </button>

                <button
                  className={
                    battingMode === 2
                      ? "selected"
                      : ""
                  }
                  disabled={
                    battingTeam.players
                      .length < 2
                  }
                  onClick={() =>
                    setBattingMode(2)
                  }
                >
                  2 Batters
                </button>

              </div>

              <div className="modal-section">

                <label>
                  Striker
                </label>

                <select
                  value={
                    strikerId
                  }
                  onChange={(e) =>
                    setStrikerId(
                      e.target.value
                    )
                  }
                >
                  <option value="">
                    Select striker
                  </option>

                  {battingTeam.players.map(
                    (player) => (
                      <option
                        key={
                          PLAYER_ID(
                            player
                          )
                        }
                        value={
                          PLAYER_ID(
                            player
                          )
                        }
                      >
                        {PLAYER_NAME(
                          player
                        )}
                      </option>
                    )
                  )}
                </select>

              </div>

              {battingMode === 2 && (
                <div className="modal-section">

                  <label>
                    Non-striker
                  </label>

                  <select
                    value={
                      nonStrikerId
                    }
                    onChange={(e) =>
                      setNonStrikerId(
                        e.target.value
                      )
                    }
                  >
                    <option value="">
                      Select non-striker
                    </option>

                    {battingTeam.players.map(
                      (player) => (
                        <option
                          key={
                            PLAYER_ID(
                              player
                            )
                          }
                          value={
                            PLAYER_ID(
                              player
                            )
                          }
                          disabled={
                            PLAYER_ID(
                              player
                            ) ===
                            String(
                              strikerId
                            )
                          }
                        >
                          {PLAYER_NAME(
                            player
                          )}
                        </option>
                      )
                    )}

                  </select>

                </div>
              )}

              <div className="modal-section">

                <label>
                  Opening Bowler
                </label>

                <select
                  value={
                    currentBowlerId
                  }
                  onChange={(e) =>
                    setCurrentBowlerId(
                      e.target.value
                    )
                  }
                >
                  <option value="">
                    Select bowler
                  </option>

                  {bowlingTeam.players.map(
                    (player) => (
                      <option
                        key={
                          PLAYER_ID(
                            player
                          )
                        }
                        value={
                          PLAYER_ID(
                            player
                          )
                        }
                        disabled={
                          !canSelectBowler(
                            player
                          )
                        }
                      >
                        {PLAYER_NAME(
                          player
                        )}
                      </option>
                    )
                  )}

                </select>

              </div>

              <button
                className="score-primary-button"
                onClick={
                  confirmOpeners
                }
              >
                Start Scoring
              </button>

            </div>

          </div>
        )}

      </div>
    );
  }

  /* =========================================================
     SCORING SCREEN
  ========================================================= */

  const scoringThemeStyles = (
    <style>{`
      [data-theme="dark"] .scoring-page .wide-stumped-button {
        background: #1f2937 !important;
        color: #ffffff !important;
        border-color: #4b5563 !important;
      }

      [data-theme="dark"] .scoring-page .wide-stumped-button.selected {
        background: #2563eb !important;
        color: #ffffff !important;
        border-color: #60a5fa !important;
      }

      [data-theme="dark"] .scoring-page .dark-safe-select,
      [data-theme="dark"] .scoring-page .score-modal select {
        color-scheme: dark;
        background-color: #111827 !important;
        color: #f9fafb !important;
        border-color: #4b5563 !important;
      }

      [data-theme="dark"] .scoring-page .score-modal option {
        background-color: #111827;
        color: #f9fafb;
      }

      [data-theme="dark"] .scoring-page .choose-bowler-button {
        background: #437af1 !important;
        color: #ffffff !important;
      }

      [data-theme="dark"] .scoring-page .score-modal-backdrop {
        overflow: hidden;
      }

      .scoring-page .next-action-card,
      .scoring-page .next-action-card * {
        min-width: 0;
        box-sizing: border-box;
      }

      .scoring-page .next-action-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        width: 100%;
        padding: 18px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 18px;
        background: var(--card-bg, #ffffff);
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
      }

      .scoring-page .next-action-card > div {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .scoring-page .next-action-card strong {
        color: var(--text-primary, #111827);
        font-size: 1rem;
      }

      .scoring-page .next-action-card small {
        color: var(--text-secondary, #64748b);
        line-height: 1.4;
      }

      .scoring-page .choose-bowler-button {
        display: flex !important;
        align-items: center;
        justify-content: center;
        min-height: 52px !important;
        margin-top: 4px !important;
        padding: 13px 18px !important;
        max-width: 100% !important;
        min-width: 0 !important;
        border: 0 !important;
        border-radius: 14px !important;
        background: #111827 !important;
        color: #ffffff !important;
        font-size: 15px;
        font-weight: 800;
        line-height: 1.2;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
        transition: transform 160ms ease, box-shadow 160ms ease, background 160ms ease;
      }

      .scoring-page .choose-bowler-button:hover {
        background: #1f2937 !important;
        box-shadow: 0 10px 22px rgba(15, 23, 42, 0.24);
        transform: translateY(-1px);
      }

      .scoring-page .choose-bowler-button:active {
        transform: translateY(0);
      }

      .scoring-page .dynamic-extra-panel {
        scroll-margin-top: 24px;
      }
    `}</style>
  );

  /*
   * The scorecard keeps every player who has already appeared
   * for a team, even after that player has left the match or
   * moved to the other side.
   */
  const scorecardPlayersFor = (teamId, statsForTeam) => {
    const current = rosters?.[teamId] || teams[teamId].players || [];
    const currentIds = new Set(ROSTER_IDS(current));

    const past = (rosterHistory?.[teamId] || []).filter((player) => {
      const id = PLAYER_ID(player);

      if (currentIds.has(String(id))) return false;

      const stats = statsForTeam?.[id];

      return Boolean(
        stats &&
          (stats.status !== "yet" ||
            Number(stats.runs || 0) > 0 ||
            Number(stats.balls || 0) > 0)
      );
    });

    return UNIQUE_PLAYERS([...current, ...past]);
  };

  const savedScorecardInnings =
    match.firstInningsData?.teamId === scorecardTab
      ? match.firstInningsData
      : match.secondInningsData?.teamId === scorecardTab
        ? match.secondInningsData
        : null;

  const selectedBattingStats =
    teams[scorecardTab].id === battingTeam.id
      ? battingStats
      : savedScorecardInnings?.battingStats || {};

  const selectedBowlingStats =
    teams[scorecardTab].id === battingTeam.id
      ? bowlingStats
      : savedScorecardInnings?.bowlingStats || {};

  const selectedScorecardTeam = {
    ...teams[scorecardTab],
    players: scorecardPlayersFor(scorecardTab, selectedBattingStats),
  };

  const bowlingSideId = scorecardTab === "A" ? "B" : "A";

  const selectedBowlingTeam = {
    ...teams[bowlingSideId],
    players: scorecardPlayersFor(bowlingSideId, {}),
  };

  return (
    <div className="scoring-page">

      {scoringThemeStyles}

      {/* HEADER */}

      <header className="score-header">

        <div>

          <span className="score-eyebrow">
            LIVE SCORING
          </span>

          <h1>
            {battingTeam.name}
          </h1>

          <p>
            {currentBowler
              ? `Bowler: ${PLAYER_NAME(
                  currentBowler
                )}`
              : "Select bowler"}
          </p>

        </div>

        <div className="live-badge">
          <span />
          LIVE
        </div>

      </header>

      {/* SCORE */}

      <section className="main-score-card">

        <div className="innings-team-name">
          {battingTeam.name}
        </div>

        <div className="big-score">
          {inningsRuns}
          <span>
            /
            {inningsWickets}
          </span>
        </div>

        <div className="overs-text">
          {formatOvers(
            legalBalls
          )}
          {" / "}
          {match.overs || 3}
          {" overs"}
        </div>

        {inningsIndex === 1 && (
          <div className="target-text">
            Target:{" "}
            {Number(
              match.firstInningsScore ||
                0
            ) + 1}
          </div>
        )}

      </section>

      <ScoringWinPredictionCard
        live={true}
        prediction={calculateWinPrediction({
          match: predictionMatch || match,
          scoringState: {
            inningsIndex,
            inningsRuns,
            inningsWickets,
            legalBalls,
            strikerId,
            nonStrikerId,
            currentBowlerId,
            battingStats,
            bowlingStats,
            deliveries,
          },
        })}
      />

      {/* BATTERS */}

      <section className="current-batters-card">

        <div className="section-title">

          <span>
            BATTERS
          </span>

          <small>
            {battingMode === 1
              ? "Single batter"
              : "Current partnership"}
          </small>

        </div>

        <div className="current-batters">

          <div className="current-batter active-batter">

            <span className="strike-indicator">
              ●
            </span>

            <div>
              <strong>
                {striker
                  ? PLAYER_NAME(
                      striker
                    )
                  : "New Batsman"}
              </strong>

              <small>
                {striker
                  ? `${
                      battingStats[
                        PLAYER_ID(
                          striker
                        )
                      ]?.runs || 0
                    } runs`
                  : "Selection required"}
              </small>
            </div>

          </div>

          {battingMode === 2 && (
            <div className="current-batter">

              <span className="strike-indicator">
                ○
              </span>

              <div>

                <strong>
                  {nonStriker
                    ? PLAYER_NAME(
                        nonStriker
                      )
                    : "Non-striker"}
                </strong>

                <small>
                  {nonStriker
                    ? `${
                        battingStats[
                          PLAYER_ID(
                            nonStriker
                          )
                        ]?.runs || 0
                      } runs`
                    : "Waiting"}
                </small>

              </div>

            </div>
          )}

        </div>

      </section>

      {/* NEW BATSMAN REQUIRED */}

      {pendingReplacement && availableBatters.length > 0 && (
        <section className="next-action-card">

          <div>
            <strong>
              🏏 Select Batsman
            </strong>

            <small>
              The previous batsman is out. Choose the
              new batsman.
            </small>
          </div>

          <button
            type="button"
            className="choose-bowler-button"
            onClick={() => setShowBatterModal(true)}
          >
            🏏 Choose Batsman
          </button>

        </section>
      )}

      {/* BOWLER REQUIRED */}

      {!pendingReplacement &&
        !currentBowler && (
          <section className="next-action-card">

            <div>
              <strong>
                🎯 Select Bowler
              </strong>

              <small>
                Choose the bowler for
                this over.
              </small>
            </div>

            <button
              type="button"
              className="choose-bowler-button"
              onClick={() => setShowBowlerModal(true)}
            >
              🎯 Choose Bowler
            </button>

          </section>
        )}

    
      {/* OVER */}

      <section className="over-card">

        <div className="section-title">

          <span>
            OVER {currentOver + 1}
          </span>

          <small>
            {
              currentOverBalls.filter(
                (ball) =>
                  ball.validBall
              ).length
            }
            /6 valid
          </small>

        </div>

        <div className="ball-grid bowling-timeline-grid">
          {currentOverBalls.length === 0 ? (
            <div className="empty-over-message">
              No balls bowled yet
            </div>
          ) : (
            currentOverBalls.map((ball, index) => {
              const label = getBallTimelineLabel(ball);

              return (
                <div
                  key={ball.id || `${ball.over}-${ball.ball}-${index}`}
                  className={`ball-slot ball-used ${
                    ball.wicket ? "wicket-ball" : ""
                  } ${ball.type === "NB" ? "no-ball-slot" : ""} ${
                    ball.type === "WD" ? "wide-slot" : ""
                  }`}
                  title={getBallTimelineTitle(ball)}
                >
                  <strong>{label}</strong>
                </div>
              );
            })
          )}
        </div>

        {freeHit && (
          <div className="free-hit-banner">
            🔥 FREE HIT
          </div>
        )}

      </section>

      {/* BAT RUNS */}

      <section className="run-card">

        <div className="section-title">

          <span>
            BATTER RUNS
          </span>

          <small>
            {striker
              ? PLAYER_NAME(
                  striker
                )
              : "No striker"}
          </small>

        </div>

        <div className="run-grid">

          {[0, 1, 2, 3, 4, 5, 6].map(
            (run) => (
              <button
                key={run}
                className={
                  `run-button ${
                    run === 4 ||
                    run === 6
                      ? "boundary-run"
                      : ""
                  }`
                }
                disabled={
                  !striker ||
                  !currentBowler ||
                  !!pendingReplacement
                }
                onClick={() =>
                  recordNormalRun(
                    run
                  )
                }
              >
                {run}
              </button>
            )
          )}

        </div>

      </section>

      {/* EXTRAS */}

      <section className="extras-card">

        <div className="section-title">

          <span>
            EXTRAS / SPECIAL
          </span>

          <small>
            Tap to open
          </small>

        </div>

        <div className="extra-button-grid">

          <button
            className="extra-button dead"
            onClick={
              recordDeadBall
            }
          >
            <strong>
              DEAD
            </strong>

            <small>
              0 run
            </small>
          </button>

          <button
            className="extra-button noball"
            href="dynamic-extra-panel-nb"
            disabled={!currentBowler || !!pendingReplacement}
            onClick={() => {
              setExtraPanel("NB");
              setExtraRuns(null);
              setNbMode(null);
            }}
          >
            <strong>
              NO BALL
            </strong>

            <small>
              +1 + BAT/BYE
            </small>
          </button>

          <button
            className="extra-button wide"
            disabled={!currentBowler || !!pendingReplacement}
            id="dynamic-extra-panel-wd"
            onClick={() => {
              setExtraPanel("WD");
              setExtraRuns(null);
            }}
          >
            <strong>
              WIDE
            </strong>

            <small>
              +1 to +7
            </small>
          </button>

          <button
            className="extra-button bye"
            disabled={!currentBowler || !!pendingReplacement}
            onClick={() => {
              setExtraPanel("BYE");
              setExtraRuns(null);
            }}
          >
            <strong>
              BYE
            </strong>

            <small>
              0 - 6
            </small>
          </button>

          <button
            className="extra-button legbye"
            disabled={!currentBowler || !!pendingReplacement}
            onClick={() => {
              setExtraPanel("LB");
              setExtraRuns(null);
            }}
          >
            <strong>
              LEG BYE
            </strong>

            <small>
              0 - 6
            </small>
          </button>

        </div>

      </section>

      {/* DYNAMIC EXTRA PANEL */}

      {extraPanel && (
        <section
          ref={extraPanelRef}
          id={`dynamic-extra-panel-${extraPanel.toLowerCase()}`}
          className="dynamic-extra-panel"
          tabIndex="-1"
        >

          <div className="dynamic-extra-header">

            <div>

              <span>
                SPECIAL BALL
              </span>

              <h2>
                {extraPanel ===
                  "NB" &&
                  "No Ball"}

                {extraPanel ===
                  "WD" &&
                  "Wide"}

                {extraPanel ===
                  "BYE" &&
                  "Bye"}

                {extraPanel ===
                  "LB" &&
                  "Leg Bye"}
              </h2>

            </div>

            <button
              onClick={() =>
                setExtraPanel(null)
              }
            >
              ×
            </button>

          </div>

          {/* NO BALL */}

          {extraPanel ===
            "NB" && (
            <>
              <h4>
                No Ball + BAT
              </h4>

              <div className="dynamic-run-grid">

                {[0, 1, 2, 3, 4, 5, 6].map(
                  (run) => (
                    <button
                      key={
                        `nb-bat-${run}`
                      }
                      className={
                        nbMode ===
                          "BAT" &&
                        extraRuns ===
                          run
                          ? "selected"
                          : ""
                      }
                      disabled={nbWicketType === "Boundary Wicket"}
                      onClick={() => {
                        if (nbWicketType === "Boundary Wicket") return;
                        setNbMode("BAT");
                        setExtraRuns(run);
                      }}
                    >
                      {run}
                    </button>
                  )
                )}

              </div>

              <h4>
                No Ball + BYE
              </h4>

              <div className="dynamic-run-grid">

                {[0, 1, 2, 3, 4, 5, 6].map(
                  (run) => (
                    <button
                      key={
                        `nb-bye-${run}`
                      }
                      className={
                        nbMode ===
                          "BYE" &&
                        extraRuns ===
                          run
                          ? "selected"
                          : ""
                      }
                      disabled={nbWicketType === "Boundary Wicket"}
                      onClick={() => {
                        if (nbWicketType === "Boundary Wicket") return;
                        setNbMode("BYE");
                        setExtraRuns(run);
                      }}
                    >
                      {run}
                    </button>
                  )
                )}

              </div>

              <div className="modal-section special-wicket-section">
                <label>No Ball Wicket (optional)</label>
                <div className="wicket-type-grid">
                  {["Run out", "Boundary Wicket"].map(type => (
                    <button
                      key={type}
                      type="button"
                      className={nbWicketType === type ? "selected" : ""}
                      onClick={() => {
                        const nextType = nbWicketType === type ? null : type;
                        setNbWicketType(nextType);
                        setNbWicketBatterId(
                          nextType === "Boundary Wicket"
                            ? PLAYER_ID(striker)
                            : nbWicketBatterId
                        );
                        setNbWicketFielderId("");

                        if (nextType === "Boundary Wicket") {
                          // Boundary Wicket = 0 run + wicket only.
                          setNbMode("BAT");
                          setExtraRuns(0);
                        } else if (nbWicketType === "Boundary Wicket") {
                          setNbMode(null);
                          setExtraRuns(null);
                        }
                      }}
                    >
                      {type}
                    </button>
                  ))}
                </div>

                {nbWicketType === "Boundary Wicket" && (
                  <div className="selected-wicket-batter">
                    <label>Dismissed Batter</label>
                    <div className="selected-player-display">
                      {striker ? PLAYER_NAME(striker) : "No striker selected"}
                      <small>Only the striker can be dismissed by Boundary Wicket.</small>
                    </div>
                  </div>
                )}

                {nbWicketType === "Run out" && (
                  <>
                    <label>Dismissed Batter</label>
                    <select value={nbWicketBatterId} onChange={e => setNbWicketBatterId(e.target.value)}>
                      <option value="">Select batter</option>
                      {[striker, nonStriker].filter(Boolean).map(player => (
                        <option key={PLAYER_ID(player)} value={PLAYER_ID(player)}>
                          {PLAYER_NAME(player)}
                        </option>
                      ))}
                    </select>

                    <label>Fielder</label>
                    <select value={nbWicketFielderId} onChange={e => setNbWicketFielderId(e.target.value)}>
                      <option value="">Select fielder</option>
                      {bowlingTeam?.players?.map(player => (
                        <option key={PLAYER_ID(player)} value={PLAYER_ID(player)}>
                          {PLAYER_NAME(player)}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>

              <div className="free-hit-preview">
                🔥 FREE HIT
              </div>

              <button
                className="confirm-special-button"
                disabled={
                  extraRuns === null ||
                  !nbMode ||
                  !currentBowler ||
                  (nbWicketType === "Boundary Wicket" &&
                    (nbMode !== "BAT" || Number(extraRuns) !== 0))
                }
                onClick={() => {

                  const ok = recordNoBall(
                    nbMode,
                    extraRuns,
                    nbWicketType
                      ? {
                          type: nbWicketType,
                          batterId: nbWicketBatterId || PLAYER_ID(striker),
                          fielderId: nbWicketFielderId || null,
                        }
                      : null
                  );

                  if (!ok) return;

                  setExtraPanel(
                    null
                  );

                  setExtraRuns(
                    null
                  );

                  setNbMode(
                    null
                  );
                  setNbWicketType(null);
                  setNbWicketBatterId("");
                  setNbWicketFielderId("");

                }}
              >
                Add No Ball
              </button>

            </>
          )}

          {/* WIDE */}

          {extraPanel ===
            "WD" && (
            <>
              <p>
                Select WD + extra
                keeper runs.
              </p>

              <div className="dynamic-run-grid wide-grid">

                {[0, 1, 2, 3, 4, 5, 6].map(
                  (run) => (
                    <button
                      key={
                        `wd-${run}`
                      }
                      className={
                        extraRuns ===
                          run
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        setExtraRuns(
                          run
                        )
                      }
                    >
                      WD + {run}
                    </button>
                  )
                )}

              </div>

              <div className="modal-section special-wicket-section">
                <label>Wide Wicket (optional)</label>
                <button
                  type="button"
                  className={`wide-stumped-button ${
                    wdWicketBatterId ? "selected" : ""
                  }`}
                  style={{
                    width: "100%",
                    minHeight: "48px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "11px 14px",
                    marginTop: "8px",
                    borderRadius: "12px",
                    border: wdWicketBatterId
                      ? "2px solid #2563eb"
                      : "1px solid #9ca3af",
                    background: wdWicketBatterId
                      ? "#2563eb"
                      : "#ffffff",
                    color: wdWicketBatterId
                      ? "#ffffff"
                      : "#111827",
                    fontSize: "15px",
                    fontWeight: 800,
                    cursor: "pointer",
                    boxSizing: "border-box",
                    WebkitAppearance: "none",
                    appearance: "none",
                  }}
                  onClick={() => {
                    if (wdWicketBatterId) {
                      setWdWicketBatterId("");
                      setWdWicketFielderId("");
                    } else {
                      setWdWicketBatterId(strikerId || "");
                    }
                  }}
                >
                  Stumped
                </button>

                {wdWicketBatterId && (
                  <>
                    <label>Dismissed Batter</label>
                    <select
                      value={wdWicketBatterId}
                      onChange={e => setWdWicketBatterId(e.target.value)}
                      className="dark-safe-select"
                    >
                      <option value="">Select batter</option>
                      {battingTeam?.players?.map(player => (
                        <option key={PLAYER_ID(player)} value={PLAYER_ID(player)}>
                          {PLAYER_NAME(player)}
                        </option>
                      ))}
                    </select>

                    <label>Wicketkeeper / Fielder</label>
                    <select
                      value={wdWicketFielderId}
                      onChange={e => setWdWicketFielderId(e.target.value)}
                      className="dark-safe-select"
                    >
                      <option value="">Select wicketkeeper</option>
                      {bowlingTeam?.players?.map(player => (
                        <option key={PLAYER_ID(player)} value={PLAYER_ID(player)}>
                          {PLAYER_NAME(player)}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>

              <button
                className="confirm-special-button"
                disabled={
                  extraRuns === null
                }
                onClick={() => {

                  const ok = recordWide(
                    extraRuns,
                    wdWicketBatterId
                      ? {
                          type: "Stumped",
                          batterId: wdWicketBatterId,
                          fielderId: wdWicketFielderId || null,
                        }
                      : null
                  );

                  if (!ok) return;

                  setExtraPanel(
                    null
                  );

                  setExtraRuns(
                    null
                  );
                  setWdWicketBatterId("");
                  setWdWicketFielderId("");

                }}
              >
                Add Wide
              </button>

            </>
          )}

          {/* BYE */}

          {extraPanel ===
            "BYE" && (
            <>
              <p>
                Select bye runs.
              </p>

              <div className="dynamic-run-grid">

                {[0, 1, 2, 3, 4, 5, 6].map(
                  (run) => (
                    <button
                      key={
                        `bye-${run}`
                      }
                      className={
                        extraRuns ===
                          run
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        setExtraRuns(
                          run
                        )
                      }
                    >
                      {run}
                    </button>
                  )
                )}

              </div>

              <button
                className="confirm-special-button"
                disabled={
                  extraRuns === null
                }
                onClick={() => {

                  recordBye(
                    extraRuns
                  );

                  setExtraPanel(
                    null
                  );

                  setExtraRuns(
                    null
                  );

                }}
              >
                Add Bye
              </button>

            </>
          )}

          {/* LEG BYE */}

          {extraPanel ===
            "LB" && (
            <>
              <p>
                Select leg bye runs.
              </p>

              <div className="dynamic-run-grid">

                {[0, 1, 2, 3, 4, 5, 6].map(
                  (run) => (
                    <button
                      key={
                        `lb-${run}`
                      }
                      className={
                        extraRuns ===
                          run
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        setExtraRuns(
                          run
                        )
                      }
                    >
                      {run}
                    </button>
                  )
                )}

              </div>

              <button
                className="confirm-special-button"
                disabled={
                  extraRuns === null
                }
                onClick={() => {

                  recordLegBye(
                    extraRuns
                  );

                  setExtraPanel(
                    null
                  );

                  setExtraRuns(
                    null
                  );

                }}
              >
                Add Leg Bye
              </button>

            </>
          )}

        </section>
      )}

      {/* WICKET */}

      {!pendingReplacement && (
        <section className="wicket-section">

          <button
            className="big-wicket-button"
            disabled={
              !striker ||
              !currentBowler
            }
            onClick={
              openWicket
            }
          >
            <span>
              ✕
            </span>

            WICKET
          </button>

        </section>
      )}

      {/* CONTROLS */}

      <section className="scoring-controls">

        <button
          onClick={() =>
            setShowBowlerModal(
              true
            )
          }
        >
          🎯 Change Bowler
        </button>

        <button
          onClick={
            undoBall
          }
          disabled={
            !history.length
          }
        >
          ↩ Undo Ball
        </button>

        <button
          onClick={
            undoOver
          }
          disabled={
            !history.length
          }
        >
          ↩ Undo Over
        </button>

      </section>

  {/* SQUAD CHANGES */}

      <section className="next-action-card">

        <div>
          <strong>
            👥 Squad Changes
          </strong>

          <small>
            Add a new player, remove a player or move a
            player to the other team. Past statistics stay
            in the scorecard.
          </small>
        </div>

        <button
          type="button"
          className="choose-bowler-button"
          onClick={openSquadManager}
        >
          👥 Manage Squad
        </button>

      </section>


{/* end innings */}

      <button
  className="end-innings-btn"
  onClick={handleEndInnings}
>
  End Innings
</button>
      {/* AI */}

      <section className="ai-suggestion-card">

        <div className="ai-title">
          ✨ AI SUGGESTION
        </div>


        {/* =================================================
            BATSMAN SUGGESTION
        ================================================== */}

        <div className="ai-suggestion-part">

          <div className="ai-row">

            <div>

              <span>
                Next batsman
              </span>

              <strong>
                {batterSuggestionMessage
                  ? batterSuggestionMessage
                  : nextBatterSuggestion}
              </strong>

            </div>

          </div>


          <button
            type="button"
            onClick={
              suggestAnotherBatter
            }
            className="suggest-another-btn"
          >
            Suggest Another
          </button>

        </div>


        {/* =================================================
            BOWLER SUGGESTION
        ================================================== */}

        <div className="ai-suggestion-part">

          <div className="ai-row">

            <div>

              <span>
                Next bowler
              </span>

              <strong>
                {bowlerSuggestionMessage
                  ? bowlerSuggestionMessage
                  : nextBowlerSuggestion}
              </strong>

            </div>

          </div>


          <button
            type="button"
            onClick={
              suggestAnotherBowler
            }
            className="suggest-another-btn"
          >
            Suggest Another
          </button>

        </div>

      </section>

      {/* SCORECARD */}

      <section className="scorecard-section">

        <div className="scorecard-tabs">

          <button
            className={
              scorecardTab ===
              "A"
                ? "active"
                : ""
            }
            onClick={() =>
              setScorecardTab("A")
            }
          >
            {teams.A.name}
          </button>

          <button
            className={
              scorecardTab ===
              "B"
                ? "active"
                : ""
            }
            onClick={() =>
              setScorecardTab("B")
            }
          >
            {teams.B.name}
          </button>

        </div>

        <Scorecard
          team={selectedScorecardTeam}
          battingStats={selectedBattingStats}
          bowlingTeam={selectedBowlingTeam}
          bowlingStats={selectedBowlingStats}
          extras={extras}
          fallOfWickets={
            fallOfWickets
          }
        />

      </section>

      {/* SQUAD MODAL */}

      {squadModal}

      {/* WICKET MODAL */}

      {showWicketModal && (
        <div className="score-modal-backdrop">

          <div className="score-modal">

            <div className="modal-header">

              <div>

                <span>
                  DISMISSAL
                </span>

                <h2>
                  Record Wicket
                </h2>

              </div>

              <button
                className="close-button"
                onClick={() =>
                  setShowWicketModal(
                    false
                  )
                }
              >
                ×
              </button>

            </div>

            {freeHit && (
              <div className="free-hit-modal">
                🔥 FREE HIT — only
                Run Out or Boundary
                Wicket allowed
              </div>
            )}

            <div className="modal-section">

              <label>
                Batter Out
              </label>

              <select
                value={
                  wicketBatterId
                }
                onChange={(e) => {
                  const nextId = e.target.value;
                  setWicketBatterId(nextId);

                  if (wicketType === "Run out") {
                    const selectedIsStriker =
                      String(nextId) ===
                      String(strikerId);

                    setRunOutDismissedPosition(
                      selectedIsStriker
                        ? "striker"
                        : "nonStriker"
                    );

                    setRunOutOtherPosition(
                      selectedIsStriker
                        ? "nonStriker"
                        : "striker"
                    );
                  }
                }}
              >

                {(wicketType === "Boundary Wicket"
                  ? [striker]
                  : [striker, nonStriker]
                )
                  .filter(Boolean)
                  .map(
                    (player) => (
                      <option
                        key={
                          PLAYER_ID(
                            player
                          )
                        }
                        value={
                          PLAYER_ID(
                            player
                          )
                        }
                      >
                        {PLAYER_NAME(
                          player
                        )}
                      </option>
                    )
                  )}

              </select>

            </div>

            <div className="wicket-type-grid">

              {wicketTypes.map(
                (type) => {

                  const disabled =
                    freeHit &&
                    !legalFreeHitWickets.includes(
                      type
                    );

                  return (
                    <button
                      key={type}
                      disabled={
                        disabled
                      }
                      className={
                        wicketType ===
                        type
                          ? "selected"
                          : ""
                      }
                      onClick={() => {
                        setWicketType(type);
                        if (type === "Boundary Wicket" && striker) {
                          setWicketBatterId(PLAYER_ID(striker));
                        }

                        if (type === "Run out") {
                          const selectedIsStriker =
                            String(wicketBatterId) ===
                            String(strikerId);

                          setRunOutDismissedPosition(
                            selectedIsStriker
                              ? "striker"
                              : "nonStriker"
                          );

                          setRunOutOtherPosition(
                            selectedIsStriker
                              ? "nonStriker"
                              : "striker"
                          );
                        }
                      }}
                    >
                      {type}
                    </button>
                  );
                }
              )}

            </div>

            {[
              "Caught",
              "Run out",
              "Stumped",
              "Obstructing the Field",
            ].includes(
              wicketType
            ) && (
              <div className="modal-section">

                <label>
                  Fielder
                </label>

                <select
                  value={
                    wicketFielderId
                  }
                  onChange={(e) =>
                    setWicketFielderId(
                      e.target.value
                    )
                  }
                >

                  <option value="">
                    Select fielder
                  </option>

                  {bowlingTeam.players.map(
                    (player) => (
                      <option
                        key={
                          PLAYER_ID(
                            player
                          )
                        }
                        value={
                          PLAYER_ID(
                            player
                          )
                        }
                      >
                        {PLAYER_NAME(
                          player
                        )}
                      </option>
                    )
                  )}

                </select>

              </div>
            )}

            {wicketType ===
              "Run out" && (
              <div className="modal-section">

                <label>
                  Completed Runs
                </label>

                <div className="modal-run-grid">

                  {[0, 1, 2, 3, 4, 5, 6].map(
                    (run) => (
                      <button
                        key={run}
                        className={
                          wicketRuns ===
                          run
                            ? "selected"
                            : ""
                        }
                        onClick={() =>
                          setWicketRuns(
                            run
                          )
                        }
                      >
                        {run}
                      </button>
                    )
                  )}

                </div>

              </div>
            )}

            {wicketType === "Run out" &&
              battingMode === 2 && (
                <div className="modal-section">
                  <label>Final position of out batsman</label>
                  <select
                    value={runOutDismissedPosition}
                    onChange={(e) => {
                      const next = e.target.value;
                      setRunOutDismissedPosition(next);
                      setRunOutOtherPosition(
                        next === "striker"
                          ? "nonStriker"
                          : "striker"
                      );
                    }}
                  >
                    <option value="striker">Striker end</option>
                    <option value="nonStriker">Non-striker end</option>
                  </select>

                  <label>Final position of other batsman</label>
                  <select
                    value={runOutOtherPosition}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === runOutDismissedPosition) return;

                      setRunOutOtherPosition(next);
                      setRunOutDismissedPosition(
                        next === "striker"
                          ? "nonStriker"
                          : "striker"
                      );
                    }}
                  >
                    <option value="striker">Striker end</option>
                    <option value="nonStriker">Non-striker end</option>
                  </select>
                </div>
              )}

            {wicketType === "Boundary Wicket" && (
              <div className="modal-section">
                <label>Dismissed Batter</label>
                <div className="selected-player-display">
                  {striker ? PLAYER_NAME(striker) : "No striker selected"}
                  <small>Boundary Wicket = 0 runs. Only the striker is dismissed.</small>
                </div>
              </div>
            )}

            <button
              className="retired-hurt-button"
              onClick={
                retireHurt
              }
            >
              🩹 Retired Hurt
            </button>

            <button
              className="score-primary-button"
              onClick={
                saveWicket
              }
            >
              Confirm Wicket
            </button>

          </div>

        </div>
      )}

      {/* NEW BATSMAN MODAL */}

      {showBatterModal &&
        pendingReplacement &&
        availableBatters.length > 0 && (
          <div className="score-modal-backdrop">

            <div
              className="score-modal"
              style={{
                width: "100%",
                maxWidth: "520px",
                maxHeight: "90vh",
                overflowY: "auto",
                overflowX: "hidden",
                boxSizing: "border-box",
              }}
            >

              <div className="modal-header">

                <div>

                  <span>
                    BATTING
                  </span>

                  <h2>
                    Select Batsman
                  </h2>

                </div>

                <button
                  className="close-button"
                  onClick={() =>
                    setShowBatterModal(false)
                  }
                >
                  ×
                </button>

              </div>

              <div className="bowler-list">

                {availableBatters.map((player) => {

                  const id = PLAYER_ID(player);

                  return (
                    <button
                      key={id}
                      type="button"
                      className="bowler-option-button"
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        minHeight: "58px",
                        padding: "13px 15px",
                        marginBottom: "10px",
                        borderRadius: "14px",
                        border: "1px solid #d1d5db",
                        background: "#ffffff",
                        color: "#111827",
                        cursor: "pointer",
                        textAlign: "left",
                        boxSizing: "border-box",
                        WebkitAppearance: "none",
                        appearance: "none",
                      }}
                      onClick={() => selectNewBatsman(player)}
                    >
                      <span style={{ fontWeight: 800, color: "#111827" }}>
                        {PLAYER_NAME(player)}
                      </span>

                      <small style={{ fontWeight: 700, color: "#6b7280" }}>
                        {CAREER_RUNS(player, careerStats)} career runs
                      </small>
                    </button>
                  );
                })}

              </div>

            </div>

          </div>
        )}

      {/* BOWLER MODAL */}

      {showBowlerModal && (
        <div className="score-modal-backdrop">

          <div
            className="score-modal"
            style={{
              width: "100%",
              maxWidth: "520px",
              maxHeight: "90vh",
              overflowY: "auto",
              overflowX: "hidden",
              boxSizing: "border-box",
            }}
          >

            <div className="modal-header">

              <div>

                <span>
                  BOWLING
                </span>

                <h2>
                  Select Bowler
                </h2>

              </div>

              <button
                className="close-button"
                onClick={() =>
                  setShowBowlerModal(
                    false
                  )
                }
              >
                ×
              </button>

            </div>

            <div className="bowler-list">

              {bowlingTeam.players.map(
                (player) => {

                  const id =
                    PLAYER_ID(
                      player
                    );

                  const disabled =
                    !canSelectBowler(
                      player
                    );

                  const selected = id === String(currentBowlerId);

                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={disabled}
                      className={`bowler-option-button ${selected ? "selected" : ""}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        minHeight: "58px",
                        padding: "13px 15px",
                        marginBottom: "10px",
                        borderRadius: "14px",
                        border: selected ? "2px solid #2563eb" : "1px solid #d1d5db",
                        background: selected ? "#eff6ff" : "#ffffff",
                        color: "#111827",
                        opacity: disabled ? 0.45 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                        textAlign: "left",
                        boxSizing: "border-box",
                        WebkitAppearance: "none",
                        appearance: "none",
                      }}
                      onClick={() => selectBowler(id)}
                    >
                      <span style={{ fontWeight: 800, color: "#111827" }}>
                        {PLAYER_NAME(player)}
                      </span>
                      <small style={{ fontWeight: 700, color: "#6b7280" }}>
                        {CAREER_WICKETS(player, careerStats)} career wkts •{" "}
                        {formatOvers(bowlingStats[id]?.legalBalls || 0)}
                      </small>
                    </button>
                  );
                }
              )}

            </div>

          </div>

        </div>
      )}

    </div>
  );
}

/* =========================================================
   SCORECARD
========================================================= */

function Scorecard({
  team,
  battingStats,
  bowlingTeam,
  bowlingStats,
  extras,
  fallOfWickets,
}) {
  if (!team) return null;

  const batters =
    team.players.map(
      (player, index) =>
        battingStats[
          PLAYER_ID(player)
        ] ||
        makeBatter(
          player,
          index + 1
        )
    );

  const played =
    batters.filter(
      (player) =>
        player.status !== "yet" ||
        player.balls > 0 ||
        player.runs > 0
    );

  const yetToBat =
    batters.filter(
      (player) =>
        player.status ===
        "yet"
    );

  const bowlers =
    bowlingTeam?.players.map(
      (player) =>
        bowlingStats[
          PLAYER_ID(player)
        ] ||
        makeBowler(player)
    ) || [];

  return (
    <div className="scorecard">

      <div className="scorecard-heading">
        <h2>
          {team.name}
        </h2>
      </div>

      {/* BATTING */}

      <div className="scorecard-block">

        <h3>
          Batting
        </h3>

        <div className="table-wrap">

          <table>

            <thead>
              <tr>
                <th>
                  SL
                </th>

                <th>
                  Batter
                </th>

                <th>
                  R
                </th>

                <th>
                  B
                </th>

                <th>
                  4s
                </th>

                <th>
                  6s
                </th>

                <th>
                  SR
                </th>
              </tr>
            </thead>

            <tbody>

              {played.map(
                (player) => (
                  <tr
                    key={
                      player.id
                    }
                  >

                    <td>
                      {
                        player.battingOrder
                      }
                    </td>

                    <td>

                      <strong>
                        {
                          player.name
                        }
                      </strong>

                      <small className="dismissal">

                        {player.status ===
                        "out"
                          ? `out • ${
                              player.dismissal ||
                              ""
                            }${
                              player.fielder
                                ? ` • ${player.fielder}`
                                : ""
                            }`
                          : player.status ===
                            "retired hurt"
                          ? "Retired hurt"
                          : "not out"}

                      </small>

                      {player.bowler && (
                        <small className="dismissal">
                          Bowler:{" "}
                          {
                            player.bowler
                          }
                        </small>
                      )}

                    </td>

                    <td>
                      {
                        player.runs
                      }
                    </td>

                    <td>
                      {
                        player.balls
                      }
                    </td>

                    <td>
                      {
                        player.fours
                      }
                    </td>

                    <td>
                      {
                        player.sixes
                      }
                    </td>

                    <td>
                      {strikeRate(
                        player.runs,
                        player.balls
                      )}
                    </td>

                  </tr>
                )
              )}

            </tbody>

          </table>

        </div>

      </div>

      {/* YET TO BAT */}

      <div className="scorecard-block">

        <h3>
          Yet to Bat
        </h3>

        {yetToBat.length ? (
          <div className="yet-to-bat">

            {yetToBat.map(
              (player) => (
                <span
                  key={
                    player.id
                  }
                >
                  {player.name}
                </span>
              )
            )}

          </div>
        ) : (
          <p className="empty-text">
            No batters remaining
          </p>
        )}

      </div>

      {/* FALL OF WICKETS */}

      <div className="scorecard-block">

        <h3>
          Fall of Wickets
        </h3>

        {fallOfWickets.length ? (
          <div className="fow-list">

            {fallOfWickets.map(
              (item) => (
                <div
                  key={
                    `${item.wicket}-${item.score}`
                  }
                >

                  <strong>
                    {item.wicket}
                  </strong>

                  <span>
                    {item.batter}
                  </span>

                  <span>
                    {item.score}
                  </span>

                  <small>
                    {item.over}
                  </small>

                </div>
              )
            )}

          </div>
        ) : (
          <p className="empty-text">
            No wickets
          </p>
        )}

      </div>

      {/* EXTRAS */}

      <div className="scorecard-block">

        <h3>
          Extras
        </h3>

        <div className="extras-summary">

          <div>
            <span>
              NB
            </span>
            <strong>
              {extras.nb}
            </strong>
          </div>

          <div>
            <span>
              WD
            </span>
            <strong>
              {extras.wd}
            </strong>
          </div>

          <div>
            <span>
              BYE
            </span>
            <strong>
              {extras.bye}
            </strong>
          </div>

          <div>
            <span>
              LB
            </span>
            <strong>
              {extras.lb}
            </strong>
          </div>

        </div>

        <div className="extras-total">
          Total Extras:{" "}
          {
            extras.nb +
            extras.wd +
            extras.bye +
            extras.lb
          }
        </div>

      </div>

      {/* BOWLING */}

      <div className="scorecard-block">

        <h3>
          Bowling
        </h3>

        <div className="table-wrap">

          <table>

            <thead>
              <tr>
                <th>
                  Bowler
                </th>

                <th>
                  O
                </th>

                <th>
                  M
                </th>

                <th>
                  R
                </th>

                <th>
                  W
                </th>

                <th>
                  Econ
                </th>
              </tr>
            </thead>

            <tbody>

              {bowlers
                .filter(
                  (bowler) =>
                    bowler.legalBalls >
                      0 ||
                    bowler.runs >
                      0 ||
                    bowler.wickets >
                      0
                )
                .map(
                  (bowler) => (
                    <tr
                      key={
                        bowler.id
                      }
                    >

                      <td>
                        <strong>
                          {
                            bowler.name
                          }
                        </strong>
                      </td>

                      <td>
                        {formatOvers(
                          bowler.legalBalls
                        )}
                      </td>

                      <td>
                        {
                          bowler.maidens
                        }
                      </td>

                      <td>
                        {
                          bowler.runs
                        }
                      </td>

                      <td>
                        {
                          bowler.wickets
                        }
                      </td>

                      <td>
                        {economy(
                          bowler.runs,
                          bowler.legalBalls
                        )}
                      </td>

                    </tr>
                  )
                )}

            </tbody>

          </table>

        </div>

      </div>

    </div>
  );
}