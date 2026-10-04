const idString = (value) =>
  value === undefined || value === null ? "" : String(value);

const dismissalType = (delivery) =>
  delivery?.wicket?.type ||
  delivery?.wicket?.dismissalType ||
  delivery?.wicketType ||
  delivery?.dismissalType ||
  "";

const displayDismissalType = (value) =>
  String(value)
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const mostCommon = (counts) => {
  let result = "—";
  let highest = 0;
  counts.forEach((count, method) => {
    if (count > highest) {
      highest = count;
      result = `${displayDismissalType(method)} (${count})`;
    }
  });
  return result;
};

export const getPlayerDismissalStats = (deliveries = [], playerIds) => {
  const batting = new Map();
  const bowling = new Map();

  deliveries.forEach((delivery) => {
    const method = dismissalType(delivery);
    if (!method) return;

    const dismissedId = idString(
      delivery?.wicket?.batterId ||
      delivery?.wicket?.dismissedPlayerId ||
      delivery?.dismissedPlayerId
    );
    const bowlerId = idString(
      delivery?.bowlerId ||
      delivery?.bowlerPlayerId
    );

    if (playerIds?.has(dismissedId)) {
      batting.set(method, (batting.get(method) || 0) + 1);
    }
    if (playerIds?.has(bowlerId)) {
      bowling.set(method, (bowling.get(method) || 0) + 1);
    }
  });

  return {
    mostCommonBattingDismissal: mostCommon(batting),
    mostCommonBowlingDismissal: mostCommon(bowling),
  };
};
