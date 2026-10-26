import { Types } from 'mongoose';
import { CommunityMessage } from '../models/CommunityMessage';
import { AiFailureLog, AiPoolUsage } from '../models/AiTelemetry';
import { getAppSettingValue, setAppSettingValue } from '../models/AppSetting';

export const CAMPUS_BOT_FALLBACK = "Sorry, i'm not available at the moment";
export const INTERNET_ERROR_FALLBACK = "Sorry, i can't respond now. check your internet";
export const CAMPUS_BOT_EMAIL = 'campusbot@moiconnect.app';
export const CAMPUS_AI_EMAIL = 'campusai@moiconnect.app';
export const DEFAULT_AI_CONTEXT = '';
export interface AiPromptSettings {
  context: string;
  persona: string;
  responseRules: string;
  safetyRules: string;
}

export const DEFAULT_AI_PROMPT_SETTINGS: AiPromptSettings = {
  context: '',
  persona: '',
  responseRules: '',
  safetyRules: ''
};

const cleanPromptSetting = (value: unknown, fallback: string = ''): string => typeof value === 'string' ? value.trim().slice(0, 5000) : fallback;

export type AssistantKind = 'bot' | 'ai';

const cleanAiPromptSettings = (stored: any): AiPromptSettings => ({
  context: cleanPromptSetting(stored?.context, ''),
  persona: cleanPromptSetting(stored?.persona, ''),
  responseRules: cleanPromptSetting(stored?.responseRules, ''),
  safetyRules: cleanPromptSetting(stored?.safetyRules, '')
});

export const getAiPromptSettings = async (assistant: AssistantKind = 'bot'): Promise<AiPromptSettings> => {
  const assistantSettings = await getAppSettingValue<Partial<AiPromptSettings> | null>(`aiAssistantPromptSettings_${assistant}`, null);
  if (assistantSettings && typeof assistantSettings === 'object') return cleanAiPromptSettings(assistantSettings);

  // Older installs used one shared setting. Keep that context available to both
  // assistants until each assistant is independently customized.
  const stored = await getAppSettingValue<Partial<AiPromptSettings> | null>('aiAssistantPromptSettings', null);
  if (stored && typeof stored === 'object') {
    return cleanAiPromptSettings(stored);
  }

  // Preserve original single-context setting created by older deployments.
  return {
    ...DEFAULT_AI_PROMPT_SETTINGS,
    context: cleanPromptSetting(await getAppSettingValue('aiAssistantContext', ''), '')
  };
};

export const saveAiPromptSettings = async (settings: Partial<AiPromptSettings>, assistant: AssistantKind = 'bot'): Promise<AiPromptSettings> => {
  const saved: AiPromptSettings = {
    context: cleanPromptSetting(settings.context, ''),
    persona: cleanPromptSetting(settings.persona, ''),
    responseRules: cleanPromptSetting(settings.responseRules, ''),
    safetyRules: cleanPromptSetting(settings.safetyRules, '')
  };
  await setAppSettingValue(`aiAssistantPromptSettings_${assistant}`, saved);
  return saved;
};

export const getAiContext = async (assistant: AssistantKind = 'bot'): Promise<string> => (await getAiPromptSettings(assistant)).context;
export const saveAiContext = async (context: string, assistant: AssistantKind = 'bot'): Promise<string> => (await saveAiPromptSettings({ ...(await getAiPromptSettings(assistant)), context }, assistant)).context;

type Assistant = { kind: AssistantKind; name: string; email: string; id: Types.ObjectId; avatarBg: string; aliases: RegExp };
const assistants: Record<AssistantKind, Assistant> = {
  bot: { kind: 'bot', name: 'Campus Bot', email: CAMPUS_BOT_EMAIL, id: new Types.ObjectId('000000000000000000000001'), avatarBg: '#6366f1', aliases: /(?:^|[^\w@])@(bot|campusbot|campus[\s_]+bot)\b/i },
  ai: { kind: 'ai', name: 'Campus AI', email: CAMPUS_AI_EMAIL, id: new Types.ObjectId('000000000000000000000002'), avatarBg: '#d4a017', aliases: /(?:^|[^\w@])@(ai|campusai|campus[\s_]+ai)\b/i }
};
// Allow enough time for a complete, detailed answer instead of aborting while
// Gemini is still generating. The user can still stop an active generation.
const REQUEST_TIMEOUT_MS = 120_000;
const KEY_COOLDOWN_MS = 60_000;
const MODEL_CANDIDATES = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
export const DEFAULT_AI_TURN_LIMIT = 4;
export const MIN_AI_TURN_LIMIT = 1;
export const MAX_AI_TURN_LIMIT = 20;
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

