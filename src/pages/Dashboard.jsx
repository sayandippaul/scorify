
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

function Dashboard() {
  // ==========================================
  // DASHBOARD COUNTS
  // ==========================================

  const [playerCount, setPlayerCount] = useState(0);
  const [teamCount, setTeamCount] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [inningsCount, setInningsCount] = useState(0);
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
        battingStatsSnapshot,
        bowlingStatsSnapshot,
      ] = await Promise.all([
        getDocs(collection(db, "players")),
        getDocs(collection(db, "teams")),
        getDocs(collection(db, "matches")),
        getDocs(collection(db, "innings")),
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

        playerMap.set(playerId, {
          id: playerId,
          name: player.name || "Unknown Player",
          email: player.email || "",
        });
      });

      const signedInUser = auth.currentUser;
      const signedInPlayer =
        signedInUser &&
        playerMap.get(
          signedInUser.uid
        );

      setPlayerName(
        signedInPlayer?.name?.trim() ||
          signedInUser?.displayName?.trim() ||
          "Player"
      );

      // ========================================
      // BATTING STATISTICS
      // ========================================

      const battingMap = new Map();

      battingStatsSnapshot.forEach((doc) => {
        const stat = doc.data();

        const playerId =
          stat.playerId ||
          stat.uid;

        if (!playerId) {
          return;
        }

        const existing =
          battingMap.get(playerId) || {
            playerId,
            name:
              stat.playerName ||
              playerMap.get(playerId)?.name ||
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
        if (stat.matchId || stat.matchID) {
          existing.matchIds.add(
            String(stat.matchId || stat.matchID)
          );
        }

        battingMap.set(
          playerId,
          existing
        );
      });

      // ========================================
      // BOWLING STATISTICS
      // ========================================

      const bowlingMap = new Map();

      bowlingStatsSnapshot.forEach((doc) => {
        const stat = doc.data();

        const playerId =
          stat.playerId ||
          stat.uid;

        if (!playerId) {
          return;
        }

        const existing =
          bowlingMap.get(playerId) || {
            playerId,
            name:
              stat.playerName ||
              playerMap.get(playerId)?.name ||
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
          Number(stat.balls) || 0;

        existing.runsConceded +=
          Number(stat.runsConceded) || 0;

        existing.maidens +=
          Number(stat.maidens) || 0;

        existing.wides +=
          Number(stat.wides) || 0;

        existing.noBalls +=
          Number(stat.noBalls) || 0;
        if (stat.matchId || stat.matchID) {
          existing.matchIds.add(
            String(stat.matchId || stat.matchID)
          );
        }

        bowlingMap.set(
          playerId,
          existing
        );
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
      // Points = Wickets × 20
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
              player.wickets * 20,
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
      // Runs + (Wickets × 20)
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
                (
                  (player.runs +
                    player.wickets * 20) /
                  (player.matchIds.size || 1)
                ).toFixed(1)
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

        <section className="welcome-section">
          <div>
            <p className="eyebrow">
              WELCOME BACK 
            </p>

            <h2>
              {playerName}
            </h2>

            <p className="subtitle">
              Loading dashboard data...
            </p>
          </div>

          <div className="cricket-ball">
            🏏
          </div>
        </section>

      </div>
    );
  }

  // ==========================================
  // DASHBOARD
  // ==========================================

  return (
    <div className="page">

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

            <small>
              {/* {inningsCount} */}
              coming soon
            </small>

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
