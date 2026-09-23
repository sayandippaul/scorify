import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";

import { db, auth } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";
import { calculateStrengthPoints } from "../services/playerStrength";
import LoadingOverlay from "../components/LoadingOverlay";
import { saveLastAdminDelete } from "../services/adminUndoService";
import "./teams.css";
/* =========================================================
   CONSTANTS
========================================================= */

const TEAM_TYPES = [
  "Local Team",
  "Club Team",
  "School Team",
  "College Team",
  "Other",
];

const emptyTeamForm = {
  name: "",
  type: "Local Team",
  players: [],
};

/* =========================================================
   SAFE HELPERS
========================================================= */

/*
  Firebase data may sometimes contain:
  name
  playerName
  teamName
  or no name at all.

  Never directly do:
  value.charAt(0)

  Use this helper instead.
*/
const getInitial = (value) => {
  const safeValue =
    typeof value === "string" &&
    value.trim()
      ? value.trim()
      : "Player";

  return safeValue
    .charAt(0)
    .toUpperCase();
};

const getSafeName = (
  primary,
  secondary = "Unknown Player"
) => {
  if (
    typeof primary === "string" &&
    primary.trim()
  ) {
    return primary.trim();
  }

  if (
    typeof secondary === "string" &&
    secondary.trim()
  ) {
    return secondary.trim();
  }

  return "Unknown Player";
};

/* =========================================================
   COMPONENT
========================================================= */

