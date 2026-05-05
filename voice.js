/* ═══════════════════════════════════════════════════════════════
   voice.js — BlueLedger Voice Logging Module
   Handles: mic capture, transcript parsing, form pre-fill.
   Depends on: utils.js, ai.js (must load first)
   ═══════════════════════════════════════════════════════════════ */

/* ── Constants ───────────────────────────────────────────────── */
if (typeof VOICE_BACKEND_TIMEOUT_MS === "undefined") var VOICE_BACKEND_TIMEOUT_MS = 6500;
if (typeof VOICE_IDLE_MESSAGE === "undefined") var VOICE_IDLE_MESSAGE =
  "Tap the mic and speak a transaction. We'll fill the draft for you.";
if (typeof VOICE_EXPENSE_ACTION_PATTERN === "undefined") var VOICE_EXPENSE_ACTION_PATTERN =
  "spend|spent|pay|paid|use|used|buy|bought|order|ordered|book|booked|give|gave|purchase|purchased|charge|charged|expense";
if (typeof VOICE_INCOME_ACTION_PATTERN === "undefined") var VOICE_INCOME_ACTION_PATTERN =
  "receive|received|earn|earned|get|got|make|made|credit|credited|income|salary|refund|bonus";

if (typeof VOICE_NUMBER_WORDS === "undefined") var VOICE_NUMBER_WORDS = {
  a: 1,
  an: 1,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

if (typeof VOICE_NUMBER_WORD_PATTERN === "undefined") var VOICE_NUMBER_WORD_PATTERN = Object.keys(VOICE_NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

if (typeof VOICE_UI_COPY === "undefined") var VOICE_UI_COPY = {
  idle: {
    icon: "fa-microphone",
    title: "Log by voice",
    hint: 'Say "Spent 200 rupees on lunch"',
  },
  starting: {
    icon: "fa-spinner fa-spin",
    title: "Preparing mic",
    hint: "Allow microphone access if the browser asks.",
  },
  listening: {
    icon: "fa-wave-square",
    title: "Listening...",
    hint: "Tap again to stop listening.",
  },
  processing: {
    icon: "fa-spinner fa-spin",
    title: "Processing...",
    hint: "Turning speech into a draft.",
  },
  success: {
    icon: "fa-check",
    title: "Draft ready",
    hint: "Review the fields, then confirm the entry.",
  },
  error: {
    icon: "fa-rotate-right",
    title: "Try again",
    hint: "Tap to retry voice logging.",
  },
  unsupported: {
    icon: "fa-circle-info",
    title: "Voice unavailable",
    hint: "Use Chrome or Edge with microphone access.",
  },
};

/* ── Internal state ─────────────────────────────────────────── */
if (typeof _voiceRecognition === "undefined") var _voiceRecognition = null;
if (typeof _voiceBusy === "undefined") var _voiceBusy = false;
if (typeof _voiceSession === "undefined") var _voiceSession = { id: 0, type: "", resultReceived: false };

/* ══════════════════════════════════════════════════════════════
   PUBLIC ENTRY POINT
   ══════════════════════════════════════════════════════════════ */

/**
 * Toggle voice capture for a given form type.
 * @param {"income"|"expense"} type
 */
function startVoiceLog(type) {
  const activeType = _voiceSession.type;

  // Tapping mic while already listening for the same type → stop
  if (_voiceBusy && activeType === type) {
    _cancelVoiceCapture(
      type,
      "Listening stopped. Tap again when you're ready.",
    );
    return;
  }

  // Different type is active → cancel it first
  if (_voiceBusy && activeType && activeType !== type) {
    _cancelVoiceCapture(activeType);
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    _hideVoicePreview(type);
    _setVoiceUi(
      type,
      "unsupported",
      "Voice dictation needs Chrome or Edge with microphone access.",
    );
    return;
  }

  const recognition = new SpeechRecognition();
  const sessionId = Date.now() + Math.random();
  _voiceRecognition = recognition;
  _voiceBusy = true;
  _voiceSession = { id: sessionId, type, resultReceived: false };

  _hideVoicePreview(type);
  _setVoiceUi(type, "starting", "Requesting microphone access...");

  recognition.lang = navigator.language || "en-IN";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  recognition.onstart = () => {
    if (_voiceSession.id !== sessionId) return;
    _setVoiceUi(
      type,
      "listening",
      'Listening... say "Spent 200 rupees on lunch".',
    );
  };

  recognition.onresult = async (event) => {
    if (_voiceSession.id !== sessionId) return;

    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0]?.transcript?.trim();
      if (!piece) continue;
      if (event.results[i].isFinal) finalTranscript += `${piece} `;
      else interimTranscript += `${piece} `;
    }

    finalTranscript = finalTranscript.trim();
    interimTranscript = interimTranscript.trim();

    if (finalTranscript) {
      _voiceSession.resultReceived = true;
      _voiceBusy = false;
      _renderVoicePreview(type, finalTranscript);
      _setVoiceUi(type, "processing", "Processing what you said...");
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      _voiceRecognition = null;
      await _handleVoiceTranscript(type, finalTranscript);
      return;
    }

    if (interimTranscript) {
      _setVoiceUi(type, "listening", `Hearing: "${interimTranscript}"`);
    }
  };

  recognition.onerror = (event) => {
    if (_voiceSession.id !== sessionId) return;
    const errorCode = event?.error || "unknown";
    _voiceRecognition = null;
    _voiceBusy = false;
    _voiceSession = { id: 0, type: "", resultReceived: false };
    _setVoiceUi(type, "error", _getVoiceErrorMessage(errorCode));
  };

  recognition.onend = () => {
    if (_voiceSession.id !== sessionId) return;
    _voiceRecognition = null;

    if (_voiceBusy && !_voiceSession.resultReceived) {
      _voiceBusy = false;
      _voiceSession = { id: 0, type: "", resultReceived: false };
      _setVoiceUi(
        type,
        "error",
        "No speech detected. Try again and speak a little closer to the mic.",
      );
      return;
    }

    if (_voiceSession.resultReceived) {
      _voiceSession = { id: 0, type: "", resultReceived: false };
    }
  };

  try {
    recognition.start();
  } catch (err) {
    _voiceRecognition = null;
    _voiceBusy = false;
    _voiceSession = { id: 0, type: "", resultReceived: false };
    _setVoiceUi(
      type,
      "error",
      "The microphone couldn't start in this browser. Refresh and try again.",
    );
    console.warn("Voice recognition start failed:", err);
  }
}

