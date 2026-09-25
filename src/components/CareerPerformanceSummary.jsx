function CareerPerformanceSummary({ statistics, description }) {
  return (
    <div className="career-format-section">
      <div className="profile-stat-title">
        <span className="profile-stat-title-icon">📈</span>
        <div>
          <h3>Match &amp; Tournament Record</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="career-format-grid">
        <div className="career-format-card">
          <span>🏏 Test Matches</span>
          <strong>{statistics.testPlayed}</strong>
          <small className="career-result-counts">
            <b className="career-result-win">{statistics.testWon} won</b>
            <b className="career-result-loss">{statistics.testLost} lost</b>
            <b className="career-result-draw">{statistics.testDraw} drawn</b>
          </small>
        </div>
        <div className="career-format-card">
          <span>⚡ Limited Overs</span>
          <strong>{statistics.limitedPlayed}</strong>
          <small className="career-result-counts">
            <b className="career-result-win">{statistics.limitedWon} won</b>
            <b className="career-result-loss">{statistics.limitedLost} lost</b>
            <b className="career-result-draw">{statistics.limitedDraw} drawn</b>
          </small>
        </div>
        <div className="career-format-card">
          <span>🏆 Tournaments</span>
          <strong>{statistics.tournamentPlayed}</strong>
          <small>{statistics.tournamentChampion} champion • {statistics.tournamentRunnerUp} runners up</small>
        </div>
      </div>
      <div className="career-award-card">
        <span>🌟</span>
        <div>
          <strong>{statistics.manOfMatch}</strong>
          <small>Man of the Match awards</small>
        </div>
      </div>
    </div>
  );
}

export default CareerPerformanceSummary;
