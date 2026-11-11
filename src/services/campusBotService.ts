import { Types } from 'mongoose';
import { CommunityMessage } from '../models/CommunityMessage';
import { Paper } from '../models/Paper';
import { AiFailureLog, AiPoolUsage } from '../models/AiTelemetry';
import { getAppSettingValue, setAppSettingValue } from '../models/AppSetting';
import { getSignedCloudinaryUrl } from './tempFileService';

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
type ResourceMarkerKind = 'P' | 'C' | 'N';
type ResourceMatch = { text: string; attachment?: any };
const RESOURCE_MARKER_REGEX = />>\s*\/\s*([PCN])\s*\/\s*([^\r\n<>]{2,120})/i;
const NO_EXACT_MATCH_REPLIES = [
  'Okay {name}, I couldn’t find an exact match for {query}, but this related material may still help.',
  'I couldn’t spot an exact {query} match, {name}. Here’s the closest useful material I found.',
  '{name}, I didn’t find that exact course material. This related resource looks like the best fit.',
  'No exact match came up for {query}, {name}, but I found one nearby match you could try.',
  'I checked for {query}, {name}. I couldn’t find an exact copy, so I’ve attached the closest result.',
  '{name}, I couldn’t locate the exact material yet. This one is the closest match in the library.',
  'I don’t have an exact {query} result, {name}, but this related paper or note may be useful.',
  'Sorry, {name}, there isn’t an exact match for {query} right now. I found this close alternative.',
  '{name}, I couldn’t find the exact course item. Here’s the most relevant result I could find.',
  'I came up short on an exact {query} match, {name}. This related material may be worth a look.'
];
const NO_MATCH_REPLIES = [
  'Sorry {name}, I couldn’t find a {query} match yet. Try another course code or a shorter search; we’re working on adding more materials.',
  '{name}, I couldn’t locate {query} in the library. Could you try another course code? We’re working to add more materials.',
  'I’m sorry, {name}—nothing matched {query} this time. Try a different course code or search phrase while we keep building the collection.',
  'No {query} material turned up, {name}. If you try another code or course name, I can check again. We’re adding more resources.',
  '{name}, I couldn’t find that item yet. Try searching with a different course code; we’re working on growing the library.',
  'Sorry, I don’t have a match for {query} right now, {name}. Send another course code or keyword and I’ll look again.',
  'I checked the available materials, {name}, but couldn’t find {query}. We’re working on adding more—try another course code meanwhile.',
  '{name}, that search didn’t return a suitable material. Could you try a shorter title or another course code?',
  'I couldn’t find {query} in the current collection, {name}. Try another search; more materials are being added.',
  'Sorry {name}, I don’t have a suitable result for that request yet. Try another course code or title and I’ll check.'
];
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
export const getAiPlaygroundOptions = (): { apis: { apiIndex: number; apiLabel: string }[]; models: string[] } => ({
  apis: getGeminiKeys().map((_key, apiIndex) => ({ apiIndex, apiLabel: getApiLabel(apiIndex) })),
  models: getGeminiModels()
});

const buildSystemInstructionText = (promptSettings: AiPromptSettings): string => {
  const parts: string[] = [];
  if (promptSettings.context?.trim()) parts.push(`Primary context:\n${promptSettings.context.trim()}`);
  if (promptSettings.persona?.trim()) parts.push(`Persona and tone:\n${promptSettings.persona.trim()}`);
  if (promptSettings.responseRules?.trim()) parts.push(`Response rules:\n${promptSettings.responseRules.trim()}`);
  if (promptSettings.safetyRules?.trim()) parts.push(`Safety and privacy rules:\n${promptSettings.safetyRules.trim()}`);
  return parts.join('\n\n');
};

