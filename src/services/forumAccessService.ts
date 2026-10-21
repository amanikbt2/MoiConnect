import { getAppSettingValue, setAppSettingValue } from '../models/AppSetting';

export type ForumAccessPolicy = {
  mode: 'all' | 'whitelist';
  whitelistEmails: string[];
  blacklistEmails: string[];
};

export const DEFAULT_FORUM_ACCESS_POLICY: ForumAccessPolicy = {
  mode: 'all',
  whitelistEmails: [],
  blacklistEmails: []
};

const POLICY_SETTING_KEY = 'forumAccessPolicy';
const MAX_EMAILS_PER_LIST = 5000;
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
let cachedPolicy: ForumAccessPolicy = DEFAULT_FORUM_ACCESS_POLICY;
let cacheExpiresAt = 0;

const normalizeEmailList = (value: unknown, validate: boolean): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Forum email lists must be arrays.');
  if (value.length > MAX_EMAILS_PER_LIST) throw new Error(`Each forum email list can contain at most ${MAX_EMAILS_PER_LIST} addresses.`);

  const emails = Array.from(new Set(value
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)));
  if (validate) {
    const invalidEmail = emails.find((email) => !EMAIL_PATTERN.test(email));
    if (invalidEmail) throw new Error(`Invalid email address in forum access list: ${invalidEmail}`);
  }
  return emails;
};

export const normalizeForumAccessPolicy = (value: any, validate = true): ForumAccessPolicy => {
  if (value === undefined || value === null) return { ...DEFAULT_FORUM_ACCESS_POLICY };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Forum access policy must be an object.');
  if (value.mode !== 'all' && value.mode !== 'whitelist') throw new Error('Choose All users or Whitelist only.');
  return {
    mode: value.mode,
    whitelistEmails: normalizeEmailList(value.whitelistEmails, validate),
    blacklistEmails: normalizeEmailList(value.blacklistEmails, validate)
  };
};

export const getForumAccessPolicy = async (): Promise<ForumAccessPolicy> => {
  if (Date.now() < cacheExpiresAt) return cachedPolicy;
  const storedPolicy = await getAppSettingValue<any>(POLICY_SETTING_KEY, DEFAULT_FORUM_ACCESS_POLICY);
  try {
    cachedPolicy = normalizeForumAccessPolicy(storedPolicy, false);
  } catch {
    cachedPolicy = { ...DEFAULT_FORUM_ACCESS_POLICY };
  }
  cacheExpiresAt = Date.now() + 5000;
  return cachedPolicy;
};

export const saveForumAccessPolicy = async (value: unknown, updatedBy?: string): Promise<ForumAccessPolicy> => {
  const policy = normalizeForumAccessPolicy(value);
  await setAppSettingValue(POLICY_SETTING_KEY, policy, updatedBy);
  cachedPolicy = policy;
  cacheExpiresAt = Date.now() + 5000;
  return policy;
};

export const isForumParticipationAllowed = (email: unknown, policy: ForumAccessPolicy): boolean => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const hasRestrictions = policy.mode === 'whitelist' || policy.blacklistEmails.length > 0;

  // With any email-based restriction active, unidentified devices fail closed.
  if (!normalizedEmail) return !hasRestrictions;
  if (policy.blacklistEmails.includes(normalizedEmail)) return false;
  return policy.mode === 'all' || policy.whitelistEmails.includes(normalizedEmail);
};