/* ══════════════════════════════════════════════════════════════
   TRANSCRIPT PIPELINE
   ══════════════════════════════════════════════════════════════ */

async function _handleVoiceTranscript(type, transcript) {
  const localDraft = _parseVoiceLocally(type, transcript);
  let finalDraft = localDraft;

  // Only call backend if local parse is low-confidence
  if (_needsVoiceBackendFallback(localDraft)) {
    const backendDraft = await _parseVoiceWithBackend(
      type,
      transcript,
      localDraft,
    );
    if (backendDraft) {
      finalDraft = {
        ...localDraft,
        ...backendDraft,
        amount: backendDraft.amount || localDraft.amount,
        description: backendDraft.description || localDraft.description,
        category: backendDraft.category || localDraft.category,
      };
    }
  }

  // Fill in missing fields before rendering
  if (!finalDraft.category) finalDraft.category = "Other";
  if (!finalDraft.description) {
    finalDraft.description = _fallbackVoiceDescription(
      type,
      transcript,
      finalDraft.category,
    );
  }

  // Apply to form and show preview (single call each — no duplicates)
  _applyVoiceDraft(type, { ...finalDraft, amount: finalDraft.amount || null });
  _renderVoicePreview(type, transcript, finalDraft);

  if (!finalDraft.amount) {
    _setVoiceUi(
      type,
      "error",
      "I heard the transcript, but couldn't detect the amount. Try again or type the amount manually.",
    );
    return;
  }

  _setVoiceUi(
    type,
    "success",
    `Draft ready${finalDraft.source === "backend" ? " with AI assist" : ""}. Review the fields, then confirm the entry.`,
  );
}

/* ══════════════════════════════════════════════════════════════
   LOCAL PARSING
   ══════════════════════════════════════════════════════════════ */