export const testAiPlayground = async (input: { apiIndex?: number; customApiKey?: string; model: string; message: string; assistantKind?: AssistantKind }): Promise<{ text: string; model: string; apiLabel: string; assistant: string; durationMs: number }> => {
  const message = input.message.trim();
  const model = input.model.trim();
  if (!message || message.length > 4000) throw new Error('Enter a message of 1 to 4,000 characters.');
  if (!model || model.length > 100 || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Enter a valid Gemini model name.');

  const customApiKey = input.customApiKey?.trim();
  const configuredKeys = getGeminiKeys();
  let apiKey = '';
  let apiLabel = 'Custom API';
  if (customApiKey) {
    if (customApiKey.length > 500) throw new Error('The API key is too long.');
    apiKey = customApiKey;
  } else {
    if (!Number.isInteger(input.apiIndex) || input.apiIndex! < 0 || input.apiIndex! >= configuredKeys.length) {
      throw new Error('Select a configured API from the server pool.');
    }
    apiKey = configuredKeys[input.apiIndex!];
    apiLabel = getApiLabel(input.apiIndex!);
  }

  const assistantKind = input.assistantKind === 'bot' ? 'bot' : 'ai';
  const assistantName = assistantKind === 'bot' ? 'Campus Bot' : 'Campus AI';
  const promptSettings = await getAiPromptSettings(assistantKind);
  const systemInstructionText = buildSystemInstructionText(promptSettings);
  const requestBody: any = {
    contents: [{ role: 'user', parts: [{ text: `Student name: Admin\nStudent message: ${message}` }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
  };
  if (systemInstructionText) requestBody.systemInstruction = { parts: [{ text: systemInstructionText }] };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(requestBody)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const providerMessage = String(payload?.error?.message || response.statusText || 'Provider request failed.')
        .replaceAll(apiKey, '[redacted API key]')
        .slice(0, 500);
      const error: any = new Error(providerMessage);
      error.providerStatus = response.status;
      throw error;
    }
    const text = extractGeminiText(payload);
    if (!text) {
      const error: any = new Error('The provider returned no text.');
      error.providerStatus = response.status;
      throw error;
    }
    return { text, model, apiLabel, assistant: assistantName, durationMs: Date.now() - startedAt };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      const timeoutError: any = new Error('The API request timed out.');
      timeoutError.providerStatus = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
const extractGeminiText = (payload: any): string => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim() : '';
};

const normalizeMaterialText = (value: unknown): string => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const getMaterialTypeQuery = (kind: ResourceMarkerKind): any => kind === 'P'
  ? { $in: ['past_paper', 'solution', 'exam'] }
  : kind === 'C'
    ? { $in: ['cat', 'quiz'] }
    : { $in: ['notes', 'revision', 'lecture_notes'] };
const formatResourceTypeName = (kind: ResourceMarkerKind): string => kind === 'P' ? 'past paper' : kind === 'C' ? 'CAT material' : 'notes';
const choosePersonalizedReply = (templates: string[], name: string, query: string): string => {
  const template = templates[Math.floor(Math.random() * templates.length)];
  const safeName = (name || 'there').trim().split(/\s+/)[0].replace(/[^\p{L}\p{N}'-]/gu, '') || 'there';
  return template.replaceAll('{name}', safeName).replaceAll('{query}', query);
};

const findMarkerMaterial = async (kind: ResourceMarkerKind, queryText: string, sender: any): Promise<{ exact: any | null; related: any | null }> => {
  const query = queryText.trim().slice(0, 120);
  if (!query) return { exact: null, related: null };
  const codeMatch = query.match(/\b([A-Z]{2,5})[-_ ]?(\d{2,4}[A-Z]?)\b/i);
  const normalizedQuery = normalizeMaterialText(query);
  const exactFilters: any[] = [];
  if (codeMatch) {
    const prefix = codeMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const code = codeMatch[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `^${prefix}[-_ ]?${code}($|[^0-9])`;
    exactFilters.push({ unitCode: { $regex: pattern, $options: 'i' } }, { courseCode: { $regex: pattern, $options: 'i' } });
  }

  const base: any = { status: 'approved', isHidden: { $ne: true }, isDemo: { $ne: true }, type: getMaterialTypeQuery(kind) };
  const exactQuery: any = exactFilters.length ? { ...base, $or: exactFilters } : base;
  const exactCandidates = exactFilters.length ? await Paper.find(exactQuery).select('_id mtid title description type school department courseCode unitCode unitName examYear fileUrl fileType fileSize publicId submittedBy').limit(10).lean() : [];
  const exact = exactCandidates.find((paper: any) => {
    if (codeMatch) return new RegExp(`^${codeMatch[1]}[-_ ]?${codeMatch[2]}($|[^0-9])`, 'i').test(`${paper.unitCode || ''} ${paper.courseCode || ''}`);
    return normalizeMaterialText(paper.unitName) === normalizedQuery || normalizeMaterialText(paper.title) === normalizedQuery;
  }) || null;
  if (exact) return { exact, related: exact };

  const tokens = Array.from(new Set(normalizedQuery.split(' ').filter((token) => token.length > 1 && !['the', 'and', 'for', 'past', 'paper', 'papers', 'cat', 'notes', 'lecture', 'course', 'unit', 'material'].includes(token))));
  if (!tokens.length) return { exact: null, related: null };
  const escapedTerms = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const candidates = await Paper.find({
    ...base,
    $or: escapedTerms.flatMap((term) => [
      { unitCode: { $regex: term, $options: 'i' } }, { courseCode: { $regex: term, $options: 'i' } },
      { unitName: { $regex: term, $options: 'i' } }, { title: { $regex: term, $options: 'i' } },
      { description: { $regex: term, $options: 'i' } }
    ])
  }).select('_id mtid title description type school department courseCode unitCode unitName examYear fileUrl fileType fileSize publicId submittedBy').limit(80).lean();
  if (!codeMatch) {
    const exactByName = candidates.find((paper: any) => {
      const unitName = normalizeMaterialText(paper.unitName);
      const title = normalizeMaterialText(paper.title);
      return unitName === normalizedQuery || title === normalizedQuery || (unitName.length >= 5 && normalizedQuery.includes(unitName));
    });
    if (exactByName) return { exact: exactByName, related: exactByName };
  }
  const profileTokens = normalizeMaterialText(`${sender?.course || ''} ${sender?.school || ''}`).split(' ').filter((token: string) => token.length > 2);
  const ranked = candidates.map((paper: any) => {
    const fields = [paper.unitCode, paper.courseCode, paper.unitName, paper.title, paper.description, paper.department, paper.school].map(normalizeMaterialText);
    const score = tokens.reduce((sum, token) => sum + fields.reduce((best, field) => Math.max(best, field === token ? 5 : field.includes(token) ? 2 : 0), 0), 0)
      + profileTokens.reduce((sum: number, token: string) => sum + (fields.some((field) => field.includes(token)) ? 1 : 0), 0);
    return { paper, score };
  }).filter((entry) => entry.score >= 2).sort((a, b) => b.score - a.score);
  return { exact: null, related: ranked[0]?.paper || null };
};

const resolveResourceMarker = async (text: string, message: any): Promise<{ text: string; attachment?: any }> => {
  const marker = text.match(RESOURCE_MARKER_REGEX);
  if (!marker) return { text: text.replace(/>>\s*\/\s*[PCN]\s*\/[^\r\n<>]*/gi, '').trim() };
  const kind = marker[1].toUpperCase() as ResourceMarkerKind;
  const query = marker[2].trim().replace(/[.,;:!?]+$/, '').slice(0, 120);
  const cleanText = text.replace(marker[0], '').replace(/\n{3,}/g, '\n\n').trim();
  const match = await findMarkerMaterial(kind, query, message);
  if (match.exact) return { text: cleanText || 'I found this exact match for you.', attachment: makePaperChatAttachment(match.exact) };
  if (match.related) return { text: choosePersonalizedReply(NO_EXACT_MATCH_REPLIES, message.senderName, query), attachment: makePaperChatAttachment(match.related) };
  return { text: choosePersonalizedReply(NO_MATCH_REPLIES, message.senderName, query) };
};

const makePaperChatAttachment = (paper: any): any => {
  const url = paper.publicId ? getSignedCloudinaryUrl(paper.publicId, paper.fileUrl, paper.fileType) : paper.fileUrl;
  return {
    name: paper.title || paper.unitName || paper.unitCode || 'Academic material',
    title: paper.title || paper.unitName || paper.unitCode || 'Academic material',
    url,
    publicId: paper.publicId,
    size: paper.fileSize ? `${(paper.fileSize / (1024 * 1024)).toFixed(1)} MB` : 'PDF',
    type: 'pdf',
    paperId: String(paper._id),
    mtid: paper.mtid,
    unitCode: paper.unitCode || paper.courseCode,
    unitName: paper.unitName || paper.title,
    school: paper.school,
    author: 'MConnect Library',
    materialCategory: paper.type
  };
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
    promptLines.push('If the student clearly requests a specific course material, end your answer with exactly one machine-readable marker on its own final line: >>/P/course code and search words for a past paper, >>/C/course code and search words for a CAT, or >>/N/course code and search words for notes. Keep the search phrase concise and include the course code when supplied. Do not invent a marker for general questions or when no material is requested. The app will remove the marker and attach the best real library result, or replace the response with a suitable no-match message.');
  }

  return promptLines.join('\n');
};

type AiPlaygroundAttempt = { apiLabel: string; model: string; status?: number; success: boolean; error?: string };
type AiGenerationTrace = { attempts: AiPlaygroundAttempt[]; error?: string };

const askGemini = async (apiKey: string, apiLabel: string, model: string, messageText: string, assistant: Assistant, promptSettings: AiPromptSettings, signal: AbortSignal): Promise<{ text: string; isNetworkError?: boolean; retryable: boolean; providerStatus?: number; errorMessage?: string }> => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    const systemInstructionText = buildSystemInstructionText(promptSettings);

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
      const errorMessage = String(payload?.error?.message || response.statusText || 'Gemini request failed.')
        .replaceAll(apiKey, '[redacted API key]')
        .slice(0, 500);
      return { text: '', isNetworkError: false, retryable: true, providerStatus: response.status, errorMessage };
    }
    const text = extractGeminiText(payload);
    updateAiUsage(apiLabel, text ? 'success' : 'failure');
    if (!text) addAiLog({ level: 'warn', assistant: assistant.name, apiLabel, model, message: 'Gemini returned no text.' });
    return { text, isNetworkError: false, retryable: false, errorMessage: text ? undefined : 'Gemini returned no text.' };
  } catch (error: any) {
    if (!signal.aborted) {
      updateAiUsage(apiLabel, 'failure');
      addAiLog({ level: 'error', assistant: assistant.name, apiLabel, model, message: error?.name === 'AbortError' ? 'Request timed out.' : `Network or request error: ${String(error?.message || error).slice(0, 220)}` });
      console.warn(`[${assistant.name}] Gemini attempt unavailable: api=${apiLabel}, model=${model}`);
    }
    return { text: '', isNetworkError: true, retryable: true, errorMessage: (error?.name === 'AbortError' ? 'Request timed out.' : String(error?.message || error)).replaceAll(apiKey, '[redacted API key]').slice(0, 300) };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
};

const generateReply = async (messageText: string, assistant: Assistant, signal: AbortSignal, trace?: AiGenerationTrace): Promise<string | null> => {
  const keys = getGeminiKeys();
  if (!keys.length) {
    addAiLog({ level: 'error', assistant: assistant.name, message: 'No Gemini API keys are configured.' });
    console.warn(`[${assistant.name}] No Gemini API keys are configured.`);
    if (trace) trace.error = 'No Gemini API keys are configured.';
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
      trace?.attempts.push({ apiLabel, model, status: result.providerStatus, success: Boolean(result.text), error: result.errorMessage });
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
    if (trace) trace.error = 'All pool attempts failed because of network errors.';
    return INTERNET_ERROR_FALLBACK;
  }

  addAiLog({ level: 'error', assistant: assistant.name, message: `All ${keys.length} API(s) and ${models.length} model(s) failed. Returning AI pool quota fallback.` });
  if (trace) trace.error = `All ${keys.length} configured API(s) and ${models.length} model(s) failed.`;
  return CAMPUS_BOT_FALLBACK;
};

export const testAiPlaygroundForumFlow = async (messageText: string, assistantKind: AssistantKind = 'ai'): Promise<{ text: string; apiLabel: string; model: string; assistant: string; durationMs: number; attempts: AiPlaygroundAttempt[]; fallback: boolean; error?: string }> => {
  const message = messageText.trim();
  if (!message || message.length > 4000) throw new Error('Enter a message of 1 to 4,000 characters.');
  const assistant = assistants[assistantKind === 'bot' ? 'bot' : 'ai'];
  const prompt = await getConversationPrompt({ senderName: 'Admin', text: message }, assistant);
  const trace: AiGenerationTrace = { attempts: [] };
  const startedAt = Date.now();
  const text = await generateReply(prompt, assistant, new AbortController().signal, trace);
  const successfulAttempt = [...trace.attempts].reverse().find((attempt) => attempt.success);
  return {
    text: text || '',
    apiLabel: successfulAttempt?.apiLabel || 'Normal forum chat pool',
    model: successfulAttempt?.model || 'Automatic rotation',
    assistant: assistant.name,
    durationMs: Date.now() - startedAt,
    attempts: trace.attempts,
    fallback: !successfulAttempt,
    error: trace.error
  };
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
    : (isFromAssistant
      ? (Number(message.aiChainTurnCount) > 0 ? Number(message.aiChainTurnCount) + 1 : 1)
      : 1);

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

    let fileAttachment: any;
    if (!disableAiFeatures) {
      const resolved = await resolveResourceMarker(responseText, message);
      responseText = resolved.text;
      fileAttachment = resolved.attachment;
    }

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
      fileAttachment,
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
