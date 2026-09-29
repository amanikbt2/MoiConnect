import { Types } from 'mongoose';
import { CommunityMessage } from '../models/CommunityMessage';
import { AiFailureLog, AiPoolUsage } from '../models/AiTelemetry';

export const CAMPUS_BOT_FALLBACK = "Sorry, i'm not available at the moment";
export const CAMPUS_BOT_EMAIL = 'campusbot@moiconnect.app';
export const CAMPUS_AI_EMAIL = 'campusai@moiconnect.app';

type AssistantKind = 'bot' | 'ai';
type Assistant = { kind: AssistantKind; name: string; email: string; id: Types.ObjectId; avatarBg: string; aliases: RegExp };
const assistants: Record<AssistantKind, Assistant> = {
  bot: { kind: 'bot', name: 'Campus Bot', email: CAMPUS_BOT_EMAIL, id: new Types.ObjectId('000000000000000000000001'), avatarBg: '#6366f1', aliases: /(^|\s)@(bot|campusbot|campus\s+bot)\b|\bcampus\s+bot\b/i },
  ai: { kind: 'ai', name: 'Campus AI', email: CAMPUS_AI_EMAIL, id: new Types.ObjectId('000000000000000000000002'), avatarBg: '#d4a017', aliases: /(^|\s)@(ai|campusai|campus\s+ai)\b|\bcampus\s+ai\b/i }
};
const REQUEST_TIMEOUT_MS = 8000;
const KEY_COOLDOWN_MS = 60_000;
const MODEL_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
const MAX_TURNS_PER_CHAIN = 4;
let preferredKeyIndex = 0;
let preferredModelIndex = 0;
let stopGeneration = 0;
const keyCooldownUntil = new Map<string, number>();
const inFlightReplies = new Set<string>();
const activeRequests = new Set<AbortController>();
type AiLogLevel = 'info' | 'warn' | 'error';
type AiPoolStat = {
  apiLabel: string;
  model: string;
  configuredLimit: number | null;
  used: number;
  successes: number;
  failures: number;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  cooldownRemainingMs: number;
};
type AiLogEntry = {
  timestamp: string;
  level: AiLogLevel;
  assistant: string;
  apiLabel?: string;
  model?: string;
  status?: number;
  message: string;
};
const aiPoolUsage = new Map<string, { used: number; successes: number; failures: number; lastUsedAt: string | null }>();
const aiLogs: AiLogEntry[] = [];
const MAX_AI_LOGS = 250;

const addAiLog = (entry: Omit<AiLogEntry, 'timestamp'>): void => {
  const log = { ...entry, timestamp: new Date().toISOString() };
  aiLogs.unshift(log);
  if (aiLogs.length > MAX_AI_LOGS) aiLogs.length = MAX_AI_LOGS;
  void AiFailureLog.create({ ...log, modelName: log.model, model: undefined }).catch(() => undefined);
};

