/**
 * Twilio Voice server — Outbound (server-initiated) + Inbound (bridge to Client) + Transcription logging
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const {
  twiml: { VoiceResponse },
  jwt: { AccessToken },
} = require("twilio");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  CALL_FROM, // +19084934173
  CALL_TO, // +14159664480
  DEFAULT_CLIENT_IDENTITY = "browser-user",
  TRANSCRIPTION_ENGINE,
  TRANSCRIPTION_LANGUAGE,
  PORT = 7000,
} = process.env;

const twilio = require("twilio")(TWILIO_API_KEY, TWILIO_API_SECRET, {
  accountSid: TWILIO_ACCOUNT_SID,
});
const logPath = path.resolve(process.cwd(), "./logs/call_log.jsonl");

function appendLog(obj) {
  fs.appendFileSync(
    logPath,
    JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"
  );
}

function absUrl(req, p) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}${p}`;
}

// Outbound dial
app.post("/dial", async (req, res) => {
  try {
    const to =
      req.body && req.body.to ? String(req.body.to).trim() : CALL_TO || "";
    const from = (CALL_FROM || "").trim();
    if (!from || !to)
      return res
        .status(400)
        .json({ error: "CALL_FROM and CALL_TO must be set (or pass {to})" });

    const call = await twilio.calls.create({
      from,
      to,
      url: "https://6a193b04b364.ngrok-free.app/twiml/inbound",
      statusCallback: "https://6a193b04b364.ngrok-free.app/status-events",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    appendLog({ type: "dial.requested", from, to, callSid: call.sid });
    res.json({ ok: true, callSid: call.sid, from, to });
  } catch (err) {
    appendLog({ type: "dial.error", error: err.message || String(err) });
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Inbound TwiML
app.post("/twiml/inbound", (req, res) => {
  const vr = new VoiceResponse();

  const start = vr.start();
  const txOpts = {
    statusCallbackUrl: absUrl(req, "/transcription-events"),
    track: "both_tracks",
  };
  if (TRANSCRIPTION_ENGINE) txOpts.transcriptionEngine = TRANSCRIPTION_ENGINE;
  if (TRANSCRIPTION_LANGUAGE) txOpts.languageCode = TRANSCRIPTION_LANGUAGE;
  start.transcription(txOpts);

  const identity = (req.query.id || DEFAULT_CLIENT_IDENTITY).trim();
  const d = vr.dial({ answerOnBridge: true });
  d.client(identity);

  res.type("text/xml").send(vr.toString());
});

const txLogPath = path.resolve(process.cwd(), "./logs/transcripts.jsonl");
// Transcription webhooks
app.post("/transcription-events", (req, res) => {
  try {
    const b = req.body || {};
    if (b.TranscriptionEvent === "transcription-content") {
      let transcriptText = "";
      let confidence = null;

      try {
        const parsed = JSON.parse(b.TranscriptionData || "{}");
        transcriptText = parsed.transcript || "";
        confidence = parsed.confidence;
      } catch (e) {
        transcriptText = b.TranscriptionData; // fallback raw string
      }

      const entry = {
        ts: new Date().toISOString(),
        callSid: b.CallSid,
        transcriptionSid: b.TranscriptionSid,
        text: transcriptText,
        confidence,
        isFinal: b.Final === "true",
        track: b.Track,
        seq: b.SequenceId,
      };

      appendLog({ type: "transcription", ...entry });
      fs.appendFileSync(
        "./logs/transcripts.jsonl",
        JSON.stringify(entry) + "\n"
      );
    } else {
      appendLog({ type: "transcription.meta", payload: b });
    }
  } catch (e) {
    console.error("Transcription handler error:", e);
  }
  res.sendStatus(200);
});

// Status events
app.post("/status-events", (req, res) => {
  appendLog({ type: "status", payload: req.body });
  res.sendStatus(200);
});

// Hangup
app.post("/hangup", async (req, res) => {
  try {
    const { callSid } = req.body || {};
    if (!callSid) return res.status(400).json({ error: "callSid is required" });
    await twilio.calls(callSid).update({ status: "completed" });
    appendLog({ type: "hangup.requested", callSid });
    res.json({ ok: true, callSid });
  } catch (err) {
    appendLog({ type: "hangup.error", error: err.message || String(err) });
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Token for Voice SDK
app.get("/token", (req, res) => {
  const identity = (req.query.identity || DEFAULT_CLIENT_IDENTITY).trim();
  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { ttl: 3600, identity }
  );
  token.identity = identity;
  const VoiceGrant = AccessToken.VoiceGrant;
  token.addGrant(new VoiceGrant({ incomingAllow: true }));
  res.json({ token: token.toJwt(), identity });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on :${PORT} | Logging to ${logPath}`);
});