export const getAiConversationTurnLimit = async (): Promise<number> => {
  const stored = Number(await getAppSettingValue('aiConversationTurnLimit', DEFAULT_AI_TURN_LIMIT));
  return Number.isInteger(stored) ? Math.max(MIN_AI_TURN_LIMIT, Math.min(MAX_AI_TURN_LIMIT, stored)) : DEFAULT_AI_TURN_LIMIT;
};

export const saveAiConversationTurnLimit = async (limit: number): Promise<number> => {
  const safeLimit = Math.max(MIN_AI_TURN_LIMIT, Math.min(MAX_AI_TURN_LIMIT, Math.trunc(limit)));
  await setAppSettingValue('aiConversationTurnLimit', safeLimit);
  return safeLimit;
};

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

export const getAssistantKind = (senderOrMessage?: any): AssistantKind | undefined => {
  if (!senderOrMessage) return undefined;
  const email = String(senderOrMessage.senderEmail || senderOrMessage.email || '').trim().toLowerCase();
  const name = String(senderOrMessage.senderName || senderOrMessage.name || '').trim().toLowerCase();
  const id = String(senderOrMessage.senderId?._id || senderOrMessage.senderId || senderOrMessage.id || senderOrMessage._id || '').trim();
  const faculty = String(senderOrMessage.senderFaculty || senderOrMessage.faculty || '').trim();

  if (
    email === CAMPUS_BOT_EMAIL ||
    email.includes('campusbot') ||
    name === 'campus bot' ||
    name === 'bot' ||
    name.includes('campus bot') ||
    name.replace(/[\s_]/g, '') === 'campusbot' ||
    id === '000000000000000000000001' ||
    id === 'campus-bot'
  ) {
    return 'bot';
  }
  if (
    email === CAMPUS_AI_EMAIL ||
    email.includes('campusai') ||
    name === 'campus ai' ||
    name === 'ai' ||
    name.includes('campus ai') ||
    name.replace(/[\s_]/g, '') === 'campusai' ||
    id === '000000000000000000000002' ||
    id === 'campus-ai'
  ) {
    return 'ai';
  }
  if (faculty === 'AI assistant') {
    if (name.includes('bot') || email.includes('bot')) return 'bot';
    if (name.includes('ai') || email.includes('ai')) return 'ai';
  }
  return undefined;
};

export const isAssistantSender = (senderOrMessage?: any): boolean => !!getAssistantKind(senderOrMessage);

