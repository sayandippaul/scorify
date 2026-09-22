const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

/**
 * Shared performance-strength calculation.
 * Batting runs retain their one-point value; each wicket contributes five points.
 */
export const calculateStrengthPoints = ({
  runs = 0,
  wickets = 0,
  matchesPlayed = 0,
} = {}) => {
  const matches = toFiniteNumber(matchesPlayed);

  if (matches <= 0) {
    return 0;
  }

  return (
    toFiniteNumber(runs) +
    toFiniteNumber(wickets) * 5
  ) / matches;
};