const getApiLabel = (index: number): string => `API ${index + 1}`;
const getConfiguredLimit = (index: number): number | null => {
  const raw = process.env[`GEMINI_API_LIMIT_${index + 1}`] || process.env[`GEMINI_API_LIMIT_API${index + 1}`];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const getAiTelemetry = async (): Promise<{ generatedAt: string; models: string[]; pool: AiPoolStat[]; logs: AiLogEntry[] }> => {
  const keys = getGeminiKeys();
  const models = getGeminiModels();
  const pool: AiPoolStat[] = [];
  const persistedUsage = await AiPoolUsage.find({ apiLabel: { $in: keys.map((_key, index) => getApiLabel(index)) } }).lean().catch(() => [] as any[]);
  const persistedByApi = new Map(persistedUsage.map((item: any) => [item.apiLabel, item]));
  keys.forEach((_key, index) => {
    const apiLabel = getApiLabel(index);
    const localUsage = aiPoolUsage.get(apiLabel);
    const storedUsage = persistedByApi.get(apiLabel);
    const usage = storedUsage || localUsage || { used: 0, successes: 0, failures: 0, lastUsedAt: null };
    const cooldown = Math.max(keyCooldownUntil.get(_key) || 0, storedUsage?.cooldownUntil ? new Date(storedUsage.cooldownUntil).getTime() : 0);
    pool.push({
      apiLabel,
      model: models[(preferredModelIndex + index) % models.length],
      configuredLimit: getConfiguredLimit(index),
      used: usage.used,
      successes: usage.successes,
      failures: usage.failures,
      lastUsedAt: usage.lastUsedAt,
      cooldownUntil: cooldown > Date.now() ? new Date(cooldown).toISOString() : null,
      cooldownRemainingMs: Math.max(0, cooldown - Date.now())
    });
  });
  const storedLogs = await AiFailureLog.find().sort({ timestamp: -1 }).limit(100).lean().catch(() => [] as any[]);
  const logs = storedLogs.length
    ? storedLogs.map((log: any) => ({ timestamp: new Date(log.timestamp).toISOString(), level: log.level, assistant: log.assistant, apiLabel: log.apiLabel, model: log.modelName, status: log.status, message: log.message }))
    : aiLogs.slice(0, 100);
  return { generatedAt: new Date().toISOString(), models, pool, logs };
};

const updateAiUsage = (apiLabel: string, result: 'success' | 'failure'): void => {
  const current = aiPoolUsage.get(apiLabel) || { used: 0, successes: 0, failures: 0, lastUsedAt: null };
  current.used += 1;
  current.lastUsedAt = new Date().toISOString();
  if (result === 'success') current.successes += 1;
  else current.failures += 1;
  aiPoolUsage.set(apiLabel, current);
  void AiPoolUsage.findOneAndUpdate(
    { apiLabel },
    { $inc: { used: 1, ...(result === 'success' ? { successes: 1 } : { failures: 1 }) }, $set: { lastUsedAt: new Date() } },
    { upsert: true, setDefaultsOnInsert: true }
  ).catch(() => undefined);
};

const persistAiCooldown = (apiLabel: string, cooldownUntil: number): void => {
  void AiPoolUsage.findOneAndUpdate({ apiLabel }, { $set: { cooldownUntil: new Date(cooldownUntil) } }, { upsert: true }).catch(() => undefined);
};

export const clearAiTelemetry = async (): Promise<void> => {
  aiPoolUsage.clear();
  aiLogs.length = 0;
  keyCooldownUntil.clear();
  await Promise.all([AiPoolUsage.deleteMany({}), AiFailureLog.deleteMany({})]);
};

const getMentionedAssistant = (text = ''): Assistant | undefined => {
  const matches = (Object.values(assistants) as Assistant[])
    .map((assistant) => ({ assistant, index: text.search(assistant.aliases) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index);
  return matches[0]?.assistant;
};

export const isBotStopCommand = (text?: string): boolean =>
  /^\s*@(bot|campusbot|campus\s+bot|ai|campusai|campus\s+ai)\s+stop\b/i.test(text || '');

export const stopCampusBots = (): void => {
  stopGeneration += 1;
  for (const controller of activeRequests) controller.abort();
  activeRequests.clear();
};
export const getCampusBotsGeneration = (): number => stopGeneration;

export const isCampusBotMention = (text?: string): boolean => !!getMentionedAssistant(text);
export const getAssistantForMessage = (text?: string, replyTo?: any): Assistant | undefined => {
  if (isBotStopCommand(text)) return undefined;
  const mentioned = getMentionedAssistant(text);
  if (mentioned) return mentioned;
  const email = String(replyTo?.senderEmail || '').trim().toLowerCase();
  const name = String(replyTo?.senderName || '').trim().toLowerCase();
  return (Object.values(assistants) as Assistant[]).find((assistant) => email === assistant.email || name === assistant.name.toLowerCase());
};
export const isCampusBotReply = (replyTo?: any): boolean => {
  const email = String(replyTo?.senderEmail || '').trim().toLowerCase();
  const name = String(replyTo?.senderName || '').trim().toLowerCase();
  return email === CAMPUS_BOT_EMAIL || name === 'campus bot';
};
export const shouldCampusBotRespond = (text?: string, replyTo?: any): boolean => !!getAssistantForMessage(text, replyTo);

const getGeminiKeys = (): string[] => {
  const numberedKeys = Object.entries(process.env)
    .filter(([name, value]) => /^GEMINI_API_KEY_\d+$/.test(name) && value?.trim())
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value!.trim());
  const pooledKeys = (process.env.GEMINI_API_KEYS || '').split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
  const legacyKey = process.env.GEMINI_API_KEY?.trim();
  return Array.from(new Set([...numberedKeys, ...pooledKeys, ...(legacyKey ? [legacyKey] : [])]));
};
const getGeminiModels = (): string[] => {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured && configured.toLowerCase() !== 'auto' ? [configured] : MODEL_CANDIDATES;
};
const extractGeminiText = (payload: any): string => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim() : '';
};
const stripAssistantMentions = (text: string): string => text
  .replace(/^\s*@(bot|campusbot|campus\s+bot|ai|campusai|campus\s+ai)\b\s*/i, '').trim();

const getConversationPrompt = async (message: any, assistant: Assistant): Promise<string> => {
  const history: Array<{ id?: string; senderName: string; text: string }> = [];
  let parentReply = message.replyTo;
  let parentMessage: any = null;

  if (parentReply?.id) {
    parentMessage = await CommunityMessage.findById(parentReply.id).select('replyTo').lean();
  } else if (message.senderEmail) {
    const latestAssistantReply = await CommunityMessage.findOne({
      senderEmail: { $in: [CAMPUS_BOT_EMAIL, CAMPUS_AI_EMAIL] },
      'replyTo.senderEmail': message.senderEmail,
      ...(message.createdAt ? { createdAt: { $lt: message.createdAt } } : {})
    }).sort({ createdAt: -1 }).select('senderName senderEmail text replyTo').lean();
    if (latestAssistantReply) {
      const previousUserMessage = latestAssistantReply.replyTo;
      if (previousUserMessage?.text) {
        history.push({ id: previousUserMessage.id, senderName: previousUserMessage.senderName || 'Student', text: previousUserMessage.text });
      }
      history.push({ id: String(latestAssistantReply._id), senderName: latestAssistantReply.senderName, text: latestAssistantReply.text });
    }
  }

  if (parentMessage?.replyTo?.text) {
    history.push({ id: parentMessage.replyTo.id, senderName: parentMessage.replyTo.senderName || 'Student', text: parentMessage.replyTo.text });
  }
  if (parentReply?.text) {
    history.push({ id: parentReply.id, senderName: parentReply.senderName || 'Moi Student', text: parentReply.text });
  }
  history.push({ id: String(message._id), senderName: message.senderName || 'Student', text: message.text || '' });

  const uniqueHistory = history.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index).slice(-3);
  let remainingChars = 1100;
  const compactHistory = uniqueHistory.map((item) => {
    const charLimit = Math.min(450, remainingChars);
    const text = charLimit ? item.text.trim().slice(-charLimit) : '';
    remainingChars -= text.length;
    return `${item.senderName}: ${text}`;
  }).join('\n');
  return `Recent conversation (oldest first):\n${compactHistory}\n\nReply as ${assistant.name} to the latest message.`;
};

