import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { User } from '../models/User';
import { awardPendingReferralPoints, getReferralRewardPoints } from '../services/referralService';

const REFERRAL_INSTALL_BASE_URL = 'https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect';
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'https://mconnect.keysire.com').replace(/\/$/, '');

export const getMyReferralSummary = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Sign in to get your referral link.' });
      return;
    }

    let user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ success: false, error: 'Account not found.' });
      return;
    }
    if (!user.referralCode) {
      await user.save();
    }

    await awardPendingReferralPoints(String(user._id));
    user = await User.findById(userId);
    const successfulReferrals = user?.creditedReferralIds?.length || 0;
    const installReferrer = new URLSearchParams({
      utm_source: 'mconnect_referral',
      referral_code: user?.referralCode || ''
    }).toString();
    const googlePlayUrl = `${REFERRAL_INSTALL_BASE_URL}&referrer=${encodeURIComponent(installReferrer)}`;

    res.json({
      success: true,
      data: {
        referralCode: user?.referralCode,
        shareUrl: `${PUBLIC_APP_URL}/r/${user?.referralCode}`,
        successfulReferrals,
        rewardPointsPerReferral: getReferralRewardPoints(),
        points: user?.points || 0,
        googlePlayUrl
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Could not load your referral link.' });
  }
};

export const renderReferralLandingPage = async (req: Request, res: Response): Promise<void> => {
  try {
    const referralCode = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,24}$/.test(referralCode)) {
      res.status(404).send('Referral link not found.');
      return;
    }
    const referrer = await User.findOne({ referralCode }).select('_id');
    if (!referrer) {
      res.status(404).send('Referral link not found.');
      return;
    }

    const installReferrer = new URLSearchParams({ utm_source: 'mconnect_referral', referral_code: referralCode }).toString();
    const googlePlayUrl = `${REFERRAL_INSTALL_BASE_URL}&referrer=${encodeURIComponent(installReferrer)}`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Join MConnect</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f0fdf4;color:#0f172a;font-family:Arial,sans-serif;display:grid;place-items:center;padding:20px}.card{width:min(100%,390px);background:#fff;border:1px solid #dcfce7;border-radius:24px;padding:28px 24px;text-align:center;box-shadow:0 18px 50px #14532d18}.mark{width:58px;height:58px;margin:0 auto 14px;border-radius:20px;background:#dcfce7;display:grid;place-items:center;font-size:28px}h1{font-size:24px;margin:0 0 8px}p{color:#64748b;line-height:1.5;font-size:14px}.code{margin:18px 0;padding:12px;border:1px dashed #86efac;border-radius:12px;color:#15803d;font-size:21px;font-weight:800;letter-spacing:2px}.install{display:block;margin-top:18px;padding:14px;border-radius:13px;background:#15803d;color:white;font-weight:800;text-decoration:none}.note{font-size:12px;margin-top:16px}</style></head>
<body><main class="card"><div class="mark">🎓</div><h1>Join MConnect</h1><p>A student invited you. Install MConnect and enter this referral code while creating your account.</p><div class="code">${referralCode}</div><a id="androidInstall" class="install" href="${googlePlayUrl}">Get MConnect on Google Play</a><p id="iosNote" class="note">Your friend earns ${getReferralRewardPoints()} points after your new account is created. On iPhone or another device, open MConnect and enter the code above during sign-up.</p></main><script>if(!/Android/i.test(navigator.userAgent)){document.getElementById('androidInstall').hidden=true}</script></body></html>`);
  } catch (error) {
    console.error('[Referrals] Failed to render invite page:', error);
    res.status(500).send('Could not open this referral link. Please try again.');
  }
};
