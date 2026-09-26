export function CareerOutcomeRecords({ statistics }) {
  const outcomes = [
    {
      key: "wins",
      label: "Won",
      count: statistics.wins,
      percentage: statistics.winPercentage,
    },
    {
      key: "draws",
      label: "Drawn",
      count: statistics.draws,
      percentage: statistics.drawPercentage,
    },
    {
      key: "losses",
      label: "Lost",
      count: statistics.losses,
      percentage: statistics.losePercentage,
    },
  ];
  const formats = [
    {
      key: "test",
      label: "Test Matches",
      played: statistics.testPlayed,
      won: statistics.testWon,
      drawn: statistics.testDraw,
      lost: statistics.testLost,
    },
    {
      key: "limited",
      label: "Limited Overs",
      played: statistics.limitedPlayed,
      won: statistics.limitedWon,
      drawn: statistics.limitedDraw,
      lost: statistics.limitedLost,
    },
  ];

  return (
    <section className="career-record-panels" aria-label="Career match records">
      <div className="career-record-panel career-overall-record">
        <div className="career-record-heading">
          <h3>Overall Match Results</h3>
          <span>{statistics.totalMatches || 0} matches</span>
        </div>
        <div className="career-outcome-list">
          {outcomes.map((outcome) => (
            <div className={`career-outcome career-outcome-${outcome.key}`} key={outcome.key}>
              <span>{outcome.label}</span>
              <strong>{outcome.count || 0}</strong>
              <small>{outcome.percentage || "0.00"}%</small>
            </div>
          ))}
        </div>
      </div>

      {formats.map((format) => (
        <div className="career-record-panel career-format-record" key={format.key}>
          <div className="career-record-heading">
            <h3>{format.label}</h3>
            <span>{format.played || 0} played</span>
          </div>
          <div className="career-format-outcomes">
            <span className="career-outcome-won">
              <b>{format.won || 0}</b> won
            </span>
            <span className="career-outcome-drawn">
              <b>{format.drawn || 0}</b> drawn
            </span>
            <span className="career-outcome-lost">
              <b>{format.lost || 0}</b> lost
            </span>
          </div>
        </div>
      ))}

      <div className="career-record-panel career-tournament-record">
        <div className="career-record-heading">
          <h3>Tournament Record</h3>
          <span>{statistics.tournamentPlayed || 0} played</span>
        </div>
        <div className="career-format-outcomes">
          <span className="career-outcome-won">
            <b>{statistics.tournamentChampion || 0}</b> won
          </span>
          <span className="career-outcome-runner">
            <b>{statistics.tournamentRunnerUp || 0}</b> runners-up
          </span>
        </div>
      </div>
    </section>
  );
}

export function CareerDismissalRecords({ title, records }) {
  return (
    <div className="career-dismissal-card">
      <h4>{title}</h4>
      {records?.length ? (
        <ol className="career-dismissal-list">
          {records.map(({ method, count }, index) => (
            <li key={`${method}-${index}`}>
              <span className="career-dismissal-rank">{index + 1}</span>
              <span className="career-dismissal-method">{method}</span>
              <strong>{count}</strong>
            </li>
          ))}
        </ol>
      ) : (
        <p className="career-record-empty">No recorded dismissals</p>
      )}
    </div>
  );
}