const askGemini = async (apiKey: string, apiLabel: string, model: string, messageText: string, assistant: Assistant, signal: AbortSignal): Promise<{ text: string; retryable: boolean }> => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const otherName = assistant.kind === 'bot' ? 'Campus AI' : 'Campus Bot';
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `You are ${assistant.name}, a helpful Moi University student assistant in MoiConnect. Answer concisely about campus life, academics, study guidance, rentals, and app features. Do not claim access to private student records. Another assistant named ${otherName} exists. If the user asks you to greet, ask, or pass a message to that assistant, include its exact mention (${assistant.kind === 'bot' ? '@ai' : '@bot'}) and a concise message so the handoff can happen. Otherwise, do not start assistant-to-assistant conversations.` }] },
        contents: [{ role: 'user', parts: [{ text: stripAssistantMentions(messageText) || messageText }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 300 }
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      updateAiUsage(apiLabel, 'failure');
      addAiLog({ level: response.status === 429 ? 'warn' : 'error', assistant: assistant.name, apiLabel, model, status: response.status, message: response.status === 429 ? 'Quota or rate limit reached.' : 'Gemini request failed.' });
      console.warn(`[${assistant.name}] Gemini attempt failed: api=${apiLabel}, model=${model}, status=${response.status}`);
      return { text: '', retryable: true };
    }
    const text = extractGeminiText(payload);
    updateAiUsage(apiLabel, text ? 'success' : 'failure');
    if (!text) addAiLog({ level: 'warn', assistant: assistant.name, apiLabel, model, message: 'Gemini returned no text.' });
    return { text, retryable: false };
  } catch (error: any) {
    if (!signal.aborted) {
      updateAiUsage(apiLabel, 'failure');
      addAiLog({ level: 'error', assistant: assistant.name, apiLabel, model, message: error?.name === 'AbortError' ? 'Request timed out.' : `Network or request error: ${String(error?.message || error).slice(0, 220)}` });
      console.warn(`[${assistant.name}] Gemini attempt unavailable: api=${apiLabel}, model=${model}`);
    }
    return { text: '', retryable: true };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
};

