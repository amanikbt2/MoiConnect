import crypto from 'crypto';
import { RewardPayout } from '../models/RewardPayout';

const configured = () => Boolean(
  process.env.MPESA_CONSUMER_KEY &&
  process.env.MPESA_CONSUMER_SECRET &&
  process.env.MPESA_INITIATOR_NAME &&
  process.env.MPESA_SECURITY_CREDENTIAL &&
  process.env.MPESA_B2C_SHORT_CODE &&
  process.env.MPESA_B2C_RESULT_URL &&
  process.env.MPESA_B2C_TIMEOUT_URL
);

const baseUrl = () => (process.env.MPESA_ENV || 'sandbox').toLowerCase() === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const normalizePhone = (phone: string) => {
  const digits = String(phone || '').replace(/[^0-9+]/g, '');
  if (digits.startsWith('+254')) return digits.slice(1);
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  return digits;
};

async function getAccessToken(): Promise<string> {
  const credentials = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const response = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });
  const body: any = await response.json();
  if (!response.ok || !body.access_token) throw new Error(body.error_description || 'M-Pesa OAuth failed');
  return body.access_token;
}

export async function submitB2CPayout(payout: any): Promise<{ submitted: boolean; reason?: string }> {
  if (!configured()) {
    return { submitted: false, reason: 'M-Pesa B2C environment variables are not configured.' };
  }

  const token = await getAccessToken();
  const response = await fetch(`${baseUrl()}/mpesa/b2c/v3/paymentrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      OriginatorConversationID: payout.originatorConversationId,
      InitiatorName: process.env.MPESA_INITIATOR_NAME,
      SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
      CommandID: process.env.MPESA_COMMAND_ID || 'BusinessPayment',
      Amount: payout.amount,
      PartyA: process.env.MPESA_B2C_SHORT_CODE,
      PartyB: normalizePhone(payout.phone),
      Remarks: payout.payoutType === 'manual'
        ? 'MoiConnect manual reward'
        : `MoiConnect reward milestone ${payout.milestonePoints}`,
      QueueTimeOutURL: process.env.MPESA_B2C_TIMEOUT_URL,
      ResultURL: process.env.MPESA_B2C_RESULT_URL,
      Occasion: 'MoiConnect reward'
    })
  });
  const body: any = await response.json();
  if (!response.ok || body.ResponseCode !== '0') {
    throw new Error(body.ResponseDescription || body.errorMessage || 'M-Pesa B2C request failed');
  }

  await RewardPayout.findByIdAndUpdate(payout._id, {
    $set: { status: 'submitted', conversationId: body.ConversationID }
  });
  return { submitted: true };
}

export async function attemptB2CPayout(payout: any): Promise<{ submitted: boolean; error?: string }> {
  try {
    const result = await submitB2CPayout(payout);
    return result.submitted
      ? { submitted: true }
      : { submitted: false, error: result.reason || 'M-Pesa did not accept the payment request.' };
  } catch (error: any) {
    const message = error?.message || 'M-Pesa B2C request failed.';
    await RewardPayout.findByIdAndUpdate(payout._id, {
      $set: { status: 'failed', resultDescription: message }
    });
    console.error('[M-Pesa B2C] Payout failed:', message);
    return { submitted: false, error: message };
  }
}

export async function handleB2CResult(payload: any, timedOut = false): Promise<void> {
  const result = payload?.Result || {};
  const originatorId = result.OriginatorConversationID;
  if (!originatorId) return;
  const success = !timedOut && String(result.ResultCode) === '0';
  const transactionId = result.TransactionID;
  await RewardPayout.findOneAndUpdate(
    { originatorConversationId: originatorId },
    {
      $set: {
        status: success ? 'success' : 'failed',
        transactionId,
        resultCode: result.ResultCode != null ? String(result.ResultCode) : undefined,
        resultDescription: result.ResultDesc || (timedOut ? 'M-Pesa request timed out.' : 'M-Pesa payout failed.')
      }
    }
  );
}

export const createOriginatorConversationId = () => `MOI-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
