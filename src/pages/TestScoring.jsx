import Scoring from "./Scoring";

// Test matches use the same proven delivery controls, while Scoring's
// format-specific branches provide the four-innings and no-free-hit rules.
export default function TestScoring() {
  return <div className="test-scoring-page"><Scoring /></div>;
}
