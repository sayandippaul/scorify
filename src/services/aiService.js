import { auth } from "../firebase/firebase";

export const askScorifyAI = async (message, history) => {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Sign in to use Scorify AI.");
  }

  const idToken = await user.getIdToken();
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      message,
      history: history.slice(-8).map(({ role, content }) => ({ role, content })),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || "Unable to reach Scorify AI.");
    error.code = response.status === 401 ? "unauthenticated" : "api-error";
    throw error;
  }

  if (typeof data?.answer !== "string" || !data.answer.trim()) {
    throw new Error("Scorify AI returned an invalid response.");
  }

  return data;
};
