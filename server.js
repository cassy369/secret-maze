const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({
  path: path.join(__dirname, "server.env")
});

const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = 3000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MIN_COMPLETION_MS = 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Temporary server-side challenges. The challenge ID is useless after it is claimed or expires.
const challenges = new Map();

function validLevel(value) {
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 12 ? level : null;
}

function cleanupChallenges() {
  const now = Date.now();
  for (const [id, c] of challenges) {
    if (c.claimed || now - c.createdAt > CHALLENGE_TTL_MS) {
      challenges.delete(id);
    }
  }
}

setInterval(cleanupChallenges, 60 * 1000).unref();

// Start a server-side completion challenge for this level.
app.get("/api/start/:level", (req, res) => {
  const level = validLevel(req.params.level);
  if (!level) {
    return res.status(400).json({ success: false, error: "Invalid level" });
  }

  cleanupChallenges();
  const challengeId = crypto.randomBytes(32).toString("hex");
  challenges.set(challengeId, {
    level,
    createdAt: Date.now(),
    claimed: false
  });

  res.set("Cache-Control", "no-store");
  res.json({ success: true, challengeId });
});

// Claim the phrase only through a valid, unexpired, one-time challenge.
app.post("/api/complete", async (req, res) => {
  try {
    cleanupChallenges();

    const { challengeId, level: rawLevel, seconds, moves } = req.body || {};
    const level = validLevel(rawLevel);
    const challenge = typeof challengeId === "string" ? challenges.get(challengeId) : null;

    if (!level || !challenge || challenge.claimed || challenge.level !== level) {
      return res.status(403).json({ success: false, error: "Invalid completion challenge" });
    }

    if (Date.now() - challenge.createdAt < MIN_COMPLETION_MS) {
      return res.status(429).json({ success: false, error: "Completion was too fast" });
    }

    // Basic sanity checks. These are not intended to prove a human played the game.
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0 || Number(seconds) > 3600) {
      return res.status(400).json({ success: false, error: "Invalid completion time" });
    }
    if (!Number.isInteger(Number(moves)) || Number(moves) < 1 || Number(moves) > 100000) {
      return res.status(400).json({ success: false, error: "Invalid move count" });
    }

    const { data, error } = await supabase
      .from("phrase_codes")
      .select("code, level, active, used")
      .eq("level", level)
      .eq("active", true)
      .eq("used", false)
      .limit(1)
      .single();

    if (error || !data || !data.code) {
      console.error("Phrase lookup failed:", error);
      return res.status(404).json({ success: false, error: "No active code found for this level" });
    }

    // Consume the challenge before returning the secret so it cannot be replayed.
    challenge.claimed = true;
    challenges.delete(challengeId);

    res.set("Cache-Control", "no-store");
    return res.json({ success: true, level: data.level, code: data.code });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
