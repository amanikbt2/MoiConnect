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

export const getAiPromptSettings = async (): Promise<AiPromptSettings> => {
  const stored = await getAppSettingValue<Partial<AiPromptSettings> | null>('aiAssistantPromptSettings', null);
  if (stored && typeof stored === 'object') {
    return {
      context: cleanPromptSetting(stored.context, ''),
      persona: cleanPromptSetting(stored.persona, ''),
      responseRules: cleanPromptSetting(stored.responseRules, ''),
      safetyRules: cleanPromptSetting(stored.safetyRules, '')
    };
  }

  // Preserve original single-context setting created by older deployments.
  return {
    ...DEFAULT_AI_PROMPT_SETTINGS,
    context: cleanPromptSetting(await getAppSettingValue('aiAssistantContext', ''), '')
  };
};

export const saveAiPromptSettings = async (settings: Partial<AiPromptSettings>): Promise<AiPromptSettings> => {
  const saved: AiPromptSettings = {
    context: cleanPromptSetting(settings.context, ''),
    persona: cleanPromptSetting(settings.persona, ''),
    responseRules: cleanPromptSetting(settings.responseRules, ''),
    safetyRules: cleanPromptSetting(settings.safetyRules, '')
  };
  await setAppSettingValue('aiAssistantPromptSettings', saved);
  await setAppSettingValue('aiAssistantContext', saved.context);
  return saved;
};

export const getAiContext = async (): Promise<string> => (await getAiPromptSettings()).context;
export const saveAiContext = async (context: string): Promise<string> => (await saveAiPromptSettings({ ...(await getAiPromptSettings()), context })).context;

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
const stripAssistantMentions = (text: string): string => text
  .replace(/^\s*@(bot|campusbot|campus\s+bot|ai|campusai|campus\s+ai)\b\s*/i, '').trim();

const getConversationPrompt = async (message: any, _assistant: Assistant): Promise<string> => {
  const studentName = String(message.senderName || 'Student').trim();
  const studentMessage = stripAssistantMentions(String(message.text || '').trim());

  // Direct mention without swipe reply -> keep strictly name + message to save tokens
  if (!message.replyTo) {
    return `Student name: ${studentName}\nStudent message: ${studentMessage}`;
  }

  // Swipe to reply -> include immediate reply context (replied message + previous user prompt if applicable)
  const promptLines: string[] = [];
  const replyToObj = message.replyTo;
  const replyTargetId = replyToObj.id || replyToObj._id;

  if (replyTargetId) {
    const repliedDoc = await CommunityMessage.findById(replyTargetId).catch(() => null);
    if (repliedDoc?.botReplyFor) {
      const origUserDoc = await CommunityMessage.findById(repliedDoc.botReplyFor).catch(() => null);
      if (origUserDoc?.text) {
        const origText = stripAssistantMentions(String(origUserDoc.text).trim());
        if (origText) {
          promptLines.push(`Previous user message: ${origText}`);
        }
      }
    }
  }

  const replySender = String(replyToObj.senderName || 'User').trim();
  const replyText = stripAssistantMentions(String(replyToObj.text || '').trim());
  if (replyText) {
    promptLines.push(`Replied message (${replySender}): ${replyText}`);
  }

  promptLines.push(`Student name: ${studentName}`);
  promptLines.push(`Student message: ${studentMessage}`);

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
      contents: [{ role: 'user', parts: [{ text: stripAssistantMentions(messageText) || messageText }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 300 }
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
  const promptSettings = await getAiPromptSettings();
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

export const runCampusBotConversation = async (message: any, hooks: ConversationHooks = {}, requestedGeneration = stopGeneration): Promise<void> => {
  if (!message?._id || !shouldCampusBotRespond(message.text, message.replyTo)) return;
  const generationAtStart = requestedGeneration;
  let source = message;
  let assistant = getAssistantForMessage(source.text, source.replyTo);
  for (let turn = 0; assistant && turn < MAX_TURNS_PER_CHAIN; turn += 1) {
    if (generationAtStart !== stopGeneration) return;
    const sourceId = String(source._id);
    const clientKey = source.clientMsgId ? String(source.clientMsgId) : sourceId;
    if (inFlightReplies.has(sourceId) || inFlightReplies.has(clientKey)) return;
    inFlightReplies.add(sourceId);
    inFlightReplies.add(clientKey);
    const controller = new AbortController();
    activeRequests.add(controller);
    let typingAssistant = assistant;
    hooks.onTyping?.(typingAssistant, true);
    let saved: any;
    let responseText = '';
    try {
      const existing = await CommunityMessage.findOne({
        $or: [
          { botReplyFor: sourceId },
          ...(source.clientMsgId ? [{ clientMsgId: `bot_${source.clientMsgId}` }] : [])
        ]
      });
      if (existing) return;
      if (generationAtStart !== stopGeneration) return;
      const prompt = await getConversationPrompt(source, assistant);
      if (generationAtStart !== stopGeneration) return;
      responseText = (await generateReply(prompt, assistant, controller.signal)) || '';
      if (!responseText || generationAtStart !== stopGeneration) return;
      saved = await CommunityMessage.create({
        botReplyFor: sourceId,
        clientMsgId: source.clientMsgId ? `bot_${source.clientMsgId}` : undefined,
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
      inFlightReplies.delete(clientKey);
      hooks.onTyping?.(typingAssistant, false);
    }
    hooks.onReply?.(saved);
    if (responseText === CAMPUS_BOT_FALLBACK) break;
    const nextAssistant = getMentionedAssistant(responseText);
    if (!nextAssistant || nextAssistant.kind === assistant.kind) break;
    source = saved;
    assistant = nextAssistant;
  }
};
