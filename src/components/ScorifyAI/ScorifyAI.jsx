import { useEffect, useRef, useState } from "react";
import { askScorifyAI } from "../../services/aiService";
import "./ScorifyAI.css";

const GREETING =
  "Hi! I'm Scorify AI. Ask me about your Scorify matches, batting, bowling, players, or statistics.";
const MAX_MESSAGES = 30;

const makeMessage = (role, content, type = "message") => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  type,
});

const requestErrorMessage = (error) => {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "Unable to connect to Scorify AI. Please check your connection and try again.";
  }

  if (
    ["unauthenticated", "api-error"].includes(error?.code) &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }

  return "Sorry, I couldn't process that request right now. Please try again.";
};

function ScorifyAI() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const sendingRef = useRef(false);
  const [messages, setMessages] = useState(() => [
    makeMessage("assistant", GREETING),
  ]);
  const inputRef = useRef(null);
  const launcherRef = useRef(null);
  const messagesRef = useRef(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      launcherRef.current.focus();
      wasOpenRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, isSending, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const sendMessage = async () => {
    const message = input.trim();
    if (!message || sendingRef.current) return;
    sendingRef.current = true;

    const history = messages
      .filter((item) => item.role === "user" || item.role === "assistant")
      .slice(-8)
      .map(({ role, content }) => ({ role, content }));
    const userMessage = makeMessage("user", message);

    setInput("");
    setMessages((current) =>
      [...current, userMessage].slice(-MAX_MESSAGES)
    );
    setIsSending(true);

    try {
      const response = await askScorifyAI(message, history);
      setMessages((current) =>
        [
          ...current,
          makeMessage(
            "assistant",
            typeof response?.answer === "string"
              ? response.answer
              : "Sorry, I couldn't process that request right now. Please try again.",
            "message"
          ),
        ].slice(-MAX_MESSAGES)
      );
    } catch (error) {
      setMessages((current) =>
        [
          ...current,
          makeMessage("assistant", requestErrorMessage(error), "error"),
        ].slice(-MAX_MESSAGES)
      );
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    sendMessage();
  };

  const handleInputKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="scorify-ai-chatbot">
      {isOpen && (
        <section
          id="scorify-ai-window"
          className="scorify-ai-chat-window"
          role="dialog"
          aria-modal="false"
          aria-labelledby="scorify-ai-title"
          aria-describedby="scorify-ai-subtitle"
        >
          <header className="scorify-ai-chat-header">
            <div className="scorify-ai-brand">
              <span className="scorify-ai-mark" aria-hidden="true">
                ✨
              </span>
              <div>
                <h2 id="scorify-ai-title">Scorify AI</h2>
                <p id="scorify-ai-subtitle">Your cricket assistant</p>
              </div>
            </div>
            <button
              className="scorify-ai-close"
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close Scorify AI chat"
              title="Close chat"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <div
            ref={messagesRef}
            className="scorify-ai-messages"
            role="log"
            aria-label="Chat messages"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.map((message) => (
              <div
                className={`scorify-ai-message-row scorify-ai-message-row-${message.role}`}
                key={message.id}
              >
                {message.role === "assistant" && (
                  <span className="scorify-ai-avatar" aria-hidden="true">
                    ✨
                  </span>
                )}
                <p
                  className={`scorify-ai-message scorify-ai-message-${message.role}${message.type === "error" ? " scorify-ai-message-error" : ""}`}
                >
                  {message.content}
                </p>
              </div>
            ))}
            {isSending && (
              <div
                className="scorify-ai-message-row scorify-ai-message-row-assistant"
                role="status"
                aria-label="Scorify AI is responding"
              >
                <span className="scorify-ai-avatar" aria-hidden="true">
                  ✨
                </span>
                <div className="scorify-ai-typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>

          <form className="scorify-ai-composer" onSubmit={handleSubmit}>
            <label className="scorify-ai-sr-only" htmlFor="scorify-ai-input">
              Ask Scorify AI about your Scorify data
            </label>
            <textarea
              ref={inputRef}
              id="scorify-ai-input"
              className="scorify-ai-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Ask about your Scorify data..."
              maxLength={1000}
              rows={1}
              disabled={isSending}
            />
            <button
              className="scorify-ai-send"
              type="submit"
              disabled={isSending || !input.trim()}
              aria-label="Send message"
              title="Send message"
            >
              <span aria-hidden="true">➤</span>
            </button>
          </form>
        </section>
      )}

      <button
        ref={launcherRef}
        className="scorify-ai-launcher"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={isOpen ? "Close Scorify AI chat" : "Open Scorify AI chat"}
        aria-expanded={isOpen}
        aria-controls={isOpen ? "scorify-ai-window" : undefined}
        title="Scorify AI"
      >
        <svg
          className="scorify-ai-batter"
          viewBox="0 0 64 64"
          aria-hidden="true"
        >
          <path
            className="scorify-ai-swing-trail"
            d="M19 19C26 7 43 9 49 19"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
          />
          <g className="scorify-ai-flying-ball">
            <circle cx="51" cy="15" r="3.3" fill="#ffcf5a" />
            <path
              d="m49.5 13.5 3 3m-3 0 3-3"
              fill="none"
              stroke="#fff7dc"
              strokeLinecap="round"
              strokeWidth="0.8"
            />
            <path
              d="m55 11 3-2m-2 7 4 1"
              fill="none"
              stroke="#fff0b9"
              strokeLinecap="round"
              strokeWidth="1.4"
            />
          </g>
          <g className="scorify-ai-batter-bat">
            <path
              d="M35 34 21 14q-1.2-1.8.5-3l2-1.4q1.8-1.2 3 .6L41 31z"
              fill="#ffd079"
              stroke="#fff0ca"
              strokeLinejoin="round"
              strokeWidth="1.5"
            />
            <path
              d="m23.5 13.5 2.8-1.9"
              stroke="#bd7840"
              strokeLinecap="round"
              strokeWidth="1"
            />
          </g>
          <ellipse cx="33" cy="56" rx="15" ry="3" fill="#063b45" opacity=".24" />
          <g className="scorify-ai-batter-player">
            <path
              d="m25 36-5 11 4 2 8-8m6-7 5 10-3 3-8-7"
              fill="none"
              stroke="#f4b58d"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="4.5"
            />
            <path
              d="m22 46-1 8m17-8 2 8"
              fill="none"
              stroke="#f6f8ff"
              strokeLinecap="round"
              strokeWidth="6"
            />
            <path
              d="m22 54-2 2m19-2 2 2"
              fill="none"
              stroke="#25345d"
              strokeLinecap="round"
              strokeWidth="4"
            />
            <path
              d="M24 30q8-5 16 0l2 12q-9 5-20 0z"
              fill="#21c5b3"
              stroke="#d3fff4"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
            <path
              d="m25 42 6-1 1 10q-4 2-8 0zm9-1 6 1 1 10q-4 2-8 0z"
              fill="#f4f6ff"
              stroke="#d7e5ff"
              strokeLinejoin="round"
              strokeWidth="1.3"
            />
            <path
              d="M20 28q-3 1-3 4l4 4 6-4-2-4zm21 0q3 1 3 4l-4 4-6-4 2-4z"
              fill="#ffcf5a"
              stroke="#fff1bc"
              strokeLinejoin="round"
              strokeWidth="1.4"
            />
            <path
              d="M22 20q0-11 10-11t10 11v4H22z"
              fill="#30477e"
              stroke="#e1eaff"
              strokeLinejoin="round"
              strokeWidth="1.7"
            />
            <path
              d="M23 18q8-8 18 0v4H23z"
              fill="#f2b891"
              stroke="#ffd9bd"
              strokeWidth="1.2"
            />
            <path
              d="M22 19h20"
              stroke="#b9cbf4"
              strokeLinecap="round"
              strokeWidth="1.6"
            />
            <path
              d="M25 13q7-6 14 0"
              fill="none"
              stroke="#7188bd"
              strokeLinecap="round"
              strokeWidth="1.4"
            />
            <circle cx="28.5" cy="19.5" r="1" fill="#27375d" />
            <circle cx="35.5" cy="19.5" r="1" fill="#27375d" />
            <path
              d="M29 22q2.5 2.5 5 0"
              fill="none"
              stroke="#b85f5b"
              strokeLinecap="round"
              strokeWidth="1"
            />
            <circle cx="25" cy="22" r="1.5" fill="#f28f91" opacity=".8" />
            <circle cx="39" cy="22" r="1.5" fill="#f28f91" opacity=".8" />
          </g>
        </svg>
      </button>
    </div>
  );
}

export default ScorifyAI;
