
import React, { useEffect, useState } from "react";
import "./dashboard.css";
import {
  collection,
  getDocs,
} from "firebase/firestore";

import {
  auth,
  db,
} from "../firebase/firebase";
import { calculateStrengthPoints } from "../services/playerStrength";
import AdminUndoDelete from "../components/AdminUndoDelete";
import LoadingOverlay from "../components/LoadingOverlay";

function Dashboard() {
  // ==========================================
  // DASHBOARD COUNTS
  // ==========================================

  const [playerCount, setPlayerCount] = useState(0);
  const [teamCount, setTeamCount] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [inningsCount, setInningsCount] = useState(0);
  const [tournamentCount, setTournamentCount] = useState(0);
  const [playerName, setPlayerName] = useState(
    auth.currentUser?.displayName?.trim() ||
      "Player"
  );

  // ==========================================
  // PLAYER LEADERBOARD
  // ==========================================

  const [leaderboardTab, setLeaderboardTab] =
    useState("batsman");

  const [batsmanRanking, setBatsmanRanking] =
    useState([]);

  const [bowlerRanking, setBowlerRanking] =
    useState([]);

  const [overallRanking, setOverallRanking] =
    useState([]);

  // ==========================================
  // LOADING / ERROR
  // ==========================================

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // ==========================================
  // FETCH DASHBOARD DATA
  // ONLY ONCE WHEN PAGE LOADS
  // ==========================================

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      setError("");

      // ========================================
      // FETCH ALL REQUIRED COLLECTIONS
      // ========================================

      const [
        playersSnapshot,
        teamsSnapshot,
        matchesSnapshot,
        inningsSnapshot,
        tournamentsSnapshot,
        battingStatsSnapshot,
        bowlingStatsSnapshot,
      ] = await Promise.all([
        getDocs(collection(db, "players")),
        getDocs(collection(db, "teams")),
        getDocs(collection(db, "matches")),
        getDocs(collection(db, "innings")),
        getDocs(collection(db, "tournaments")),
        getDocs(collection(db, "battingStats")),
        getDocs(collection(db, "bowlingStats")),
      ]);

      // ========================================
      // BASIC COUNTS
      // ========================================

      setPlayerCount(playersSnapshot.size);
      setTeamCount(teamsSnapshot.size);
      setMatchCount(matchesSnapshot.size);
      setInningsCount(inningsSnapshot.size);
      setTournamentCount(tournamentsSnapshot.size);

      // ========================================
      // CREATE PLAYER MAP
      // ========================================

      const playerMap = new Map();

      playersSnapshot.forEach((doc) => {
        const player = doc.data();

        const playerId =
          player.uid ||
          player.id ||
          doc.id;

        playerMap.set(String(playerId), {
          id: String(playerId),
          name: player.name || "Unknown Player",
          email: player.email || "",
        });
      });

      const signedInUser = auth.currentUser;
      const normalizedUid = String(
          signedInUser?.uid || ""
      ).trim();
      const normalizedEmail = String(
          signedInUser?.email || ""
      ).trim().toLowerCase();
      const signedInPlayer =
          [...playerMap.values()].find(
            (player) =>
              String(player.id).trim() === normalizedUid ||
              String(player.email).trim().toLowerCase() === normalizedEmail
          ) || null;

      let savedUser = null;
      try {
          const savedSession =
            localStorage.getItem("cricket_auth_session") ||
            localStorage.getItem("cricket_remembered_auth") ||
            sessionStorage.getItem("cricket_auth_session");
          savedUser = savedSession
            ? JSON.parse(savedSession)
            : null;
      } catch (storageError) {
          console.warn("Unable to read saved player session:", storageError);
      }

      setPlayerName(
          signedInPlayer?.name?.trim() ||
          signedInUser?.displayName?.trim() ||
            savedUser?.name?.trim() ||
            savedUser?.displayName?.trim() ||
            "Player"
      );

      // ========================================
      // BATTING STATISTICS
      // ========================================

      const battingMap = new Map();

      const addBattingStat = (stat, matchId) => {
        if (!stat || typeof stat !== "object") {
          return;
        }

        const playerId =
          stat.playerId ||
          stat.uid ||
          stat.id;

        if (!playerId || !playerMap.has(String(playerId))) {
          return;
        }

        const existing =
          battingMap.get(playerId) || {
            playerId,
            name:
              stat.playerName ||
              playerMap.get(String(playerId))?.name ||
              "Unknown Player",
            runs: 0,
            balls: 0,
            fours: 0,
            sixes: 0,
            matchIds: new Set(),
          };

        existing.runs +=
          Number(stat.runs) || 0;

        existing.balls +=
          Number(stat.balls) || 0;

        existing.fours +=
          Number(stat.fours) || 0;

        existing.sixes +=
          Number(stat.sixes) || 0;
        if (matchId || stat.matchId || stat.matchID) {
          existing.matchIds.add(
            String(matchId || stat.matchId || stat.matchID)
          );
        }

        battingMap.set(
          playerId,
          existing
        );
      };

      // ========================================
      // BOWLING STATISTICS
      // ========================================

      const bowlingMap = new Map();

      const addBowlingStat = (stat, matchId) => {
        if (!stat || typeof stat !== "object") {
          return;
        }

        const playerId =
          stat.playerId ||
          stat.uid ||
          stat.id;

        if (!playerId || !playerMap.has(String(playerId))) {
          return;
        }

        const existing =
          bowlingMap.get(playerId) || {
            playerId,
            name:
              stat.playerName ||
              playerMap.get(String(playerId))?.name ||
              "Unknown Player",
            wickets: 0,
            balls: 0,
            runsConceded: 0,
            maidens: 0,
            wides: 0,
            noBalls: 0,
            matchIds: new Set(),
          };

        existing.wickets +=
          Number(stat.wickets) || 0;

        existing.balls +=
          Number(stat.legalBalls ?? stat.balls) || 0;

        existing.runsConceded +=
          Number(stat.runs ?? stat.runsConceded) || 0;

        existing.maidens +=
          Number(stat.maidens) || 0;

        existing.wides +=
          Number(stat.wides) || 0;

        existing.noBalls +=
          Number(stat.noBalls) || 0;
        if (matchId || stat.matchId || stat.matchID) {
          existing.matchIds.add(
            String(matchId || stat.matchId || stat.matchID)
          );
        }

        bowlingMap.set(
          playerId,
          existing
        );
      };

      const getMatchInnings = (match) => {
        const savedState = match?.scoringState || {};
        const isTestMatch =
          String(match?.matchType || "").toLowerCase() === "test";

        if (isTestMatch) {
          const testInnings =
            Array.isArray(match?.testInnings)
              ? match.testInnings
              : Array.isArray(match?.innings)
                ? match.innings
                : [];

          if (testInnings.length) {
            const currentIndex = Number(savedState.inningsIndex);
            if (
              savedState.battingStats &&
              Number.isInteger(currentIndex) &&
              currentIndex >= 0
            ) {
              return [
                ...testInnings.filter(
                  (inning) => Number(inning?.inningsIndex) !== currentIndex
                ),
                {
                  ...testInnings.find(
                    (inning) => Number(inning?.inningsIndex) === currentIndex
                  ),
                  inningsIndex: currentIndex,
                  battingStats: savedState.battingStats,
                  bowlingStats: savedState.bowlingStats || {},
                  deliveries: savedState.deliveries || [],
                },
              ].sort(
                (left, right) =>
                  Number(left?.inningsIndex || 0) -
                  Number(right?.inningsIndex || 0)
              );
            }
            return testInnings;
          }
        }

        const liveInnings = savedState.battingStats
          ? {
              battingStats: savedState.battingStats,
              bowlingStats: savedState.bowlingStats || {},
            }
          : null;

        const first = match?.firstInningsData ||
          (Number(savedState.inningsIndex) === 0 ? liveInnings : null);
        const second = match?.secondInningsData ||
          (Number(savedState.inningsIndex) === 1 ? liveInnings : null);

        return [first, second].filter(Boolean);
      };

      const matchIdsWithScorecards = new Set();

      matchesSnapshot.forEach((matchDoc) => {
        const match = matchDoc.data() || {};
        const matchId = String(match.matchId || matchDoc.id);
        const innings = getMatchInnings(match);

        if (!innings.length) {
          return;
        }

        matchIdsWithScorecards.add(matchId);

        innings.forEach((inning) => {
          Object.values(inning?.battingStats || {}).forEach((stat) => {
            addBattingStat(stat, matchId);
          });

          Object.values(inning?.bowlingStats || {}).forEach((stat) => {
            addBowlingStat(stat, matchId);
          });
        });
      });

      battingStatsSnapshot.forEach((statDoc) => {
        const stat = statDoc.data() || {};
        const matchId = stat.matchId || stat.matchID;

        if (!matchId || !matchIdsWithScorecards.has(String(matchId))) {
          addBattingStat(stat, matchId);
        }
      });

      bowlingStatsSnapshot.forEach((statDoc) => {
        const stat = statDoc.data() || {};
        const matchId = stat.matchId || stat.matchID;

        if (!matchId || !matchIdsWithScorecards.has(String(matchId))) {
          addBowlingStat(stat, matchId);
        }
      });

      // ========================================
      // BATSMAN RANKING
      //
      // Points = Runs
      // ========================================

      const batsmen = Array.from(
        battingMap.values()
      )
        .map((player) => {
          return {
            ...player,

            points:
              (player.runs / (player.matchIds.size || 1)).toFixed(1),

            strikeRate:
              player.balls > 0
                ? (
                    (player.runs /
                      player.balls) *
                    100
                  ).toFixed(2)
                : "0.00",
          };
        })
        .sort((a, b) => {
          return (
            b.runs - a.runs
          );
        })
        .map((player, index) => {
          return {
            ...player,
            rank: index + 1,
          };
        });

      setBatsmanRanking(
        batsmen
      );

      // ========================================
      // BOWLER RANKING
      //
      // Points = Wickets × 5
      // ========================================

      const bowlers = Array.from(
        bowlingMap.values()
      )
        .map((player) => {
          const overs =
            Math.floor(
              player.balls / 6
            );

          const remainingBalls =
            player.balls % 6;

          const economy =
            player.balls > 0
              ? (
                  (player.runsConceded /
                    player.balls) *
                  6
                ).toFixed(2)
              : "0.00";

          return {
            ...player,

            overs,
            remainingBalls,

            economy,

            points:
              calculateStrengthPoints({
                wickets: player.wickets,
                matchesPlayed: 1,
              }),
          };
        })
        .sort((a, b) => {
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
            Number(a.economy) -
            Number(b.economy)
          );
        })
        .map((player, index) => {
          return {
            ...player,
            rank: index + 1,
          };
        });

      setBowlerRanking(
        bowlers
      );

      // ========================================
      // OVERALL RANKING
      //
      // Strength =
      // Runs + (Wickets × 5)
      // divided by matches played
      // ========================================

      const overallMap = new Map();

      // Add batting information
      battingMap.forEach(
        (player) => {
          overallMap.set(
            player.playerId,
            {
              playerId:
                player.playerId,

              name:
                player.name,

              runs:
                player.runs,

              wickets: 0,
              matchIds: new Set(player.matchIds || []),
            }
          );
        }
      );

      // Add / merge bowling information
      bowlingMap.forEach(
        (player) => {
          const existing =
            overallMap.get(
              player.playerId
            );

          if (existing) {
            existing.wickets =
              player.wickets;
          player.matchIds?.forEach((matchId) =>
            existing.matchIds.add(matchId)
          );
          } else {
            overallMap.set(
              player.playerId,
              {
                playerId:
                  player.playerId,

                name:
                  player.name,

                runs: 0,

                wickets:
                  player.wickets,

                matchIds: new Set(
                  player.matchIds || []
                ),
              }
            );
          }
        }
      );

      const overall = Array.from(
        overallMap.values()
      )
        .map((player) => {
          return {
            ...player,

            points:
              Number(
                calculateStrengthPoints({
                  runs: player.runs,
                  wickets: player.wickets,
                  matchesPlayed: player.matchIds.size || 1,
                }).toFixed(1)
              ),
          };
        })
        .sort((a, b) => {
          return (
            b.points -
            a.points
          );
        })
        .map((player, index) => {
          return {
            ...player,
            rank: index + 1,
          };
        });

      setOverallRanking(
        overall
      );

    } catch (err) {
      console.error(
        "Dashboard Firebase error:",
        err
      );

      setError(
        "Unable to load dashboard data from Firebase."
      );
    } finally {
      setLoading(false);
    }
  };

  // ==========================================
  // CURRENT RANKING
  // ==========================================

  const getCurrentRanking = () => {
    if (
      leaderboardTab ===
      "batsman"
    ) {
      return batsmanRanking;
    }

    if (
      leaderboardTab ===
      "bowler"
    ) {
      return bowlerRanking;
    }

    return overallRanking;
  };

  const currentRanking =
    getCurrentRanking();

  // ==========================================
  // LOADING SCREEN
  // ==========================================

  if (loading) {
    return (
      <div className="page">
        <AdminUndoDelete />
        <LoadingOverlay message="Loading dashboard data..." fullScreen />
      </div>
    );
  }

  // ==========================================
  // DASHBOARD
  // ==========================================

  return (
    <div className="page">
      <AdminUndoDelete />

      {/* ======================================
          WELCOME
      ====================================== */}

      <section className="welcome-section">

        <div>

          <p className="eyebrow">
            WELCOME BACK 
          </p>

          <h2>
           {playerName}
          </h2>

          <p className="subtitle">
            Manage your players, teams
            and local matches.
          </p>

        </div>

        <div className="cricket-ball">
          🏏
        </div>

      </section>


      {/* ======================================
          ERROR
      ====================================== */}

      {error && (
        <div className="empty-card">

          <div className="empty-icon">
            ⚠️
          </div>

          <h3>
            Unable to load data
          </h3>

          <p>
            {error}
          </p>

        </div>
      )}


      {/* ======================================
          STATISTICS
      ====================================== */}

      <section className="stats-grid">

        {/* PLAYERS */}

        <div className="stat-card">

          <div className="stat-icon">
            👤
          </div>

          <div>

            <p>
              Players
            </p>

            <h3>
              {playerCount}
            </h3>

          </div>

        </div>


        {/* TEAMS */}

        <div className="stat-card">

          <div className="stat-icon">
            👥
          </div>

          <div>

            <p>
              Teams
            </p>

            <h3>
              {teamCount}
            </h3>

          </div>

        </div>


        {/* MATCHES */}

        <div className="stat-card">

          <div className="stat-icon">
            🏏
          </div>

          <div>

            <p>
              Matches
            </p>

            <h3>
              {matchCount}
            </h3>

          </div>

        </div>


        {/* INNINGS */}

        <div className="stat-card">

          <div className="stat-icon">
            🏆
          </div>

          <div>

            <p>
              Tournaments 
            </p>

            <h3>
              {tournamentCount}
            </h3>

          </div>

        </div>

      </section>


      {/* ======================================
          PLAYER LEADERBOARD
      ====================================== */}

      <section className="section">

        <div className="section-header">

          <div>
            <h3>
              Player Leaderboard
            </h3>

            <p className="subtitle">
              Overall player performance
            </p>
          </div>

        </div>


        {/* ====================================
            TABS
        ==================================== */}

        <div
          className="leaderboard-tabs"
          style={{
            display: "flex",
            gap: "10px",
            marginBottom: "20px",
            flexWrap: "wrap",
          }}
        >

          <button
            type="button"
            className={
              leaderboardTab ===
              "batsman"
                ? "primary-button"
                : "secondary-button"
            }
            onClick={() =>
              setLeaderboardTab(
                "batsman"
              )
            }
          >
            🏏 Batsman Ranking
          </button>


          <button
            type="button"
            className={
              leaderboardTab ===
              "bowler"
                ? "primary-button"
                : "secondary-button"
            }
            onClick={() =>
              setLeaderboardTab(
                "bowler"
              )
            }
          >
            🎯 Bowler Ranking
          </button>


          <button
            type="button"
            className={
              leaderboardTab ===
              "overall"
                ? "primary-button"
                : "secondary-button"
            }
            onClick={() =>
              setLeaderboardTab(
                "overall"
              )
            }
          >
            🏆 Overall Ranking
          </button>

        </div>


        {/* ====================================
            NO DATA
        ==================================== */}

        {currentRanking.length ===
          0 ? (

          <div className="empty-card">

            <div className="empty-icon">
              🏏
            </div>

            <h3>
              No statistics yet
            </h3>

            <p>
              Player rankings will appear
              here after matches are scored.
            </p>

          </div>

        ) : (

          /* ==================================
             LEADERBOARD TABLE
          ================================== */

          <div
            className="leaderboard-table-container"
            style={{
              width: "100%",
              overflowX: "auto",
            }}
          >

            <table
              className="leaderboard-table"
              style={{
                width: "100%",
                borderCollapse:
                  "collapse",
              }}
            >

              {/* ==============================
                  BATSMAN TABLE
              ============================== */}

              {leaderboardTab ===
                "batsman" && (
                <>

                  <thead>

                    <tr>

                      <th>
                        Rank
                      </th>

                      <th>
                        Name
                      </th>

                      <th>
                        Runs
                      </th>

                      <th>
                        Points
                      </th>

                    </tr>

                  </thead>


                  <tbody>

                    {currentRanking.map(
                      (player) => (
                        <tr
                          key={
                            player.playerId
                          }
                        >

                          <td>
                            #{player.rank}
                          </td>

                          <td>
                            {player.name}
                          </td>

                          <td>
                            {player.runs}
                          </td>

                          <td>
                            {player.points}
                          </td>

                        </tr>
                      )
                    )}

                  </tbody>

                </>
              )}


              {/* ==============================
                  BOWLER TABLE
              ============================== */}

              {leaderboardTab ===
                "bowler" && (
                <>

                  <thead>

                    <tr>

                      <th>
                        Rank
                      </th>

                      <th>
                        Name
                      </th>

                      <th>
                        Wickets
                      </th>

                      <th>
                        Economy
                      </th>

                      <th>
                        Points
                      </th>

                    </tr>

                  </thead>


                  <tbody>

                    {currentRanking.map(
                      (player) => (
                        <tr
                          key={
                            player.playerId
                          }
                        >

                          <td>
                            #{player.rank}
                          </td>

                          <td>
                            {player.name}
                          </td>

                          <td>
                            {player.wickets}
                          </td>

                          <td>
                            {player.economy}
                          </td>

                          <td>
                            {player.points}
                          </td>

                        </tr>
                      )
                    )}

                  </tbody>

                </>
              )}


              {/* ==============================
                  OVERALL TABLE
              ============================== */}

              {leaderboardTab ===
                "overall" && (
                <>

                  <thead>

                    <tr>

                      <th>
                        Rank
                      </th>

                      <th>
                        Name
                      </th>

                      <th>
                        Runs
                      </th>

                      <th>
                        Wickets
                      </th>

                      <th>
                        Strength
                      </th>

                    </tr>

                  </thead>


                  <tbody>

                    {currentRanking.map(
                      (player) => (
                        <tr
                          key={
                            player.playerId
                          }
                        >

                          <td>
                            #{player.rank}
                          </td>

                          <td>
                            {player.name}
                          </td>

                          <td>
                            {player.runs}
                          </td>

                          <td>
                            {player.wickets}
                          </td>

                          <td>
                            {Number(player.points || 0).toFixed(1)}
                          </td>

                        </tr>
                      )
                    )}

                  </tbody>

                </>
              )}

            </table>

          </div>

        )}

      </section>

    </div>
  );
}

export default Dashboard;