const generateReply = async (messageText: string, assistant: Assistant, signal: AbortSignal): Promise<string | null> => {
  const keys = getGeminiKeys();
  if (!keys.length) {
    addAiLog({ level: 'error', assistant: assistant.name, message: 'No Gemini API keys are configured.' });
    console.warn(`[${assistant.name}] No Gemini API keys are configured.`);
    return CAMPUS_BOT_FALLBACK;
  }
  const models = getGeminiModels();
  const firstKeyIndex = preferredKeyIndex % keys.length;
  const firstModelIndex = preferredModelIndex % models.length;

  // Try every API/model combination before returning the fallback response.
  // Cooldowns are telemetry and routing hints, not a reason to skip the full fallback cycle.
  for (let keyOffset = 0; keyOffset < keys.length; keyOffset += 1) {
    const selectedKeyIndex = (firstKeyIndex + keyOffset) % keys.length;
    const apiKey = keys[selectedKeyIndex];
    const apiLabel = getApiLabel(selectedKeyIndex);
    let keySucceeded = false;

    for (let modelOffset = 0; modelOffset < models.length; modelOffset += 1) {
      const modelIndex = (firstModelIndex + modelOffset) % models.length;
      const model = models[modelIndex];
      const result = await askGemini(apiKey, apiLabel, model, messageText, assistant, signal);
      if (signal.aborted) return null;
      if (result.text) {
        keySucceeded = true;
        preferredKeyIndex = (selectedKeyIndex + 1) % keys.length;
        preferredModelIndex = (modelIndex + 1) % models.length;
        keyCooldownUntil.delete(apiKey);
        return result.text;
      }
    }

    if (!keySucceeded) {
      const cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
      keyCooldownUntil.set(apiKey, cooldownUntil);
      persistAiCooldown(apiLabel, cooldownUntil);
    }
  }

  // The whole pool failed. Start the next request from API 1/model 1 again.
  preferredKeyIndex = 0;
  preferredModelIndex = 0;
  addAiLog({ level: 'error', assistant: assistant.name, message: `All ${keys.length} API(s) and ${models.length} model(s) failed. Returning the final unavailable response.` });
  return CAMPUS_BOT_FALLBACK;
};

type ConversationHooks = {
  onTyping?: (assistant: Assistant, typing: boolean) => void;
  onReply?: (message: any) => void;
};

export const runCampusBotConversation = async (message: any, hooks: ConversationHooks = {}, requestedGeneration = stopGeneration): Promise<void> => {
  if (!message?._id || !shouldCampusBotRespond(message.text, message.replyTo)) return;
  const generationAtStart = requestedGeneration;
  let source = message;
  let assistant = getAssistantForMessage(source.text, source.replyTo);
  for (let turn = 0; assistant && turn < MAX_TURNS_PER_CHAIN; turn += 1) {
    if (generationAtStart !== stopGeneration) return;
    const sourceId = String(source._id);
    if (inFlightReplies.has(sourceId)) return;
    inFlightReplies.add(sourceId);
    const controller = new AbortController();
    activeRequests.add(controller);
    let typingAssistant = assistant;
    hooks.onTyping?.(typingAssistant, true);
    let saved: any;
    let responseText = '';
    try {
      const existing = await CommunityMessage.findOne({ botReplyFor: sourceId });
      if (existing) return;
      if (generationAtStart !== stopGeneration) return;
      const prompt = await getConversationPrompt(source, assistant);
      if (generationAtStart !== stopGeneration) return;
      responseText = (await generateReply(prompt, assistant, controller.signal)) || '';
      if (!responseText || generationAtStart !== stopGeneration) return;
      saved = await CommunityMessage.create({
        botReplyFor: sourceId,
        senderId: assistant.id,
        senderName: assistant.name,
        senderEmail: assistant.email,
        senderFaculty: 'MoiConnect AI Assistant',
        avatarBg: assistant.avatarBg,
        text: responseText,
        replyTo: { id: sourceId, senderName: source.senderName || 'Student', senderEmail: source.senderEmail || '', text: source.text || '' },
        reactions: {}
      });
      if (generationAtStart !== stopGeneration) {
        await CommunityMessage.deleteOne({ _id: saved._id });
        return;
      }
    } catch (error: any) {
      if (error?.code === 11000) return;
      throw error;
    } finally {
      activeRequests.delete(controller);
      inFlightReplies.delete(sourceId);
      hooks.onTyping?.(typingAssistant, false);
    }
    hooks.onReply?.(saved);
    const nextAssistant = getMentionedAssistant(responseText);
    if (!nextAssistant || nextAssistant.kind === assistant.kind) return;
    source = saved;
    assistant = nextAssistant;
  }
};