function _scaleVoiceAmount(numberText, multiplierText) {
  let amount = Number.parseFloat(String(numberText || "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const multiplier = String(multiplierText || "").toLowerCase();
  if (multiplier === "k" || multiplier === "thousand") amount *= 1000;
  if (multiplier === "lakh" || multiplier === "lac") amount *= 100000;
  return Math.round(amount * 100) / 100;
}

function _parseWordNumber(phrase) {
  const tokens = String(phrase)
    .toLowerCase()
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  let total = 0,
    current = 0,
    decimal = "",
    afterPoint = false,
    seenNumber = false;

  for (const token of tokens) {
    if (token === "and") continue;
    if (token === "point") {
      afterPoint = true;
      continue;
    }

    if (afterPoint) {
      if (!(token in VOICE_NUMBER_WORDS)) return null;
      const d = VOICE_NUMBER_WORDS[token];
      if (d < 0 || d > 9) return null;
      decimal += String(d);
      seenNumber = true;
      continue;
    }

    if (token === "hundred") {
      current = (current || 1) * 100;
      seenNumber = true;
      continue;
    }
    if (token === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seenNumber = true;
      continue;
    }
    if (token === "lakh" || token === "lac") {
      total += (current || 1) * 100000;
      current = 0;
      seenNumber = true;
      continue;
    }

    const value = VOICE_NUMBER_WORDS[token];
    if (value === undefined) return null;
    current += value;
    seenNumber = true;
  }

  if (!seenNumber) return null;
  const whole = total + current;
  if (!decimal) return whole || null;
  return Number.parseFloat(`${whole}.${decimal}`);
}

function _extractWordAmount(transcript) {
  const patterns = [
    new RegExp(
      `\\b((?:(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac|point|and)\\s+){0,10}(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac))\\s+(?:rupees?|rs|inr)\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:${VOICE_EXPENSE_ACTION_PATTERN}|${VOICE_INCOME_ACTION_PATTERN})(?:\\s+of)?\\s+((?:(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac|point|and)\\s+){0,10}(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac))\\b`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (!match) continue;
    const amount = _parseWordNumber(match[1]);
    if (amount) return { amount, matchedText: match[0] };
  }
  return { amount: null, matchedText: "" };
}

function _extractVoiceAmount(transcript) {
  const patterns = [
    /\b(?:rs\.?|inr|rupees?)\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lac)?\b/i,
    /\b(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lac)\b/i,
    /\b(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:rs\.?|inr|rupees?)\b/i,
    new RegExp(
      `\\b(?:${VOICE_EXPENSE_ACTION_PATTERN}|${VOICE_INCOME_ACTION_PATTERN})(?:\\s+of)?\\s+(\\d+(?:,\\d+)*(?:\\.\\d+)?)\\s*(k|thousand|lakh|lac)?\\b`,
      "i",
    ),
    /\b(\d+(?:,\d+)*(?:\.\d+)?)\s+(?:on|for|towards|at|from)\b/i,
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (!match) continue;
    const amount = _scaleVoiceAmount(match[1], match[2]);
    if (amount) return { amount, matchedText: match[0] };
  }

  return _extractWordAmount(transcript);
}

function _escapeVoiceRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _cleanVoiceDescription(type, transcript, matchedText) {
  let cleaned = String(transcript || "");

  if (matchedText) {
    cleaned = cleaned.replace(
      new RegExp(_escapeVoiceRegExp(matchedText), "i"),
      " ",
    );
  }

  const actionPattern =
    type === "income"
      ? new RegExp(
          `\\b(?:please\\s+)?(?:add|log|record|note)?\\s*(?:i\\s+)?(?:just\\s+)?(?:${VOICE_INCOME_ACTION_PATTERN})(?:\\s+from|\\s+payment|\\s+of)?\\b`,
          "gi",
        )
      : new RegExp(
          `\\b(?:please\\s+)?(?:add|log|record|note)?\\s*(?:i\\s+)?(?:just\\s+)?(?:${VOICE_EXPENSE_ACTION_PATTERN})(?:\\s+for)?\\b`,
          "gi",
        );

  cleaned = cleaned
    .replace(actionPattern, " ")
    .replace(/\b(?:rs\.?|inr|rupees?)\b/gi, " ")
    .replace(/\b(?:today|right now|just now|please|transaction|entry)\b/gi, " ")
    .replace(/^[\s,.-]*(?:on|for|from|towards|to|at|via|of)\b/gi, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function _fallbackVoiceDescription(type, transcript, category) {
  if (category && category !== "Other") {
    if (type === "income") {
      if (category === "Salary") return "Salary";
      if (category === "Freelance") return "Freelance payment";
      return `${category} income`;
    }
    if (category === "Food") return "Food expense";
    if (category === "Transport") return "Transport expense";
    return `${category} expense`;
  }
  const trimmed = String(transcript || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "";
}

function _parseVoiceLocally(type, transcript) {
  const allowedCategories = _getAiCategories(type);
  const amountResult = _extractVoiceAmount(transcript);
  const directCategory = _localKeywordGuess(type, transcript);
  let description = _cleanVoiceDescription(
    type,
    transcript,
    amountResult.matchedText,
  );
  let category =
    _localKeywordGuess(type, description) || directCategory || "Other";

  const matchedCategory = allowedCategories.find(
    (item) => item.toLowerCase() === String(category).toLowerCase(),
  );
  category =
    matchedCategory || (allowedCategories.includes("Other") ? "Other" : "");

  if (!description) {
    description = _fallbackVoiceDescription(type, transcript, category);
  }

  let confidence = 0;
  if (amountResult.amount) confidence += 0.5;
  if (description && description.toLowerCase() !== transcript.toLowerCase())
    confidence += 0.2;
  if (category && category !== "Other") confidence += 0.2;
  if (
    amountResult.matchedText &&
    /rs|inr|rupees?|k|thousand|lakh|lac/i.test(amountResult.matchedText)
  )
    confidence += 0.1;

  return {
    amount: amountResult.amount,
    description,
    category,
    date: todayStr(),
    confidence: Math.min(confidence, 1),
    source: "local",
  };
}

function _needsVoiceBackendFallback(draft) {
  return (
    !draft.amount ||
    !draft.description ||
    !draft.category ||
    draft.category === "Other" ||
    draft.confidence < 0.75
  );
}

/* ══════════════════════════════════════════════════════════════
   BACKEND FALLBACK (via custom endpoint)
   ══════════════════════════════════════════════════════════════ */

function _getVoiceAiEndpoint() {
  return String(
    window.BLUELEDGER_VOICE_AI_ENDPOINT ||
      document.body?.dataset.voiceAiEndpoint ||
      localStorage.getItem("bl_voice_ai_endpoint") ||
      "",
  ).trim();
}

function _sanitizeVoiceDraft(type, payload) {
  const source = payload?.draft || payload;
  if (!source || typeof source !== "object") return null;

  const allowedCategories = _getAiCategories(type);
  const amount = _scaleVoiceAmount(source.amount, "");
  let description = String(source.description || "").trim();
  let category = String(source.category || "").trim();

  if (!description) description = "";
  const matchedCategory = allowedCategories.find(
    (item) => item.toLowerCase() === category.toLowerCase(),
  );
  category = matchedCategory || "";

  return {
    amount,
    description,
    category,
    date: todayStr(),
    confidence: 1,
    source: "backend",
  };
}

async function _parseVoiceWithBackend(type, transcript, localDraft) {
  const endpoint = _getVoiceAiEndpoint();
  if (!endpoint) return null;

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), VOICE_BACKEND_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        type,
        categories: _getAiCategories(type),
        localDraft,
      }),
      signal: controller?.signal,
    });

    if (!response.ok)
      throw new Error(`Voice AI endpoint error ${response.status}`);

    const payload = await response.json();
    return _sanitizeVoiceDraft(type, payload);
  } catch (err) {
    console.warn("Voice AI backend fallback skipped:", err);
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/* ══════════════════════════════════════════════════════════════
   FORM APPLICATION
   ══════════════════════════════════════════════════════════════ */

function _applyVoiceDraft(type, draft) {
  const amtEl = safeGet(`${type}Amount`);
  const descEl = safeGet(`${type}Desc`);
  const catEl = safeGet(`${type}Category`);
  const dateEl = safeGet(`${type}Date`);

  if (amtEl && draft.amount) safeSetValue(amtEl, draft.amount);
  if (descEl && draft.description) safeSetValue(descEl, draft.description);
  if (dateEl && !dateEl.value) safeSetValue(dateEl, draft.date || todayStr());
  if (catEl && draft.category) safeSetValue(catEl, draft.category);

  // Trigger AI auto-category only if category is missing or generic
  if (
    descEl &&
    draft.description &&
    (!draft.category || draft.category === "Other")
  ) {
    if (typeof aiAutoCategory === "function") {
      aiAutoCategory(type, draft.description);
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════════════════════ */

function _getVoiceElements(type) {
  return {
    btn: document.getElementById(`${type}VoiceBtn`),
    icon: document.querySelector(`#${type}VoiceBtn .voice-btn-icon i`),
    title: document.querySelector(`#${type}VoiceBtn .voice-btn-title`),
    hint: document.querySelector(`#${type}VoiceBtn .voice-btn-hint`),
    status: document.getElementById(`${type}VoiceStatus`),
    preview: document.getElementById(`${type}VoicePreview`),
    transcript: document.getElementById(`${type}VoiceTranscript`),
    chips: document.getElementById(`${type}VoiceChips`),
  };
}

function _setVoiceUi(type, state, message) {
  const els = _getVoiceElements(type);
  if (!els.btn || !els.status) return;

  const copy = VOICE_UI_COPY[state] || VOICE_UI_COPY.idle;
  els.btn.dataset.state = state;
  els.status.dataset.state = state;
  els.btn.disabled = state === "starting" || state === "processing";

  if (els.icon) els.icon.className = `fas ${copy.icon}`;
  if (els.title) els.title.textContent = copy.title;
  if (els.hint) els.hint.textContent = copy.hint;
  els.status.textContent = message || VOICE_IDLE_MESSAGE;
}

function _hideVoicePreview(type) {
  const els = _getVoiceElements(type);
  if (!els.preview) return;
  els.preview.hidden = true;
  if (els.transcript) els.transcript.textContent = "";
  if (els.chips) els.chips.innerHTML = "";
}

function _renderVoicePreview(type, transcript, draft = null) {
  const els = _getVoiceElements(type);
  if (!els.preview || !els.transcript || !els.chips) return;

  els.preview.hidden = false;
  els.transcript.textContent = transcript;
  els.chips.innerHTML = "";

  if (!draft) return;
  if (draft.amount)
    _appendVoiceChip(
      els.chips,
      `₹${Number(draft.amount).toLocaleString("en-IN")}`,
      "amount",
    );
  if (draft.category) _appendVoiceChip(els.chips, draft.category, "category");
  if (draft.description)
    _appendVoiceChip(els.chips, draft.description, "description");
}

function _appendVoiceChip(container, label, variant = "default") {
  const chip = document.createElement("span");
  chip.className = `voice-preview-chip voice-preview-chip--${variant}`;
  chip.textContent = label;
  container.appendChild(chip);
}

function _getVoiceErrorMessage(errorCode) {
  const messages = {
    "audio-capture":
      "No microphone was found. Check device mic access and try again.",
    "not-allowed":
      "Microphone access was blocked. Allow mic permission and try again.",
    "service-not-allowed":
      "This browser blocked speech services. Try Chrome or Edge.",
    network:
      "Speech recognition lost its network connection. Check connectivity and try again.",
    "no-speech":
      "No speech was detected. Speak a little louder or closer to the mic.",
    "language-not-supported":
      "This browser can't recognize the current language setting.",
    aborted: "Listening stopped.",
  };
  return (
    messages[errorCode] ||
    `Voice capture failed (${errorCode}). Please try again.`
  );
}

function _cancelVoiceCapture(type, message = VOICE_IDLE_MESSAGE) {
  try {
    _voiceRecognition?.stop();
  } catch {
    /* ignore */
  }
  _voiceRecognition = null;
  _voiceBusy = false;
  _voiceSession = { id: 0, type: "", resultReceived: false };
  _setVoiceUi(type, "idle", message);
}

/**
 * Reset voice UI — call when a modal is opened or closed.
 * @param {"income"|"expense"} type
 */
function resetVoiceUi(type) {
  if (_voiceBusy && _voiceSession.type === type) {
    _cancelVoiceCapture(type);
    return;
  }
  _hideVoicePreview(type);
  _setVoiceUi(type, "idle", VOICE_IDLE_MESSAGE);
}

/* ── Expose to global scope ──────────────────────────────────── */
window.startVoiceLog = startVoiceLog;
window.resetVoiceUi = resetVoiceUi;