export const getMentionedAssistant = (text = '', excludeKind?: AssistantKind): Assistant | undefined => {
  const list = Object.values(assistants) as Assistant[];
  const candidates = excludeKind ? list.filter((a) => a.kind !== excludeKind) : list;
  const matches = candidates
    .map((assistant) => ({ assistant, index: text.search(assistant.aliases) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index);
  return matches[0]?.assistant;
};

export const isBotStopCommand = (text?: string): boolean =>
  /^\s*@(bot|campusbot|campus[\s_]+bot|ai|campusai|campus[\s_]+ai)\s+stop\b/i.test(text || '');

export const stopCampusBots = (): void => {
  stopGeneration += 1;
  for (const controller of activeRequests) controller.abort();
  activeRequests.clear();
};
export const getCampusBotsGeneration = (): number => stopGeneration;

export const isCampusBotMention = (text?: string, excludeKind?: AssistantKind): boolean => !!getMentionedAssistant(text, excludeKind);

export const getAssistantForMessage = (
  text?: string,
  replyTo?: any,
  excludeKind?: AssistantKind
): Assistant | undefined => {
  if (isBotStopCommand(text)) return undefined;

  // 1. Explicit mention in text takes highest precedence
  const mentioned = getMentionedAssistant(text, excludeKind);
  if (mentioned) return mentioned;

  // 2. Direct swipe-reply to an assistant message
  if (replyTo) {
    const replyKind = getAssistantKind(replyTo);
    if (replyKind && replyKind !== excludeKind) {
      return assistants[replyKind];
    }
    const email = String(replyTo.senderEmail || '').trim().toLowerCase();
    const name = String(replyTo.senderName || '').trim().toLowerCase();
    const list = excludeKind
      ? (Object.values(assistants) as Assistant[]).filter((a) => a.kind !== excludeKind)
      : (Object.values(assistants) as Assistant[]);

    const found = list.find((a) => {
      if (email && email === a.email.toLowerCase()) return true;
      if (name && (name === a.name.toLowerCase() || name.replace(/[\s_]/g, '') === a.name.toLowerCase().replace(/[\s_]/g, ''))) return true;
      if (a.kind === 'bot' && (name.includes('campus bot') || name === 'bot' || email.includes('campusbot'))) return true;
      if (a.kind === 'ai' && (name.includes('campus ai') || name === 'ai' || email.includes('campusai'))) return true;
      return false;
    });
    if (found) return found;
  }

  return undefined;
};

export const isCampusBotReply = (replyTo?: any): boolean => !!getAssistantKind(replyTo);

export const shouldCampusBotRespond = (text?: string, replyTo?: any, sender?: any): boolean => {
  if (isBotStopCommand(text)) return false;
  const senderKind = getAssistantKind(sender);
  return !!getAssistantForMessage(text, replyTo, senderKind);
};

const getGeminiKeys = (): string[] => {
  const pooledKeys = (process.env.GEMINI_API_KEYS || '').split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
  if (pooledKeys.length > 0) return Array.from(new Set(pooledKeys));

  const numberedKeys = Object.entries(process.env)
    .filter(([name, value]) => /^GEMINI_API_KEY_\d+$/.test(name) && value?.trim())
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, value]) => value!.trim());
  const legacyKey = process.env.GEMINI_API_KEY?.trim();
  return Array.from(new Set([...numberedKeys, ...(legacyKey ? [legacyKey] : [])]));
};
const getGeminiModels = (): string[] => {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured && configured.toLowerCase() !== 'auto' ? [configured] : MODEL_CANDIDATES;
};
const extractGeminiText = (payload: any): string => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim() : '';
};
export const cleanLeadingAssistantMention = (text: string): string => text
  .replace(/^(?:\s*['"\(]?@[a-z0-9_]+['"\)]?[:,\s]*)+/i, '')
  .trim();
export const stripAssistantMentions = cleanLeadingAssistantMention;

const getConversationPrompt = async (message: any, assistant: Assistant): Promise<string> => {
  const isFromAssistant = isAssistantSender(message);
  const senderName = String(message.senderName || (isFromAssistant ? 'Assistant' : 'Student')).trim();
  const rawText = String(message.text || '').trim();
  const messageText = cleanLeadingAssistantMention(rawText) || rawText;

  const promptLines: string[] = [];
  const replyToObj = message.replyTo;
  const replyTargetId = replyToObj?.id || replyToObj?._id;

  if (replyTargetId) {
    let currId: string | undefined = String(replyTargetId);
    const threadChain: { sender: string; text: string }[] = [];
    const visited = new Set<string>();

    for (let depth = 0; depth < 4 && currId && !visited.has(currId); depth++) {
      visited.add(currId);
      const doc: any = await CommunityMessage.findById(currId).lean().catch(() => null);
      if (!doc) break;
      const docText = String(doc.text || '').trim();
      if (docText) {
        threadChain.unshift({
          sender: doc.senderName || 'User',
          text: docText
        });
      }
      currId = doc.replyTo?.id ? String(doc.replyTo.id) : (doc.botReplyFor ? String(doc.botReplyFor).replace(/_(bot|ai)$/, '') : undefined);
    }

    if (threadChain.length > 0) {
      promptLines.push('--- Conversation Context ---');
      for (const item of threadChain) {
        promptLines.push(`${item.sender}: ${item.text}`);
      }
      promptLines.push('-----------------------------');
    }
  }

  if (isFromAssistant) {
    promptLines.push(`You are in a lively conversation with ${senderName} in the Moi University campus forum.`);
    promptLines.push(`Latest message from ${senderName}: ${rawText}`);
    promptLines.push(`Respond directly to ${senderName}. Be conversational, witty, concise (1-3 sentences), and friendly. Tag @${senderName.toLowerCase().includes('bot') ? 'bot' : 'ai'} naturally.`);
  } else {
    promptLines.push(`Student name: ${senderName}`);
    promptLines.push(`Student message: ${messageText}`);
  }

  return promptLines.join('\n');
};

const askGemini = async (apiKey: string, apiLabel: string, model: string, messageText: string, assistant: Assistant, promptSettings: AiPromptSettings, signal: AbortSignal): Promise<{ text: string; isNetworkError?: boolean; retryable: boolean }> => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const parts: string[] = [];
    if (promptSettings.context?.trim()) {
      parts.push(`Primary context:\n${promptSettings.context.trim()}`);
    }
    if (promptSettings.persona?.trim()) {
      parts.push(`Persona and tone:\n${promptSettings.persona.trim()}`);
    }
    if (promptSettings.responseRules?.trim()) {
      parts.push(`Response rules:\n${promptSettings.responseRules.trim()}`);
    }
    if (promptSettings.safetyRules?.trim()) {
      parts.push(`Safety and privacy rules:\n${promptSettings.safetyRules.trim()}`);
    }
    const systemInstructionText = parts.join('\n\n');

    const requestBody: any = {
      contents: [{ role: 'user', parts: [{ text: messageText }] }],
      // 8,192 is the common supported output ceiling across the configured
      // fallback models. This replaces the old 300-token cap that cut answers
      // off early; the model/provider still enforces its own hard maximum.
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
    };

    if (systemInstructionText.trim()) {
      requestBody.systemInstruction = { parts: [{ text: systemInstructionText.trim() }] };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      updateAiUsage(apiLabel, 'failure');
      addAiLog({ level: response.status === 429 ? 'warn' : 'error', assistant: assistant.name, apiLabel, model, status: response.status, message: response.status === 429 ? 'Quota or rate limit reached.' : 'Gemini request failed.' });
      console.warn(`[${assistant.name}] Gemini attempt failed: api=${apiLabel}, model=${model}, status=${response.status}`);
      return { text: '', isNetworkError: false, retryable: true };
    }
    const text = extractGeminiText(payload);
    updateAiUsage(apiLabel, text ? 'success' : 'failure');
    if (!text) addAiLog({ level: 'warn', assistant: assistant.name, apiLabel, model, message: 'Gemini returned no text.' });
    return { text, isNetworkError: false, retryable: false };
  } catch (error: any) {
    if (!signal.aborted) {
      updateAiUsage(apiLabel, 'failure');
      addAiLog({ level: 'error', assistant: assistant.name, apiLabel, model, message: error?.name === 'AbortError' ? 'Request timed out.' : `Network or request error: ${String(error?.message || error).slice(0, 220)}` });
      console.warn(`[${assistant.name}] Gemini attempt unavailable: api=${apiLabel}, model=${model}`);
    }
    return { text: '', isNetworkError: true, retryable: true };
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
  const promptSettings = await getAiPromptSettings(assistant.kind);
  const firstKeyIndex = preferredKeyIndex % keys.length;
  const firstModelIndex = preferredModelIndex % models.length;

  let totalAttempts = 0;
  let networkErrorCount = 0;

  for (let keyOffset = 0; keyOffset < keys.length; keyOffset += 1) {
    const selectedKeyIndex = (firstKeyIndex + keyOffset) % keys.length;
    const apiKey = keys[selectedKeyIndex];
    const apiLabel = getApiLabel(selectedKeyIndex);
    let keySucceeded = false;

    for (let modelOffset = 0; modelOffset < models.length; modelOffset += 1) {
      const modelIndex = (firstModelIndex + modelOffset) % models.length;
      const model = models[modelIndex];
      totalAttempts += 1;
      const result = await askGemini(apiKey, apiLabel, model, messageText, assistant, promptSettings, signal);
      if (signal.aborted) return null;
      if (result.text) {
        keySucceeded = true;
        preferredKeyIndex = (selectedKeyIndex + 1) % keys.length;
        preferredModelIndex = (modelIndex + 1) % models.length;
        keyCooldownUntil.delete(apiKey);
        return result.text;
      }
      if (result.isNetworkError) {
        networkErrorCount += 1;
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

  if (totalAttempts > 0 && networkErrorCount === totalAttempts) {
    addAiLog({ level: 'error', assistant: assistant.name, message: 'Network / internet connection error. Returning internet offline fallback.' });
    return INTERNET_ERROR_FALLBACK;
  }

  addAiLog({ level: 'error', assistant: assistant.name, message: `All ${keys.length} API(s) and ${models.length} model(s) failed. Returning AI pool quota fallback.` });
  return CAMPUS_BOT_FALLBACK;
};

type ConversationHooks = {
  onTyping?: (assistant: Assistant, typing: boolean) => void;
  onReply?: (message: any) => void;
};

export const runCampusBotConversation = async (
  message: any,
  hooks: ConversationHooks = {},
  requestedGeneration = stopGeneration,
  chainTurnOverride?: number
): Promise<void> => {
  if (!message?._id) return;
  const generationAtStart = requestedGeneration;
  if (generationAtStart !== stopGeneration) return;

  const senderKind = getAssistantKind(message);
  const isFromAssistant = !!senderKind;
  const assistant = getAssistantForMessage(message.text, message.replyTo, senderKind);
  if (!assistant) return;
  if (senderKind && assistant.kind === senderKind) return;

  // Determine turn count in current chain
  const currentTurn = chainTurnOverride !== undefined
    ? chainTurnOverride
    : (isFromAssistant ? (Number(message.aiChainTurnCount) || 1) + 1 : 1);

  // If this turn is between assistants, enforce the configured AI-to-AI turn limit
  if (isFromAssistant) {
    const turnLimit = await getAiConversationTurnLimit();
    if (currentTurn > turnLimit) {
      addAiLog({
        level: 'info',
        assistant: assistant.name,
        message: `AI-to-AI conversation reached turn limit (${turnLimit} turns). No further response triggered.`
      });
      return;
    }
  }

  const sourceId = String(message._id);
  const replyLockKey = `${assistant.kind}_${sourceId}`;
  if (inFlightReplies.has(replyLockKey)) return;
  inFlightReplies.add(replyLockKey);

  const controller = new AbortController();
  activeRequests.add(controller);
  const typingAssistant = assistant;
  hooks.onTyping?.(typingAssistant, true);
  let saved: any;
  let responseText = '';

  try {
    const existing = await CommunityMessage.findOne({
      botReplyFor: `${sourceId}_${assistant.kind}`
    });
    if (existing) return;
    if (generationAtStart !== stopGeneration) return;

    const disableAiFeatures = await getAppSettingValue('disableAiFeatures', false);
    if (disableAiFeatures) {
      responseText = 'Sorry, Im disabled for now';
      addAiLog({ level: 'warn', assistant: assistant.name, message: 'AI feature is disabled in Admin Settings. Replied with disabled notice.' });
    } else {
      const prompt = await getConversationPrompt(message, assistant);
      if (generationAtStart !== stopGeneration) return;
      responseText = (await generateReply(prompt, assistant, controller.signal)) || '';
    }
    if (!responseText || generationAtStart !== stopGeneration) return;

    saved = await CommunityMessage.create({
      botReplyFor: `${sourceId}_${assistant.kind}`,
      clientMsgId: message.clientMsgId ? `bot_${assistant.kind}_${message.clientMsgId}` : undefined,
      senderId: assistant.id,
      senderName: assistant.name,
      senderEmail: assistant.email,
      senderFaculty: 'AI assistant',
      senderCourse: 'AI assistant',
      senderYear: 'AI assistant',
      senderPhone: 'AI assistant',
      avatarBg: assistant.avatarBg,
      text: responseText,
      replyTo: {
        id: sourceId,
        senderName: message.senderName || (senderKind === 'ai' ? 'Campus AI' : (senderKind === 'bot' ? 'Campus Bot' : 'Student')),
        senderEmail: message.senderEmail || '',
        text: message.text || ''
      },
      aiChainTurnCount: currentTurn,
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
    inFlightReplies.delete(replyLockKey);
    hooks.onTyping?.(typingAssistant, false);
  }

  // 1. Emit the assistant reply to room
  hooks.onReply?.(saved);

  // 2. Check if this assistant reply triggers the OTHER assistant in an AI-to-AI conversation
  if (generationAtStart === stopGeneration) {
    const nextAssistant = getAssistantForMessage(saved.text, saved.replyTo, assistant.kind);
    if (nextAssistant && nextAssistant.kind !== assistant.kind) {
      const turnLimit = await getAiConversationTurnLimit();
      const nextTurn = currentTurn + 1;
      if (nextTurn <= turnLimit) {
        // Natural human-like conversational pause (1.3s) before the other assistant replies
        setTimeout(() => {
          if (generationAtStart !== stopGeneration) return;
          void runCampusBotConversation(saved, hooks, generationAtStart, nextTurn).catch((err) => {
            console.error('[AI-to-AI Chain Error]:', err);
          });
        }, 1300);
      } else {
        addAiLog({
          level: 'info',
          assistant: assistant.name,
          message: `AI-to-AI conversation reached turn limit (${turnLimit} turns). Chain completed.`
        });
      }
    }
  }
};
