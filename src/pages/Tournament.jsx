import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase/firebase";
import { auth } from "../firebase/firebase";
import { ADMIN_UID } from "../config/security";
import { deleteTournamentCascade } from "../services/matchService";
import {
  createTournament,
  calculateTournamentStandings,
  calculateTournamentStatistics,
  getTournamentMatches,
  getCurrentTournamentUser,
  subscribeToTournaments,
  syncTournamentStructure,
  validateTournamentSetup,
  TOURNAMENT_TEAM_COUNTS,
} from "../services/tournamentService";
import "./tournament.css";

const emptyTeams = (count) =>
  Array.from({ length: count }, (_, index) => ({
    name: `Team ${index + 1}`,
    playerIds: [],
    players: [],
  }));

const tournamentMatchLabel = (match) => {
  const type = String(match?.tournamentMatchType || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const superOverNumber = Number(match?.tournamentSuperOverNumber || 0);
  const semiFinalNumber = String(
    match?.tournamentBaseMatchId ||
    match?.tournamentParentMatchId ||
    match?.id ||
    ""
  ).match(/-semi-(\d+)(?:-|$)/i)?.[1];
  if (type.includes("semi") && type.includes("super over")) {
    return `Semi Final ${semiFinalNumber || 1} Super Over ${superOverNumber || 1}`;
  }
  if (type.includes("final") && type.includes("super over")) {
    return `Final Super Over ${superOverNumber || 1}`;
  }
  if (type === "semi final" || type === "semifinal") {
    return `Semi Final ${semiFinalNumber || 1}`;
  }
  if (type === "league") return "League Match";
  return type.replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Match";
};

function Tournament() {
  const navigate = useNavigate();
  const [tournaments, setTournaments] = useState([]);
  const [players, setPlayers] = useState([]);
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [teamCount, setTeamCount] = useState(3);
  const [teams, setTeams] = useState(emptyTeams(3));
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [panel, setPanel] = useState(null);
  const [selectedMatches, setSelectedMatches] = useState([]);
  const statusSyncRef = useRef(new Set());
  const canSyncTournament = (tournament) => {
    const uid = String(auth.currentUser?.uid || "");
    return Boolean(uid) && (
      uid === String(tournament?.createdBy || "") ||
      (Boolean(ADMIN_UID) && uid === String(ADMIN_UID))
    );
  };
  const sortedTournaments = useMemo(
    () => [...tournaments].sort(
      (left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)
    ),
    [tournaments]
  );

  useEffect(() => {
    const unsubscribe = subscribeToTournaments(setTournaments, (loadError) => {
      console.error("Unable to load tournaments:", loadError);
      setError("Unable to load tournaments.");
    });
    getDocs(collection(db, "players"))
      .then((snapshot) => setPlayers(snapshot.docs.map((item) => ({ id: item.id, uid: item.id, ...item.data() }))))
      .catch((loadError) => console.error("Unable to load tournament players:", loadError));
    return unsubscribe;
  }, []);

  useEffect(() => {
    tournaments.forEach((tournament) => {
      if (statusSyncRef.current.has(tournament.id)) return;
      statusSyncRef.current.add(tournament.id);
      getTournamentMatches(tournament.id)
        .then((matches) => canSyncTournament(tournament)
          ? syncTournamentStructure(tournament, matches)
          : tournament)
        .catch((loadError) => console.error("Unable to refresh tournament status:", loadError));
    });
  }, [tournaments]);

  const openCreate = () => {
    setCreating(true);
    setStep(1);
    setName("");
    setTeamCount(3);
    setTeams(emptyTeams(3));
    setError("");
  };

  const changeTeamCount = (value) => {
    const count = Number(value);
    setTeamCount(count);
    setTeams(emptyTeams(count));
    setStep(1);
  };

  const assignedTeam = (playerId) =>
    teams.findIndex((team) => team.playerIds.includes(String(playerId)));

  const assignPlayer = (player, teamIndex) => {
    const playerId = String(player.id || player.uid);
    setTeams((current) => current.map((team, index) => {
      const withoutPlayer = {
        ...team,
        playerIds: team.playerIds.filter((id) => id !== playerId),
        players: team.players.filter((item) => String(item.id || item.uid) !== playerId),
      };
      if (index !== Number(teamIndex) || team.playerIds.includes(playerId)) return withoutPlayer;
      if (team.playerIds.length >= 11) return team;
      return { ...withoutPlayer, playerIds: [...withoutPlayer.playerIds, playerId], players: [...withoutPlayer.players, player] };
    }));
  };

  const removePlayer = (playerId) =>
    setTeams((current) => current.map((team) => ({
      ...team,
      playerIds: team.playerIds.filter((id) => id !== String(playerId)),
      players: team.players.filter((item) => String(item.id || item.uid) !== String(playerId)),
    })));

  const confirmTeams = async () => {
    const validation = validateTournamentSetup({ name, teamCount, teams });
    if (!validation.valid) {
      setError(validation.errors.join(" "));
      alert(validation.errors.join("\n"));
      return;
    }
    try {
      const user = getCurrentTournamentUser();
      await createTournament({
        name: validation.name,
        teams,
        createdBy: user?.uid,
        createdByUser: { uid: user?.uid || null, name: user?.displayName || user?.email || "" },
        adminUid: ADMIN_UID || null,
      });
      setCreating(false);
      setError("");
    } catch (creationError) {
      console.error("Unable to create tournament:", creationError);
      setError("Unable to create tournament.");
    }
  };

  const showPanel = async (tournament, nextPanel) => {
    setSelected(tournament);
    setPanel(nextPanel);
    if (nextPanel === "matches" || nextPanel === "table" || nextPanel === "statistics") {
      try {
        const matches = await getTournamentMatches(tournament.id);
        const refreshed = canSyncTournament(tournament)
          ? await syncTournamentStructure(tournament, matches)
          : tournament;
        setSelected(refreshed);
        setSelectedMatches(matches);
      } catch (loadError) {
        console.error("Unable to load tournament matches:", loadError);
        setError("Unable to load tournament matches.");
      }
    }
  };

  const standings = useMemo(
    () => (selected ? calculateTournamentStandings(selected, selectedMatches) : []),
    [selected, selectedMatches]
  );
  const statistics = useMemo(
    () => (selected ? calculateTournamentStatistics(selectedMatches, players) : null),
    [selected, selectedMatches, players]
  );
  const standingsByGroup = useMemo(() => {
    if (!selected) return [];
    const groups = selected.groups?.length
      ? selected.groups
      : [{ id: "A", name: "Group A", teamIds: selected.teams?.map((team) => team.id) || [] }];
    return groups.map((group) => ({
      ...group,
      rows: standings.filter((item) => item.groupId === group.id),
    }));
  }, [selected, standings]);
  const qualifierCount = selected?.groups?.length === 2
    ? 2
    : Number(selected?.teamCount || selected?.teams?.length || 0) === 5
      ? 3
      : 2;
  const isAdmin = Boolean(ADMIN_UID) && String(auth.currentUser?.uid || "") === String(ADMIN_UID);
  const deleteTournament = async (tournament) => {
    if (!isAdmin || !window.confirm(`Delete ${tournament.name} and all tournament data?`)) return;
    try {
      setTournaments((current) => current.filter((item) => item.id !== tournament.id));
      setSelected((current) => current?.id === tournament.id ? null : current);
      setPanel((current) => selected?.id === tournament.id ? null : current);
      await deleteTournamentCascade(tournament.id, auth.currentUser?.uid || ADMIN_UID);
    } catch (deleteError) {
      console.error("Unable to delete tournament:", deleteError);
      alert(deleteError.message || "Unable to delete tournament.");
      // Restore the tournament in the list when the delete request is rejected.
      setTournaments((current) =>
        current.some((item) => item.id === tournament.id) ? current : [...current, tournament]
      );
    }
  };

  return (
    <div className="page tournaments-page">
      <div className="tournaments-header">
        <div>
          <p className="eyebrow">SCORIFY TOURNAMENTS</p>
          <h2>Tournaments</h2>
          <p className="subtitle">Create competitions from your existing teams and players.</p>
        </div>
        <button type="button" className="primary-button" onClick={openCreate}>＋ Create Tournament</button>
      </div>

      {error && <div className="tournament-error">{error}</div>}
      {!tournaments.length && <div className="empty-card"><h3>No tournaments yet.</h3><button type="button" className="secondary-button" onClick={openCreate}>Create Tournament</button></div>}
      <div className="tournament-grid">
        {sortedTournaments.map((tournament) => (
          <article className="tournament-card" key={tournament.id}>
            <div className="tournament-card-heading"><div><h3>{tournament.name}</h3><span>{tournament.teamCount} Teams</span></div><strong>{tournament.status === "FINISHED" ? "FINISHED" : "LIVE"}</strong></div>
            <p className="tournament-card-date">{new Date(tournament.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>
            {tournament.status === "FINISHED" && (
              <p className="tournament-winner-banner" aria-label={`Winner: ${tournament.winnerName || "Unknown"}`}>
                <span className="tournament-winner-trophy" aria-hidden="true">🏆</span>
                <span className="tournament-winner-copy">
                  <small>Winner Declared</small>
                  <strong>{tournament.winnerName || "Unknown"}</strong>
                </span>
                <span className="tournament-winner-sparkle" aria-hidden="true">✨</span>
              </p>
            )}
            <div className="tournament-actions">
              <button type="button" onClick={() => navigate(`/matches?tournamentId=${encodeURIComponent(tournament.id)}`)}>View Matches</button>
              <button type="button" onClick={() => showPanel(tournament, "statistics")}>View Statistics</button>
              <button type="button" onClick={() => navigate(`/teams?tournamentId=${encodeURIComponent(tournament.id)}`)}>View Teams</button>
              <button type="button" onClick={() => showPanel(tournament, "table")}>View Table</button>
              {isAdmin && <button type="button" className="tournament-delete-button" onClick={() => deleteTournament(tournament)}>Delete Tournament</button>}
            </div>
          </article>
        ))}
      </div>

      {selected && panel && (
        <div className="tournament-modal-backdrop tournament-details-backdrop" role="dialog" aria-modal="true">
        <section className="tournament-panel tournament-details-modal">
          <div className="tournament-panel-heading"><h3>{selected.name}</h3><button type="button" className="tournament-back-button" onClick={() => { setSelected(null); setPanel(null); }}>Close</button></div>
          {panel === "teams" && <div className="tournament-team-list">{selected.teams.map((team) => <div key={team.id}><strong>{team.name}</strong><span>{team.players.length} / 11 players</span><small>{team.players.map((player) => player.name).join(", ")}</small></div>)}</div>}
          {panel === "table" && (
            <div className={`tournament-tables-grid tournament-tables-count-${standingsByGroup.length}`}>
              {standingsByGroup.map((group) => (
                <div className="tournament-table-wrap" key={group.id}>
                  <h4>{group.name}</h4>
                  <table>
                    <thead><tr><th>Rank</th><th>Team</th><th>MP</th><th>W</th><th>L</th><th>D</th><th>Pts</th><th>NRR</th></tr></thead>
                    <tbody>
                      {group.rows.map((item, index) => (
                        <tr className={index === qualifierCount - 1 ? "qualifier-cutoff-row" : ""} key={item.teamId}>
                          <td>{index + 1}</td>
                          <td>{item.teamName}</td>
                          <td>{item.matchesPlayed}</td>
                          <td>{item.wins}</td>
                          <td>{item.losses}</td>
                          <td>{item.draws}</td>
                          <td>{item.points}</td>
                          <td>{item.nrr >= 0 ? "+" : ""}{item.nrr.toFixed(3)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
          {panel === "statistics" && (
            <div className="tournament-statistics">
              <p><strong>🏏 Highest Batsman Score</strong><span>{statistics?.highestBatsman ? `${statistics.highestBatsman.player} — ${statistics.highestBatsman.value} runs` : "No completed matches yet."}</span></p>
              <p><strong>🎯 Highest Bowler Wickets</strong><span>{statistics?.highestBowler ? `${statistics.highestBowler.player} — ${statistics.highestBowler.value} wickets` : "No completed matches yet."}</span></p>
              <p><strong>📊 Highest Match Innings Score</strong><span>{statistics?.highestInningsScore ? `${statistics.highestInningsScore.runs} runs — ${statistics.highestInningsScore.team || "Unknown team"}` : "No completed matches yet."}</span></p>
              <p><strong>📈 Per Innings Average Score</strong><span>{statistics?.averageInningsScore ? `${statistics.averageInningsScore.toFixed(2)} runs` : "No completed matches yet."}</span></p>
            </div>
          )}
          {panel === "matches" && <div className="tournament-match-list">{selectedMatches.map((match) => { const creator = String(getCurrentTournamentUser()?.uid || "") === String(selected.createdBy); const started = ["live", "finished", "completed", "unfinished"].includes(String(match.status).toLowerCase()); return <div key={match.id}><span><strong>{tournamentMatchLabel(match)}</strong><br />{match.teamAName || "TBD"} vs {match.teamBName || "TBD"}</span><div>{!started && creator && match.teamAName && match.teamBName && <button type="button" onClick={() => navigate(`/matches?tournamentId=${selected.id}&fixtureId=${match.id}`)}>Start This Match</button>}<button type="button" disabled={!started} onClick={() => navigate(`/matches/${match.id}/scorecard`)}>View Scorecard</button></div></div>; })}</div>}
        </section>
        </div>
      )}

      {creating && <div className="tournament-modal-backdrop"><div className="tournament-modal">
        <div className="tournament-panel-heading"><h3>Create Tournament</h3><button type="button" className="tournament-back-button" onClick={() => setCreating(false)}>Back</button></div>
        {step === 1 && <><label>Tournament Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Number of Teams<select value={teamCount} onChange={(event) => changeTeamCount(event.target.value)}>{TOURNAMENT_TEAM_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}</select></label><button type="button" className="primary-button" onClick={() => name.trim() ? setStep(2) : alert("Tournament name is required.")}>Next</button></>}
        {step === 2 && <><div className="tournament-team-form">{teams.map((team, index) => <label key={index}>Team {index + 1}<input value={team.name} onChange={(event) => setTeams((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label>)}</div><button type="button" className="primary-button" onClick={() => { const names = teams.map((team) => team.name.trim().toLowerCase()); if (teams.some((team) => !team.name.trim())) { setError("Every team must have a name."); alert("Every team must have a name."); } else if (new Set(names).size !== names.length) { setError("Team names must be unique."); alert("Team names must be unique."); } else { setError(""); setStep(3); } }}>Continue</button></>}
        {step === 3 && <><div className="tournament-assignment-list">{players.map((player) => { const playerId = String(player.id || player.uid); const teamIndex = assignedTeam(playerId); return <div key={playerId}><span>{player.name}</span>{teamIndex >= 0 ? <><strong>{teams[teamIndex].name}</strong><button type="button" onClick={() => removePlayer(playerId)}>Remove</button></> : <select value="" onChange={(event) => assignPlayer(player, event.target.value)}><option value="" disabled>Assign team</option>{teams.map((team, index) => <option key={index} value={index} disabled={team.playerIds.length >= 11}>{team.name} ({team.playerIds.length}/11)</option>)}</select>}</div>; })}</div><div className="tournament-counts">{teams.map((team) => <span key={team.name}>{team.name}: {team.playerIds.length} / 11</span>)}</div><button type="button" className="primary-button" onClick={confirmTeams}>Confirm Teams</button></>}
      </div></div>}
    </div>
  );
}

export default Tournament;