function Teams() {
  const [searchParams] = useSearchParams();
  const tournamentId = searchParams.get("tournamentId");
  // =========================================================
  // USER / ADMIN
  // =========================================================

  const currentUser =
    auth.currentUser;

  const isAdmin =
    currentUser?.uid ===
    ADMIN_UID;

  // =========================================================
  // DATA
  // =========================================================

  const [teams, setTeams] =
    useState([]);

  const [players, setPlayers] =
    useState([]);

  const [teamPlayers, setTeamPlayers] =
    useState([]);

  const [battingStats, setBattingStats] =
    useState([]);

  const [bowlingStats, setBowlingStats] =
    useState([]);

  const [matches, setMatches] =
    useState([]);
  const [tournamentTeams, setTournamentTeams] =
    useState([]);

  const [loading, setLoading] =
    useState(true);

  const [savingTeam, setSavingTeam] =
    useState(false);

  // =========================================================
  // UI STATES
  // =========================================================

  const [showCreateModal, setShowCreateModal] =
    useState(false);

  const [showTeamModal, setShowTeamModal] =
    useState(false);

  const [showDeleteModal, setShowDeleteModal] =
    useState(false);

  const [showComparison, setShowComparison] =
    useState(false);

  const [selectedTeam, setSelectedTeam] =
    useState(null);

  const [deleteTeam, setDeleteTeam] =
    useState(null);

  const [search, setSearch] =
    useState("");

  const [form, setForm] =
    useState(emptyTeamForm);

  // =========================================================
  // COMPARISON
  // =========================================================

  const [teamAId, setTeamAId] =
    useState("");

  const [teamBId, setTeamBId] =
    useState("");

  // =========================================================
  // LOAD FIRESTORE DATA
  // =========================================================

  const loadData = async () => {
    try {
      setLoading(true);

      const [
        teamsSnapshot,
        playersSnapshot,
        teamPlayersSnapshot,
        battingSnapshot,
        bowlingSnapshot,
        matchesSnapshot,
      ] = await Promise.all([
        getDocs(
          collection(
            db,
            "teams"
          )
        ),

        getDocs(
          collection(
            db,
            "players"
          )
        ),

        getDocs(
          collection(
            db,
            "teamPlayers"
          )
        ),

        getDocs(
          collection(
            db,
            "battingStats"
          )
        ),

        getDocs(
          collection(
            db,
            "bowlingStats"
          )
        ),

        getDocs(
          collection(
            db,
            "matches"
          )
        ),
      ]);

      const loadedTeams =
        teamsSnapshot.docs.map(
          (item) => ({
            id: item.id,
            ...item.data(),
          })
        );

      const loadedPlayers =
        playersSnapshot.docs.map(
          (item) => ({
            id: item.id,
            ...item.data(),
          })
        );

      const loadedTeamPlayers =
        teamPlayersSnapshot.docs.map(
          (item) => ({
            id: item.id,
            ...item.data(),
          })
        );

      const loadedBattingStats =
        battingSnapshot.docs.map(
          (item) => ({
            id: item.id,
            ...item.data(),
          })
        );

      const loadedBowlingStats =
        bowlingSnapshot.docs.map(
          (item) => ({
            id: item.id,
            ...item.data(),
          })
        );

      const loadedMatches =
        matchesSnapshot.docs.map(
          (item) => ({
            id: item.id,
            ...item.data(),
          })
        );

      setTeams(
        loadedTeams
      );

      setPlayers(
        loadedPlayers
      );

      setTeamPlayers(
        loadedTeamPlayers
      );

      setBattingStats(
        loadedBattingStats
      );

      setBowlingStats(
        loadedBowlingStats
      );

      setMatches(
        loadedMatches
      );

      if (tournamentId) {
        const tournamentSnapshot = await getDoc(
          doc(db, "tournaments", tournamentId)
        );
        const tournamentTeamsData = tournamentSnapshot.exists()
          ? (tournamentSnapshot.data().teams || []).map((team) => ({
              ...team,
              teamId: team.id,
              players: (team.players || []).map((player) =>
                loadedPlayers.find((item) => String(item.id) === String(player.id || player.uid)) || player
              ),
            }))
          : [];
        setTournamentTeams(tournamentTeamsData);
      } else {
        setTournamentTeams([]);
      }
    } catch (error) {
      console.error(
        "Error loading teams data:",
        error
      );

      alert(
        error?.message ||
          "Failed to load teams."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [tournamentId]);

  const visibleTeams = tournamentId ? tournamentTeams : teams;

  // =========================================================
  // PLAYER LOOKUP
  // =========================================================

  const getPlayerById = (
    playerId
  ) => {
    if (
      playerId === undefined ||
      playerId === null
    ) {
      return null;
    }

    return players.find(
      (player) =>
        String(player.id) ===
        String(playerId)
    );
  };

  // =========================================================
  // GET TEAM MEMBERS
  // =========================================================

  const getTeamPlayers = (
    team
  ) => {
    if (!team) {
      return [];
    }

    const teamId =
      team.id ||
      team.teamId;

    // -------------------------------------------------------
    // NEW FIRESTORE TEAM PLAYERS STRUCTURE
    // -------------------------------------------------------

    const memberships =
      teamPlayers.filter(
        (item) => {
          if (
            String(item.teamId) !== String(teamId)
          ) {
            return false;
          }

          const savedPlayerIds = Array.isArray(team.playerIds)
            ? team.playerIds.map(String)
            : null;

          return !savedPlayerIds ||
            savedPlayerIds.includes(
              String(item.playerId || item.uid)
            );
        }
      );

    if (
      memberships.length > 0
    ) {
      return Array.from(
        new Map(
          memberships.map((membership) => [
            String(
              membership.playerId ||
                membership.uid ||
                membership.id
            ),
            membership,
          ])
        ).values()
      )
        .map(
          (membership) => {
            const player =
              getPlayerById(
                membership.playerId
              );

            /*
              If player still exists in players
              collection, combine current player
              data with membership snapshot.
            */

            if (player) {
              return {
                ...player,
                ...membership,

                id:
                  player.id ||
                  membership.playerId,

                playerId:
                  player.id ||
                  membership.playerId,

                name:
                  getSafeName(
                    player.name,
                    membership.playerName
                  ),

                type:
                  player.type ||
                  membership.role ||
                  "Player",
              };
            }

            /*
              Player may have been deleted from
              players collection.
            */

            return {
              ...membership,

              id:
                membership.playerId ||
                membership.id,

              playerId:
                membership.playerId,

              name:
                getSafeName(
                  membership.playerName
                ),

              type:
                membership.role ||
                "Player",
            };
          }
        )
        .filter(Boolean);
    }

    // -------------------------------------------------------
    // BACKWARD COMPATIBILITY
    // OLD teams.players STRUCTURE
    // -------------------------------------------------------

    if (
      Array.isArray(
        team.players
      )
    ) {
      return team.players
        .map(
          (playerItem) => {
            /*
              Old data may contain:
              ["uid1", "uid2"]

              or:
              [{ id: "uid1", name: "..." }]
            */

            if (
              typeof playerItem ===
              "object" &&
              playerItem !== null
            ) {
              const playerId =
                playerItem.playerId ||
                playerItem.id ||
                playerItem.uid;

              const currentPlayer =
                getPlayerById(
                  playerId
                );

              if (
                currentPlayer
              ) {
                return {
                  ...currentPlayer,
                  ...playerItem,

                  id:
                    currentPlayer.id,

                  playerId:
                    currentPlayer.id,

                  name:
                    getSafeName(
                      currentPlayer.name,
                      playerItem.name ||
                        playerItem.playerName
                    ),

                  type:
                    currentPlayer.type ||
                    playerItem.type ||
                    playerItem.role ||
                    "Player",
                };
              }

              return {
                ...playerItem,

                id:
                  playerId,

                playerId,

                name:
                  getSafeName(
                    playerItem.name ||
                      playerItem.playerName
                  ),

                type:
                  playerItem.type ||
                  playerItem.role ||
                  "Player",
              };
            }

            const player =
              getPlayerById(
                playerItem
              );

            return player
              ? {
                  ...player,
                  id: player.id,
                  playerId: player.id,
                  name:
                    getSafeName(
                      player.name
                    ),
                }
              : null;
          }
        )
        .filter(Boolean);
    }

    return [];
  };

  // =========================================================
  // PLAYER RANKING POINTS
  // =========================================================

  const getPlayerRankingPoints = (
    player,
    teamId = null
  ) => {
    if (!player) {
      return 0;
    }

    const playerId =
      player.playerId ||
      player.id ||
      player.uid;

    if (
      playerId === undefined ||
      playerId === null
    ) {
      return 0;
    }

    // -------------------------------------------------------
    // BATTING RUNS
    // -------------------------------------------------------

    const playerBattingStats =
      battingStats.filter(
        (stat) => {
          const samePlayer =
            String(
              stat.playerId
            ) ===
            String(playerId);

          const sameTeam = true;

          return (
            samePlayer &&
            sameTeam
          );
        }
      );

    const totalRuns =
      playerBattingStats.reduce(
        (
          sum,
          stat
        ) =>
          sum +
          Number(
            stat.runs || 0
          ),
        0
      );

    // -------------------------------------------------------
    // BOWLING WICKETS
    // -------------------------------------------------------

    const playerBowlingStats =
      bowlingStats.filter(
        (stat) => {
          const samePlayer =
            String(
              stat.playerId
            ) ===
            String(playerId);

          const sameTeam = true;

          return (
            samePlayer &&
            sameTeam
          );
        }
      );

    const totalWickets =
      playerBowlingStats.reduce(
        (
          sum,
          stat
        ) =>
          sum +
          Number(
            stat.wickets || 0
          ),
        0
      );

    // -------------------------------------------------------
    // POINTS
    // -------------------------------------------------------

    const playerMatchIds = new Set(
      [...playerBattingStats, ...playerBowlingStats]
        .map((stat) => stat.matchId || stat.matchID || stat.id)
        .filter(Boolean)
        .map(String)
    );
    const matchesPlayed =
      playerMatchIds.size ||
      Number(
        player.matchesPlayed ||
          player.matches ||
          0
      );

    return matchesPlayed > 0
      ? calculateStrengthPoints({
          runs: totalRuns,
          wickets: totalWickets,
          matchesPlayed,
        })
      : 0;
  };

  // =========================================================
  // PLAYER STRENGTH
  // =========================================================

  const calculatePlayerStrength = (
    player,
    teamId = null
  ) => {
    return getPlayerRankingPoints(
      player,
      teamId
    );
  };

  const formatStrength = (value) =>
    Number(value || 0).toFixed(1);

  // =========================================================
  // TEAM STRENGTH
  // =========================================================

  const calculateTeamStrength = (
    team
  ) => {
    const teamMembers =
      getTeamPlayers(
        team
      );

    if (
      teamMembers.length ===
      0
    ) {
      return 0;
    }

    const totalPoints =
      teamMembers.reduce(
        (
          sum,
          player
        ) =>
          sum +
          calculatePlayerStrength(
            player,
            team.id ||
              team.teamId
          ),
        0
      );

    return Math.round(
      totalPoints /
        teamMembers.length
    );
  };

  // =========================================================
  // TEAM ANALYSIS
  // =========================================================

  const getTeamAnalysis = (
    team
  ) => {
    const teamMembers =
      getTeamPlayers(
        team
      );

    const batsmen =
      teamMembers.filter(
        (player) =>
          player.type ===
            "Batsman" ||
          player.type ===
            "All-rounder" ||
          player.type ===
            "Wicketkeeper"
      );

    const bowlers =
      teamMembers.filter(
        (player) =>
          player.type ===
            "Bowler" ||
          player.type ===
            "All-rounder"
      );

    const wicketkeepers =
      teamMembers.filter(
        (player) =>
          player.type ===
          "Wicketkeeper"
      );

    const allRounders =
      teamMembers.filter(
        (player) =>
          player.type ===
          "All-rounder"
      );

    return {
      batsmen,
      bowlers,
      wicketkeepers,
      allRounders,
      total:
        teamMembers.length,
    };
  };

  // =========================================================
  // CREATE TEAM MODAL
  // =========================================================

  const openCreateModal = () => {
    setForm({
      ...emptyTeamForm,
      players: [],
    });

    setSearch("");

    setShowCreateModal(
      true
    );
  };

  const closeCreateModal = () => {
    setShowCreateModal(
      false
    );

    setForm({
      ...emptyTeamForm,
      players: [],
    });

    setSearch("");
  };

  // =========================================================
  // FORM CHANGE
  // =========================================================

  const handleFormChange = (
    event
  ) => {
    const {
      name,
      value,
    } = event.target;

    setForm(
      (previous) => ({
        ...previous,
        [name]: value,
      })
    );
  };

  // =========================================================
  // PLAYER SELECTION
  // =========================================================

  const togglePlayer = (
    playerId
  ) => {
    setForm(
      (previous) => {
        const exists =
          previous.players.some(
            (id) =>
              String(id) ===
              String(playerId)
          );

        return {
          ...previous,

          players: exists
            ? previous.players.filter(
                (id) =>
                  String(id) !==
                  String(playerId)
              )
            : [
                ...previous.players,
                playerId,
              ],
        };
      }
    );
  };

  // =========================================================
  // CREATE TEAM
  // =========================================================

  const handleCreateTeam = async (
    event
  ) => {
    event.preventDefault();

    const teamName =
      String(
        form.name || ""
      ).trim();

    if (!teamName) {
      alert(
        "Please enter team name."
      );
      return;
    }

    const normalizedTeamName = teamName
      .replace(/\s+/g, " ")
      .toLowerCase();

    const duplicateTeam = teams.some(
      (team) =>
        String(
          team.name ||
            team.teamName ||
            ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .toLowerCase() ===
        normalizedTeamName
    );

    if (duplicateTeam) {
      alert(
        "A team with this name already exists."
      );
      return;
    }

    if (
      !Array.isArray(
        form.players
      ) ||
      form.players.length ===
        0
    ) {
      alert(
        "Please add at least one player."
      );
      return;
    }

    /*
      Get current Firebase user again
      so we don't rely only on the
      render-time variable.
    */

    const firebaseUser =
      auth.currentUser;

    if (!firebaseUser) {
      alert(
        "Please login first."
      );
      return;
    }

    try {
      setSavingTeam(true);

      // -------------------------------------------------------
      // CREATE TEAM REFERENCE
      // -------------------------------------------------------

      const teamRef =
        doc(
          collection(
            db,
            "teams"
          )
        );

      const teamId =
        teamRef.id;
      const selectedPlayerIds = Array.from(
        new Set(
          form.players
            .map((playerId) => String(playerId))
            .filter(Boolean)
        )
      );

      // -------------------------------------------------------
      // CREATE ONE BATCH
      // -------------------------------------------------------

      /*
        IMPORTANT:
        Previously the team was added to a
        writeBatch but that batch was never
        committed.

        Now the team and teamPlayers are
        committed together.
      */

      const batch =
        writeBatch(db);

      // -------------------------------------------------------
      // TEAM DOCUMENT
      // -------------------------------------------------------

      batch.set(
        teamRef,
        {
          teamId,

          id: teamId,

          teamName:
            teamName,

          name:
            teamName,

          type:
            form.type,

          captainId:
            null,

          captainName:
            null,

          playerIds:
            selectedPlayerIds,

          players:
            selectedPlayerIds,

          createdBy:
            firebaseUser.uid,

          createdAt:
            serverTimestamp(),

          updatedAt:
            serverTimestamp(),
        }
      );

      // -------------------------------------------------------
      // TEAM PLAYER DOCUMENTS
      // -------------------------------------------------------

      selectedPlayerIds.forEach(
        (playerId) => {
          const player =
            getPlayerById(
              playerId
            );

          if (!player) {
            return;
          }

          const membershipRef =
            doc(
              db,
              "teamPlayers",
              `${teamId}_${String(player.id)}`
            );

          batch.set(
            membershipRef,
            {
              teamPlayerId:
                membershipRef.id,

              teamId,

              teamName:
                teamName,

              playerId:
                player.id,

              playerName:
                getSafeName(
                  player.name
                ),

              playerEmail:
                player.email ||
                "",

              role:
                player.type ||
                "Player",

              battingPosition:
                player.battingPosition ||
                null,

              battingHand:
                player.battingHand ||
                null,

              bowlingHand:
                player.bowlingHand ||
                null,

              bowlingStyle:
                player.bowlingStyle ||
                null,

              joinedAt:
                serverTimestamp(),
            }
          );
        }
      );

      // -------------------------------------------------------
      // COMMIT EVERYTHING
      // -------------------------------------------------------

      await batch.commit();

      closeCreateModal();

      await loadData();

      alert(
        "Team created successfully."
      );
    } catch (error) {
      console.error(
        "Create team error:",
        error
      );

      alert(
        error?.message ||
          "Failed to create team."
      );
    } finally {
      setSavingTeam(false);
    }
  };

  // =========================================================
  // DELETE TEAM
  // =========================================================

  const confirmDeleteTeam = (
    team
  ) => {
    if (!isAdmin) {
      return;
    }

    setDeleteTeam(
      team
    );

    setShowDeleteModal(
      true
    );
  };

  const handleDeleteTeam =
    async () => {
      if (!deleteTeam) {
        return;
      }

      if (!isAdmin) {
        return;
      }

      try {
        await saveLastAdminDelete({
          type: "team",
          documents: [
            {
              collection: "teams",
              id: deleteTeam.id || deleteTeam.teamId,
              data: deleteTeam,
            },
            ...memberships.map((membership) => ({
              collection: "teamPlayers",
              id: membership.id || membership.teamPlayerId,
              data: membership,
            })),
          ],
        });

        const batch =
          writeBatch(db);

        // -----------------------------------------------------
        // DELETE TEAM
        // -----------------------------------------------------

        batch.delete(
          doc(
            db,
            "teams",
            String(
              deleteTeam.id ||
                deleteTeam.teamId
            )
          )
        );

        // -----------------------------------------------------
        // DELETE TEAM MEMBERSHIPS
        // -----------------------------------------------------

        const memberships =
          teamPlayers.filter(
            (item) =>
              String(
                item.teamId
              ) ===
              String(
                deleteTeam.id ||
                  deleteTeam.teamId
              )
          );

        memberships.forEach(
          (membership) => {
            batch.delete(
              doc(
                db,
                "teamPlayers",
                String(
                  membership.id ||
                    membership.teamPlayerId
                )
              )
            );
          }
        );

        await batch.commit();

        // -----------------------------------------------------
        // RESET COMPARISON
        // -----------------------------------------------------

        if (
          String(teamAId) ===
          String(
            deleteTeam.id ||
              deleteTeam.teamId
          )
        ) {
          setTeamAId("");
        }

        if (
          String(teamBId) ===
          String(
            deleteTeam.id ||
              deleteTeam.teamId
          )
        ) {
          setTeamBId("");
        }

        // -----------------------------------------------------
        // CLOSE DELETE MODAL
        // -----------------------------------------------------

        setDeleteTeam(
          null
        );

        setShowDeleteModal(
          false
        );

        // -----------------------------------------------------
        // CLOSE TEAM VIEW
        // -----------------------------------------------------

        if (
          selectedTeam &&
          String(
            selectedTeam.id ||
              selectedTeam.teamId
          ) ===
            String(
              deleteTeam.id ||
                deleteTeam.teamId
            )
        ) {
          setSelectedTeam(
            null
          );

          setShowTeamModal(
            false
          );
        }

        await loadData();

        alert(
          "Team deleted successfully."
        );
      } catch (error) {
        console.error(
          "Delete team error:",
          error
        );

        alert(
          error?.message ||
            "Failed to delete team."
        );
      }
    };

  // =========================================================
  // REMOVE PLAYER FROM TEAM
  // =========================================================

  const removePlayerFromTeam =
    async (
      team,
      playerId
    ) => {
      if (!team) {
        return;
      }

      try {
        const teamId =
          team.id ||
          team.teamId;

        const membership =
          teamPlayers.find(
            (item) =>
              String(
                item.teamId
              ) ===
                String(teamId) &&
              String(
                item.playerId
              ) ===
                String(playerId)
          );

        if (membership) {
          await deleteDoc(
            doc(
              db,
              "teamPlayers",
              String(
                membership.id ||
                  membership.teamPlayerId
              )
            )
          );
        }

        // -----------------------------------------------------
        // BACKWARD COMPATIBILITY
        // OLD teams.players
        // -----------------------------------------------------

        if (
          Array.isArray(
            team.players
          )
        ) {
          const updatedPlayers =
            team.players.filter(
              (item) => {
                const id =
                  typeof item ===
                    "object" &&
                  item !== null
                    ? item.playerId ||
                      item.id ||
                      item.uid
                    : item;

                return (
                  String(id) !==
                  String(playerId)
                );
              }
            );

          await updateDoc(
            doc(
              db,
              "teams",
              String(teamId)
            ),
            {
              players:
                updatedPlayers,

              playerIds:
                updatedPlayers,

              updatedAt:
                serverTimestamp(),
            }
          );
        }

        await loadData();

        const updatedTeam =
          teams.find(
            (item) =>
              String(
                item.id ||
                  item.teamId
              ) ===
              String(teamId)
          );

        if (updatedTeam) {
          setSelectedTeam(
            updatedTeam
          );
        }
      } catch (error) {
        console.error(
          "Remove player error:",
          error
        );

        alert(
          error?.message ||
            "Failed to remove player."
        );
      }
    };

  // =========================================================
  // SEARCH PLAYERS
  // =========================================================

  const filteredPlayers =
    useMemo(() => {
      const text =
        String(
          search || ""
        )
          .trim()
          .toLowerCase();

      if (!text) {
        return players;
      }

      return players.filter(
        (player) =>
          String(
            player.name || ""
          )
            .toLowerCase()
            .includes(text) ||
          String(
            player.email || ""
          )
            .toLowerCase()
            .includes(text) ||
          String(
            player.type || ""
          )
            .toLowerCase()
            .includes(text)
      );
    }, [
      players,
      search,
    ]);

  // =========================================================
  // SELECTED TEAMS
  // =========================================================

  const teamA =
    teams.find(
      (team) =>
        String(
          team.id ||
            team.teamId
        ) ===
        String(teamAId)
    ) || null;

  const teamB =
    teams.find(
      (team) =>
        String(
          team.id ||
            team.teamId
        ) ===
        String(teamBId)
    ) || null;

  // =========================================================
  // TEAM COMPARISON DATA
  // =========================================================

  const comparisonData =
    useMemo(() => {
      if (
        !teamA ||
        !teamB ||
        String(teamA.id || teamA.teamId) ===
          String(teamB.id || teamB.teamId)
      ) {
        return null;
      }

      const playersA =
        getTeamPlayers(
          teamA
        );

      const playersB =
        getTeamPlayers(
          teamB
        );

      const analysisA =
        getTeamAnalysis(
          teamA
        );

      const analysisB =
        getTeamAnalysis(
          teamB
        );

      const strengthA =
        calculateTeamStrength(
          teamA
        );

      const strengthB =
        calculateTeamStrength(
          teamB
        );

      // -------------------------------------------------------
      // HEAD TO HEAD
      // -------------------------------------------------------

      const teamARealId =
        teamA.id ||
        teamA.teamId;

      const teamBRealId =
        teamB.id ||
        teamB.teamId;

      const teamAComparisonName = getSafeName(
        teamA.name || teamA.teamName,
        ""
      ).trim().toLowerCase();
      const teamBComparisonName = getSafeName(
        teamB.name || teamB.teamName,
        ""
      ).trim().toLowerCase();

      const headToHead =
        matches.filter(
          (match) => {
            const matchTeamAId = String(
              match.teamAId ||
                match.teamA?.id ||
                ""
            );
            const matchTeamBId = String(
              match.teamBId ||
                match.teamB?.id ||
                ""
            );
            const matchTeamAName = String(
              match.teamAName ||
                match.teamA?.name ||
                ""
            ).trim().toLowerCase();
            const matchTeamBName = String(
              match.teamBName ||
                match.teamB?.name ||
                ""
            ).trim().toLowerCase();

            const sameTeam = (
              sideId,
              sideName,
              selectedId,
              selectedName
            ) =>
              (sideId &&
                sideId === String(selectedId)) ||
              (sideName &&
                sideName === selectedName);

            const normalOrder =
              sameTeam(
                matchTeamAId,
                matchTeamAName,
                teamARealId,
                teamAComparisonName
              ) &&
              sameTeam(
                matchTeamBId,
                matchTeamBName,
                teamBRealId,
                teamBComparisonName
              );

            const reverseOrder =
              sameTeam(
                matchTeamAId,
                matchTeamAName,
                teamBRealId,
                teamBComparisonName
              ) &&
              sameTeam(
                matchTeamBId,
                matchTeamBName,
                teamARealId,
                teamAComparisonName
              );

            return (
              normalOrder ||
              reverseOrder
            );
          }
        );

      let teamAWins = 0;

      let teamBWins = 0;

      let draws = 0;

      headToHead.forEach(
        (match) => {
          const winnerId =
            match.winnerId ||
            match.result?.winnerId ||
            match.result?.winnerTeamId;
          const winnerName = String(
            match.winnerName ||
            match.winner ||
            match.result?.winner ||
            match.result?.winnerName ||
            ""
          ).trim().toLowerCase();
          const resultText = String(
            match.result?.text ||
              match.resultText ||
              match.result ||
              ""
          ).trim().toLowerCase();
          const winnerSide =
            String(winnerId || "").toUpperCase();
          const matchTeamAId = String(
            match.teamAId || match.teamA?.id || ""
          );
          const matchTeamBId = String(
            match.teamBId || match.teamB?.id || ""
          );
          const matchTeamAName = String(
            match.teamAName || match.teamA?.name || ""
          ).trim().toLowerCase();
          const matchTeamBName = String(
            match.teamBName || match.teamB?.name || ""
          ).trim().toLowerCase();
          const matchHasTeamA = (
            matchTeamAId === String(teamARealId) ||
            matchTeamAName === teamAComparisonName
          );
          const matchHasTeamB = (
            matchTeamBId === String(teamBRealId) ||
            matchTeamBName === teamBComparisonName
          );
          const matchHasTeamAAsB = (
            matchTeamBId === String(teamARealId) ||
            matchTeamBName === teamAComparisonName
          );
          const matchHasTeamBAsA = (
            matchTeamAId === String(teamBRealId) ||
            matchTeamAName === teamBComparisonName
          );
          const winnerIsTeamA =
            (winnerSide === "A" && matchHasTeamA) ||
            (winnerSide === "B" && matchHasTeamAAsB);
          const winnerIsTeamB =
            (winnerSide === "B" && matchHasTeamB) ||
            (winnerSide === "A" && matchHasTeamBAsA);

          if (
            resultText.includes("tie") ||
            resultText.includes("draw") ||
            String(
              match.result?.winner ||
                match.result?.text ||
                ""
            ).toLowerCase().includes("match drawn")
          ) {
            draws++;
            return;
          }

          if (
            !winnerId &&
            !winnerName &&
            !resultText
          ) {
            return;
          }

          if (
            String(
              winnerId
            ) ===
            String(
              teamARealId
            ) ||
            winnerName === teamAComparisonName ||
            (winnerIsTeamA &&
              String(match.teamAId || match.teamA?.id || "") ===
                String(teamARealId)) ||
            resultText.includes(
              `${teamAComparisonName} won`
            )
          ) {
            teamAWins++;
          }

          if (
            String(
              winnerId
            ) ===
            String(
              teamBRealId
            ) ||
            winnerName === teamBComparisonName ||
            (winnerIsTeamB &&
              String(match.teamBId || match.teamB?.id || "") ===
                String(teamBRealId)) ||
            resultText.includes(
              `${teamBComparisonName} won`
            )
          ) {
            teamBWins++;
          }
        }
      );

      return {
        playersA,
        playersB,

        analysisA,
        analysisB,

        strengthA,
        strengthB,

        headToHead,

        teamAWins,
        teamBWins,
        draws,
      };
    }, [
      teamA,
      teamB,
      teams,
      players,
      teamPlayers,
      battingStats,
      bowlingStats,
      matches,
    ]);

  // =========================================================
  // FORMAT DATE
  // =========================================================

  const formatDate = (
    value
  ) => {
    if (!value) {
      return "—";
    }

    try {
      const date =
        value?.toDate
          ? value.toDate()
          : new Date(value);

      if (
        Number.isNaN(
          date.getTime()
        )
      ) {
        return "—";
      }

      return date.toLocaleDateString(
        "en-IN",
        {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }
      );
    } catch {
      return "—";
    }
  };

  // =========================================================
  // PLAYER SKILLS
  // =========================================================

  const getPlayerSkills = (
    player
  ) => {
    if (!player) {
      return [];
    }

    const skills = [];

    const type =
      player.type ||
      player.role ||
      "";

    if (
      type ===
      "Batsman"
    ) {
      skills.push(
        "Batsman"
      );
    }

    if (
      type ===
      "Bowler"
    ) {
      skills.push(
        "Bowler"
      );
    }

    if (
      type ===
      "All-rounder"
    ) {
      skills.push(
        "Batsman",
        "Bowler"
      );
    }

    if (
      type ===
      "Wicketkeeper"
    ) {
      skills.push(
        "Wicketkeeper"
      );
    }

    if (
      skills.length ===
      0
    ) {
      skills.push(
        type || "Player"
      );
    }

    return [
      ...new Set(
        skills
      ),
    ];
  };

  // =========================================================
  // RENDER PLAYER CARD
  // =========================================================

  const renderPlayerCard = (
    player,
    teamId
  ) => {
    const points =
      calculatePlayerStrength(
        player,
        teamId
      );

    const skills =
      getPlayerSkills(
        player
      );

    const playerName =
      getSafeName(
        player?.name ||
          player?.playerName
      );

    return (
      <div
        className="team-player-profile-card"
        key={
          player?.id ||
          player?.playerId ||
          `${teamId}-${playerName}`
        }
      >
        <div className="team-player-profile-left">

          <div className="team-player-avatar">
            {getInitial(
              playerName
            )}
          </div>

          <div className="team-player-profile-info">

            <h4>
              {playerName}
            </h4>

            <div className="team-player-skills">

              {skills.map(
                (skill) => (
                  <span
                    key={skill}
                    className="skill-badge"
                  >
                    {skill}
                  </span>
                )
              )}

            </div>

            <div className="team-player-details-line">

              {player.battingHand && (
                <span>
                  🏏{" "}
                  {player.battingHand}{" "}
                  Hand
                </span>
              )}

              {player.battingPosition && (
                <span>
                  {
                    player.battingPosition
                  }
                </span>
              )}

              {player.bowlingHand && (
                <span>
                  ⚾{" "}
                  {player.bowlingHand}{" "}
                  Hand
                </span>
              )}

              {player.bowlingStyle && (
                <span>
                  {
                    player.bowlingStyle
                  }
                </span>
              )}

            </div>

          </div>
        </div>

        <div className="team-player-ranking">

          <strong>
            {formatStrength(points)}
          </strong>

          <span>
            Player Strength
          </span>

        </div>
      </div>
    );
  };

  // =========================================================
  // LOADING
  // =========================================================

  if (loading) {
    return (
      <div className="page teams-page">
        <LoadingOverlay message="Fetching teams and player statistics..." fullScreen />
      </div>
    );
  }

  // =========================================================
  // FULL COMPARISON DASHBOARD
  // =========================================================

  if (
    showComparison &&
    comparisonData &&
    teamA &&
    teamB
  ) {
    const teamAName =
      getSafeName(
        teamA.name ||
          teamA.teamName,
        "Team A"
      );

    const teamBName =
      getSafeName(
        teamB.name ||
          teamB.teamName,
        "Team B"
      );

    return (
      <div className="page teams-page team-comparison-dashboard">

        {/* ===================================================
            DASHBOARD HEADER
        =================================================== */}

        <div className="comparison-dashboard-header">

          <button
            type="button"
            className="comparison-back-button"
            onClick={() =>
              setShowComparison(
                false
              )
            }
          >
            ← Back to Teams
          </button>

          <div>

            <p className="eyebrow">
              TEAM ANALYTICS
            </p>

            <h2>
              Team Comparison
            </h2>

            <p className="subtitle">
              Detailed squad,
              strength and
              head-to-head analysis.
            </p>

          </div>

        </div>

        {/* ===================================================
            TEAM OVERVIEW
        =================================================== */}

        <section className="comparison-overview-grid">

          {/* TEAM A */}

          <div className="comparison-overview-team">

            <div className="comparison-dashboard-logo">
              {getInitial(
                teamAName
              )}
            </div>

            <p>
              {teamA.type ||
                "Team"}
            </p>

            <h3>
              {teamAName}
            </h3>

            <strong>
              {formatStrength(comparisonData.strengthA)}
            </strong>

            <span>
              Average Ranking Points
            </span>

          </div>

          {/* CENTER */}

          <div className="comparison-overview-center">

            <div className="head-to-head-badge">
              HEAD TO HEAD
            </div>

            <strong>
              {
                comparisonData
                  .headToHead
                  .length
              }
            </strong>

            <span>
              Matches Played
            </span>

            <div className="head-to-head-record">

              <div>
                <strong>
                  {
                    comparisonData.teamAWins
                  }
                </strong>

                <span>
                  {teamAName} Wins
                </span>
              </div>

              <div>
                <strong>
                  {
                    comparisonData.draws
                  }
                </strong>

                <span>
                  Draws / Ties
                </span>
              </div>

              <div>
                <strong>
                  {
                    comparisonData.teamBWins
                  }
                </strong>

                <span>
                  {teamBName} Wins
                </span>
              </div>

            </div>

          </div>

          {/* TEAM B */}

          <div className="comparison-overview-team">

            <div className="comparison-dashboard-logo">
              {getInitial(
                teamBName
              )}
            </div>

            <p>
              {teamB.type ||
                "Team"}
            </p>

            <h3>
              {teamBName}
            </h3>

            <strong>
              {formatStrength(comparisonData.strengthB)}
            </strong>

            <span>
              Average Ranking Points
            </span>

          </div>

        </section>

        {/* ===================================================
            SQUAD SUMMARY
        =================================================== */}

        <section className="comparison-summary-section">

          <div className="section-header">

            <div>

              <p className="eyebrow">
                SQUAD BREAKDOWN
              </p>

              <h3>
                Team Composition
              </h3>

            </div>

          </div>

          <div className="comparison-summary-grid">

            {/* PLAYERS */}

            <div className="comparison-summary-card">

              <span>
                👥
              </span>

              <div>

                <small>
                  Players
                </small>

                <div className="summary-values">

                  <strong>
                    {
                      comparisonData
                        .playersA
                        .length
                    }
                  </strong>

                  <span>
                    vs
                  </span>

                  <strong>
                    {
                      comparisonData
                        .playersB
                        .length
                    }
                  </strong>

                </div>

              </div>

            </div>

            {/* BATSMEN */}

            <div className="comparison-summary-card">

              <span>
                🏏
              </span>

              <div>

                <small>
                  Batsmen
                </small>

                <div className="summary-values">

                  <strong>
                    {
                      comparisonData
                        .analysisA
                        .batsmen
                        .length
                    }
                  </strong>

                  <span>
                    vs
                  </span>

                  <strong>
                    {
                      comparisonData
                        .analysisB
                        .batsmen
                        .length
                    }
                  </strong>

                </div>

              </div>

            </div>

            {/* BOWLERS */}

            <div className="comparison-summary-card">

              <span>
                ⚾
              </span>

              <div>

                <small>
                  Bowlers
                </small>

                <div className="summary-values">

                  <strong>
                    {
                      comparisonData
                        .analysisA
                        .bowlers
                        .length
                    }
                  </strong>

                  <span>
                    vs
                  </span>

                  <strong>
                    {
                      comparisonData
                        .analysisB
                        .bowlers
                        .length
                    }
                  </strong>

                </div>

              </div>

            </div>

            {/* ALL ROUNDERS */}

            <div className="comparison-summary-card">

              <span>
                🔄
              </span>

              <div>

                <small>
                  All-rounders
                </small>

                <div className="summary-values">

                  <strong>
                    {
                      comparisonData
                        .analysisA
                        .allRounders
                        .length
                    }
                  </strong>

                  <span>
                    vs
                  </span>

                  <strong>
                    {
                      comparisonData
                        .analysisB
                        .allRounders
                        .length
                    }
                  </strong>

                </div>

              </div>

            </div>

            {/* WICKETKEEPERS */}

            <div className="comparison-summary-card">

              <span>
                🧤
              </span>

              <div>

                <small>
                  Wicketkeepers
                </small>

                <div className="summary-values">

                  <strong>
                    {
                      comparisonData
                        .analysisA
                        .wicketkeepers
                        .length
                    }
                  </strong>

                  <span>
                    vs
                  </span>

                  <strong>
                    {
                      comparisonData
                        .analysisB
                        .wicketkeepers
                        .length
                    }
                  </strong>

                </div>

              </div>

            </div>

          </div>

        </section>

        {/* ===================================================
            PLAYER COMPARISON
        =================================================== */}

        <section className="comparison-players-section">

          <div className="section-header">

            <div>

              <p className="eyebrow">
                PLAYER RANKINGS
              </p>

              <h3>
                Squad Strength
              </h3>

            </div>

          </div>

          <div className="comparison-player-columns">

            {/* =================================================
                TEAM A
            ================================================= */}

            <div className="comparison-player-column">

              <div className="comparison-column-header">

                <div className="comparison-small-logo">
                  {getInitial(
                    teamAName
                  )}
                </div>

                <div>

                  <h3>
                    {teamAName}
                  </h3>

                  <span>
                    {
                      comparisonData
                        .playersA
                        .length
                    }{" "}
                    players
                  </span>

                </div>

                <strong>
                  {formatStrength(comparisonData.strengthA)}
                </strong>

              </div>

              <div className="comparison-player-list">

                {comparisonData.playersA
                  .length ===
                0 ? (
                  <div className="comparison-empty">
                    No players found.
                  </div>
                ) : (
                  comparisonData
                    .playersA
                    .slice()
                    .sort(
                      (a, b) =>
                        calculatePlayerStrength(
                          b,
                          teamA.id ||
                            teamA.teamId
                        ) -
                        calculatePlayerStrength(
                          a,
                          teamA.id ||
                            teamA.teamId
                        )
                    )
                    .map(
                      (
                        player
                      ) =>
                        renderPlayerCard(
                          player,
                          teamA.id ||
                            teamA.teamId
                        )
                    )
                )}

              </div>

            </div>

            {/* =================================================
                TEAM B
            ================================================= */}

            <div className="comparison-player-column">

              <div className="comparison-column-header">

                <div className="comparison-small-logo">
                  {getInitial(
                    teamBName
                  )}
                </div>

                <div>

                  <h3>
                    {teamBName}
                  </h3>

                  <span>
                    {
                      comparisonData
                        .playersB
                        .length
                    }{" "}
                    players
                  </span>

                </div>

                <strong>
                  {formatStrength(comparisonData.strengthB)}
                </strong>

              </div>

              <div className="comparison-player-list">

                {comparisonData.playersB
                  .length ===
                0 ? (
                  <div className="comparison-empty">
                    No players found.
                  </div>
                ) : (
                  comparisonData
                    .playersB
                    .slice()
                    .sort(
                      (a, b) =>
                        calculatePlayerStrength(
                          b,
                          teamB.id ||
                            teamB.teamId
                        ) -
                        calculatePlayerStrength(
                          a,
                          teamB.id ||
                            teamB.teamId
                        )
                    )
                    .map(
                      (
                        player
                      ) =>
                        renderPlayerCard(
                          player,
                          teamB.id ||
                            teamB.teamId
                        )
                    )
                )}

              </div>

            </div>

          </div>

        </section>

      </div>
    );
  }

  // =========================================================
  // MAIN TEAMS PAGE
  // =========================================================

  return (
    <div className="page teams-page">

      {/* =====================================================
          HEADER
      ===================================================== */}

      <div className="page-header">

        <div>

          <p className="eyebrow">
            TEAM MANAGEMENT
          </p>

          <h2>
            Teams
          </h2>

          <p className="subtitle">
            Create teams, manage
            players and compare
            squads.
          </p>

        </div>

        <button
          type="button"
          className="add-button"
          onClick={
            openCreateModal
          }
        >
          ＋Create Team
          
        </button>

      </div>

      {/* =====================================================
          TEAM LIST
      ===================================================== */}

      {visibleTeams.length ===
      0 ? (
        <div className="empty-card">

          <div className="empty-icon">
            👥
          </div>

          <h3>
            No teams yet
          </h3>

          <p>
            Create your first team
            and add players from
            your player database.
          </p>

          <button
            type="button"
            className="primary-button"
            onClick={
              openCreateModal
            }
          >
            ＋ Create Team
          </button>

        </div>
      ) : (
        <section className="section">

          <div className="section-header">

            <div>

              <h3>
                Your Teams
              </h3>

              <span>
                {visibleTeams.length}{" "}
                {visibleTeams.length ===
                1
                  ? "team"
                  : "teams"}
              </span>

            </div>

          </div>

          <div className="teams-list">

            {visibleTeams.map(
              (team) => {
                const teamMembers =
                  getTeamPlayers(
                    team
                  );

                const strength =
                  calculateTeamStrength(
                    team
                  );

                const analysis =
                  getTeamAnalysis(
                    team
                  );

                const teamName =
                  getSafeName(
                    team.name ||
                      team.teamName,
                    "Unnamed Team"
                  );

                return (
                  <div
                    className="team-card"
                    key={
                      team.id ||
                      team.teamId
                    }
                  >

                    <div className="team-card-top">

                      <div className="team-logo">
                        {getInitial(
                          teamName
                        )}
                      </div>

                      <div className="team-main-info">

                        <h3>
                          {teamName}
                        </h3>

                        <span className="team-type">
                          {team.type ||
                            "Team"}
                        </span>

                      </div>

                      <div className="team-strength-mini">

                        <strong>
                          {formatStrength(strength)}
                        </strong>

                        <small>
                          Avg Points
                        </small>

                      </div>

                    </div>

                    <div className="team-progress">

                      <div
                        className="team-progress-fill"
                        style={{
                          width: `${Math.min(
                            strength,
                            100
                          )}%`,
                        }}
                      />

                    </div>

                    <div className="team-mini-stats">

                      <span>
                        👥{" "}
                        {
                          teamMembers.length
                        }
                      </span>

                      <span>
                        🏏{" "}
                        {
                          analysis
                            .batsmen
                            .length
                        }
                      </span>

                      <span>
                        ⚾{" "}
                        {
                          analysis
                            .bowlers
                            .length
                        }
                      </span>

                      <span>
                        🔄{" "}
                        {
                          analysis
                            .allRounders
                            .length
                        }
                      </span>

                      <span>
                        🧤{" "}
                        {
                          analysis
                            .wicketkeepers
                            .length
                        }
                      </span>

                    </div>

                    <div className="team-card-bottom">

                      <span>
                        👥{" "}
                        {
                          teamMembers.length
                        }{" "}
                        players
                      </span>

                      <div className="team-actions">

                        {/* VIEW FOR EVERYONE */}

                        <button
                          type="button"
                          className="view-button"
                          onClick={() => {
                            setSelectedTeam(
                              team
                            );

                            setShowTeamModal(
                              true
                            );
                          }}
                        >
                          View
                        </button>

                        {/* DELETE ONLY ADMIN */}

                        {isAdmin && (
                          <button
                            type="button"
                            className="delete-button"
                            onClick={() =>
                              confirmDeleteTeam(
                                team
                              )
                            }
                          >
                            🗑
                          </button>
                        )}

                      </div>

                    </div>

                  </div>
                );
              }
            )}

          </div>

        </section>
      )}

      {/* =====================================================
          COMPARE TEAMS
      ===================================================== */}

      {visibleTeams.length >=
        2 && (
        <section className="comparison-section">

          <div className="section-header">

            <div>

              <p className="eyebrow">
                TEAM ANALYTICS
              </p>

              <h3>
                Compare Two Teams
              </h3>

              <span>
                Open detailed squad
                comparison dashboard.
              </span>

            </div>

          </div>

          <div className="comparison-selectors">

            <div className="comparison-select">

              <label>
                Team A
              </label>

              <select
                value={teamAId}
                onChange={(event) =>
                  setTeamAId(
                    event.target.value === String(teamBId)
                      ? ""
                      : event.target.value
                  )
                }
              >

                <option value="">
                  Select Team A
                </option>

                {visibleTeams.map(
                  (team) => (
                    <option
                      key={
                        team.id ||
                        team.teamId
                      }
                      value={
                        team.id ||
                        team.teamId
                      }
                      disabled={
                        String(
                          team.id ||
                            team.teamId
                        ) === String(teamBId)
                      }
                    >
                      {getSafeName(
                        team.name ||
                          team.teamName,
                        "Unnamed Team"
                      )}
                    </option>
                  )
                )}

              </select>

            </div>

            <div className="vs-badge">
              VS
            </div>

            <div className="comparison-select">

              <label>
                Team B
              </label>

              <select
                value={teamBId}
                onChange={(event) =>
                  setTeamBId(
                    event.target.value === String(teamAId)
                      ? ""
                      : event.target.value
                  )
                }
              >

                <option value="">
                  Select Team B
                </option>

                {visibleTeams.map(
                  (team) => (
                    <option
                      key={
                        team.id ||
                        team.teamId
                      }
                      value={
                        team.id ||
                        team.teamId
                      }
                      disabled={
                        String(
                          team.id ||
                            team.teamId
                        ) === String(teamAId)
                      }
                    >
                      {getSafeName(
                        team.name ||
                          team.teamName,
                        "Unnamed Team"
                      )}
                    </option>
                  )
                )}

              </select>

            </div>

          </div>

          {teamA &&
            teamB && (
              <div className="comparison-ready-card">
<div style={{"height":"20px"}}></div>
                {/* <div>

                  <strong>
                    {getSafeName(
                      teamA.name ||
                        teamA.teamName,
                      "Team A"
                    )}
                  </strong>

                  <span>
                    {
                      calculateTeamStrength(
                        teamA
                      )
                    }{" "}
                    average points
                  </span>

                </div>

                <div className="comparison-ready-vs">
                  VS
                </div>

                <div>

                  <strong>
                    {getSafeName(
                      teamB.name ||
                        teamB.teamName,
                      "Team B"
                    )}
                  </strong>

                  <span>
                    {
                      calculateTeamStrength(
                        teamB
                      )
                    }{" "}
                    average points
                  </span>

                </div> */}

                <button
                  type="button"
                  className="primary-button"
                  onClick={() =>
                    setShowComparison(
                      true
                    )
                  }
                >
                  Open Full Comparison →
                </button>

              </div>
            )}

        </section>
      )}

      {/* =====================================================
          CREATE TEAM MODAL
      ===================================================== */}

      {showCreateModal && (
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              closeCreateModal();
            }
          }}
        >

          <div className="modal team-create-modal">

            <div className="modal-header">

              <div>

                <p className="eyebrow">
                  TEAM
                </p>

                <h3>
                  Create Team
                </h3>

              </div>

              <button
                type="button"
                className="modal-close"
                onClick={
                  closeCreateModal
                }
              >
                ×
              </button>

            </div>

            <form
              onSubmit={
                handleCreateTeam
              }
            >

              {/* TEAM NAME */}

              <div className="form-group">

                <label>
                  Team name{" "}
                  <span className="required">
                    *
                  </span>
                </label>

                <input
                  type="text"
                  name="name"
                  value={
                    form.name
                  }
                  onChange={
                    handleFormChange
                  }
                  placeholder="Example: KGEC Warriors"
                />

              </div>

              {/* TEAM TYPE */}

              <div className="form-group">

                <label>
                  Team type
                </label>

                <select
                  name="type"
                  value={
                    form.type
                  }
                  onChange={
                    handleFormChange
                  }
                >

                  {TEAM_TYPES.map(
                    (type) => (
                      <option
                        key={type}
                        value={type}
                      >
                        {type}
                      </option>
                    )
                  )}

                </select>

              </div>

              {/* PLAYERS */}

              <div className="form-section">

                <div className="player-selection-header">

                  <div>

                    <h4>
                      Add Players
                    </h4>

                    <p>
                      {
                        form.players
                          .length
                      }{" "}
                      selected
                    </p>

                  </div>

                </div>

                {players.length ===
                0 ? (
                  <div className="no-players-message">

                    <span>
                      👤
                    </span>

                    <p>
                      No players
                      available.
                      Create
                      players
                      first from
                      the Players
                      section.
                    </p>

                  </div>
                ) : (
                  <>

                    <div className="search-box team-player-search">

                      <span>
                        🔍
                      </span>

                      <input
                        type="text"
                        placeholder="Search players..."
                        value={
                          search
                        }
                        onChange={(
                          event
                        ) =>
                          setSearch(
                            event.target
                              .value
                          )
                        }
                      />

                    </div>

                    <div className="player-selection-list">

                      {filteredPlayers.map(
                        (player) => {
                          const playerId =
                            player.id ||
                            player.uid;

                          const playerName =
                            getSafeName(
                              player.name,
                              "Unknown Player"
                            );

                          const selected =
                            form.players.some(
                              (id) =>
                                String(
                                  id
                                ) ===
                                String(
                                  playerId
                                )
                            );

                          return (
                            <button
                              type="button"
                              key={
                                playerId
                              }
                              className={
                                selected
                                  ? "select-player-row selected"
                                  : "select-player-row"
                              }
                              onClick={() =>
                                togglePlayer(
                                  playerId
                                )
                              }
                            >

                              <div className="small-player-avatar">

                                {getInitial(
                                  playerName
                                )}

                              </div>

                              <div className="select-player-info">

                                <strong>
                                  {
                                    playerName
                                  }
                                </strong>

                                <span>
                                  {
                                    player.type ||
                                    "Player"
                                  }
                                </span>

                              </div>

                              <div
                                className={
                                  selected
                                    ? "player-check checked"
                                    : "player-check"
                                }
                              >
                                {selected
                                  ? "✓"
                                  : "+"}
                              </div>

                            </button>
                          );
                        }
                      )}

                    </div>

                    <div className="both-team-info">

                      <span>
                        🔄
                      </span>

                      <p>

                        <strong>
                          Players can
                          play for
                          multiple
                          teams.
                        </strong>{" "}

                        Selecting a
                        player here
                        does not remove
                        them from
                        another team.

                      </p>

                    </div>

                  </>
                )}

              </div>

              <button
                type="submit"
                className="primary-button"
                disabled={
                  savingTeam
                }
              >
                {savingTeam
                  ? "Creating Team..."
                  : "Create Team"}
              </button>

            </form>

          </div>

        </div>
      )}

      {/* =====================================================
          VIEW TEAM MODAL
      ===================================================== */}

      {showTeamModal &&
        selectedTeam && (
          <div
            className="modal-overlay"
            onMouseDown={(event) => {
              if (
                event.target ===
                event.currentTarget
              ) {
                setShowTeamModal(
                  false
                );
              }
            }}
          >

            <div className="modal team-details-modal">

              <div className="modal-header">

                <div className="team-detail-heading">

                  <div className="large-team-logo">

                    {getInitial(
                      getSafeName(
                        selectedTeam.name ||
                          selectedTeam.teamName,
                        "Unnamed Team"
                      )
                    )}

                  </div>

                  <div>

                    <p className="eyebrow">
                      TEAM PROFILE
                    </p>

                    <h3>
                      {getSafeName(
                        selectedTeam.name ||
                          selectedTeam.teamName,
                        "Unnamed Team"
                      )}
                    </h3>

                    <span>
                      {
                        selectedTeam.type ||
                        "Team"
                      }
                    </span>

                  </div>

                </div>

                <button
                  type="button"
                  className="modal-close"
                  onClick={() =>
                    setShowTeamModal(
                      false
                    )
                  }
                >
                  ×
                </button>

              </div>

              {/* TEAM STRENGTH */}

              <div className="team-detail-strength">

                <div>

                  <span>
                    Average Player
                    Ranking
                  </span>

                  <strong>
                    {formatStrength(
                      calculateTeamStrength(
                        selectedTeam
                      )
                    )}
                  </strong>

                </div>

                <div className="team-progress">

                  <div
                    className="team-progress-fill"
                    style={{
                      width: `${Math.min(
                        calculateTeamStrength(
                          selectedTeam
                        ),
                        100
                      )}%`,
                    }}
                  />

                </div>

              </div>

              {/* PLAYER LIST */}

              <div className="details-section">

                <div className="player-list-heading">

                  <h4>
                    Players & Skills
                  </h4>

                  <span>
                    {
                      getTeamPlayers(
                        selectedTeam
                      ).length
                    }
                  </span>

                </div>

                <div className="team-detail-player-list">

                  {getTeamPlayers(
                    selectedTeam
                  ).length ===
                  0 ? (
                    <div className="comparison-empty">
                      No players in this
                      team.
                    </div>
                  ) : (
                    getTeamPlayers(
                      selectedTeam
                    )
                      .slice()
                      .sort(
                        (a, b) =>
                          calculatePlayerStrength(
                            b,
                            selectedTeam.id ||
                              selectedTeam.teamId
                          ) -
                          calculatePlayerStrength(
                            a,
                            selectedTeam.id ||
                              selectedTeam.teamId
                          )
                      )
                      .map(
                        (
                          player
                        ) =>
                          renderPlayerCard(
                            player,
                            selectedTeam.id ||
                              selectedTeam.teamId
                          )
                      )
                  )}

                </div>

              </div>

              <button
                type="button"
                className="secondary-button full-button"
                onClick={() =>
                  setShowTeamModal(
                    false
                  )
                }
              >
                Close
              </button>

            </div>

          </div>
        )}

      {/* =====================================================
          DELETE TEAM MODAL
      ===================================================== */}

      {showDeleteModal &&
        deleteTeam &&
        isAdmin && (
          <div className="modal-overlay">

            <div className="modal delete-modal">

              <div className="delete-icon">
                🗑
              </div>

              <h3>
                Delete team?
              </h3>

              <p>

                Are you sure you
                want to delete{" "}

                <strong>
                  {getSafeName(
                    deleteTeam.name ||
                      deleteTeam.teamName,
                    "this team"
                  )}
                </strong>
                ?

              </p>

              <div className="delete-actions">

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    setShowDeleteModal(
                      false
                    );

                    setDeleteTeam(
                      null
                    );
                  }}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="danger-button"
                  onClick={
                    handleDeleteTeam
                  }
                >
                  Delete
                </button>

              </div>

            </div>

          </div>
        )}

    </div>
  );
}

export default Teams;