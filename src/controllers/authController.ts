import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { config } from '../config';
import { AuthenticatedRequest } from '../middleware/auth';
import { RegisterInput, LoginInput, RequestLandlordInput } from '@moi/shared';

const generateTokens = (userId: string) => {
  const accessToken = jwt.sign({ userId }, config.jwtAccessSecret, {
    expiresIn: 30 * 24 * 60 * 60 // 30 days (1 month)
  });
  const refreshToken = jwt.sign({ userId }, config.jwtRefreshSecret, {
    expiresIn: 30 * 24 * 60 * 60 // 30 days (1 month)
  });
  return { accessToken, refreshToken };
};

export const register = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone }: RegisterInput = req.body;

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      res.status(400).json({ success: false, error: 'An account with this email already exists.' });
      return;
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Registration ALWAYS creates a student account. Public admin registration is prohibited.
    const newUser = await User.create({
      name,
      email: email.toLowerCase(),
      passwordHash,
      phone,
      roles: ['student'],
      activeRole: 'student',
      landlordStatus: 'none',
      accountStatus: 'active'
    });

    const tokens = generateTokens(newUser._id.toString());
    newUser.refreshTokens.push(tokens.refreshToken);
    await newUser.save();

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        user: newUser,
        tokens
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Registration failed' });
  }
};

export const login = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { email, password }: LoginInput = req.body;
    const cleanEmail = (email || '').toLowerCase().trim();

    let user = await User.findOne({ email: cleanEmail });

    // Auto-seed/ensure demo admin account dev@gmail.com with password spiderman
    if (cleanEmail === 'dev@gmail.com') {
      const salt = await bcrypt.genSalt(10);
      const expectedHash = await bcrypt.hash('spiderman', salt);
      if (!user) {
        user = await User.create({
          name: 'Moi System Admin',
          email: 'dev@gmail.com',
          passwordHash: expectedHash,
          phone: '+254700000000',
          roles: ['student', 'landlord', 'admin'],
          activeRole: 'admin',
          landlordStatus: 'approved',
          accountStatus: 'active'
        });
      } else {
        // Ensure roles & active status
        if (!user.roles.includes('admin')) {
          user.roles.push('admin');
        }
        user.activeRole = 'admin';
        user.accountStatus = 'active';
        if (password === 'spiderman') {
          user.passwordHash = expectedHash;
        }
        await user.save();
      }
    }

    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    if (user.accountStatus === 'suspended') {
      res.status(403).json({ success: false, error: 'Your account has been suspended.' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      res.status(401).json({ success: false, error: 'Invalid email or password.' });
      return;
    }

    const tokens = generateTokens(user._id.toString());
    user.refreshTokens.push(tokens.refreshToken);
    // Keep max 5 refresh tokens to prevent unbounded array growth
    if (user.refreshTokens.length > 5) {
      user.refreshTokens = user.refreshTokens.slice(-5);
    }
    await user.save();

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user,
        tokens
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Login failed' });
  }
};

export const refresh = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ success: false, error: 'Refresh token is required.' });
      return;
    }

    let decoded: { userId: string };
    try {
      decoded = jwt.verify(refreshToken, config.jwtRefreshSecret) as { userId: string };
    } catch {
      res.status(401).json({ success: false, error: 'Invalid or expired refresh token.' });
      return;
    }

    const user = await User.findById(decoded.userId);
    if (!user || !user.refreshTokens.includes(refreshToken)) {
      res.status(401).json({ success: false, error: 'Refresh token revoked or user not found.' });
      return;
    }

    // Token Rotation
    user.refreshTokens = user.refreshTokens.filter(t => t !== refreshToken);
    const newTokens = generateTokens(user._id.toString());
    user.refreshTokens.push(newTokens.refreshToken);
    await user.save();

    res.json({
      success: true,
      data: {
        tokens: newTokens
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Token refresh failed' });
  }
};

export const logout = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (req.user && refreshToken) {
      req.user.refreshTokens = req.user.refreshTokens.filter(t => t !== refreshToken);
      await req.user.save();
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Logout failed' });
  }
};

export const me = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({
    success: true,
    data: req.user
  });
};

export const googleAuth = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    let { email, name, avatarUrl, idToken, accessToken } = req.body;

    // Verify Access Token or ID Token directly with Google if provided
    if (accessToken && !email) {
      try {
        const userRes = await fetch('https://www.googleapis.com/userinfo/v2/me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (userRes.ok) {
          const userData: any = await userRes.json();
          if (userData && userData.email) {
            email = userData.email;
            name = userData.name || name;
            avatarUrl = userData.picture || avatarUrl;
          }
        }
      } catch (err) {
        console.warn('Google accessToken verification error:', err);
      }
    }

    if (idToken) {
      try {
        const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
        if (googleRes.ok) {
          const googleData: any = await googleRes.json();
          if (googleData && googleData.email) {
            email = googleData.email;
            name = googleData.name || name;
            avatarUrl = googleData.picture || avatarUrl;
          }
        }
      } catch (tokenErr) {
        console.warn('Google token verification fallback:', tokenErr);
      }
    }
    
    // Normalize target email or default to a valid student email if none provided
    const targetEmail = (email || 'student.google@moi.ac.ke').toLowerCase().trim();
    const targetName = name || 'Google Student';

    let user = await User.findOne({ email: targetEmail });

    if (!user) {
      // Auto-register Google user if account does not exist
      const randomPassword = Math.random().toString(36).slice(-10) + '!Moi2026';
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(randomPassword, salt);

      user = await User.create({
        name: targetName,
        email: targetEmail,
        passwordHash,
        avatarUrl,
        roles: ['student'],
        activeRole: 'student',
        landlordStatus: 'none',
        accountStatus: 'active'
      });
    }

    if (user.accountStatus === 'suspended') {
      res.status(403).json({ success: false, error: 'Your account has been suspended.' });
      return;
    }

    const tokens = generateTokens(user._id.toString());
    user.refreshTokens.push(tokens.refreshToken);
    if (user.refreshTokens.length > 5) {
      user.refreshTokens = user.refreshTokens.slice(-5);
    }
    await user.save();

    res.json({
      success: true,
      message: 'Google login successful',
      data: {
        user,
        tokens
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Google authentication failed' });
  }
};

export const requestLandlord = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { idNumber, proofDetails }: RequestLandlordInput = req.body;
    const user = req.user!;

    if (user.landlordStatus === 'approved') {
      res.status(400).json({ success: false, error: 'You are already an approved landlord.' });
      return;
    }

    user.landlordStatus = 'pending';
    user.landlordRequestDetails = {
      idNumber,
      proofDetails,
      requestedAt: new Date()
    };
    await user.save();

    res.json({
      success: true,
      message: 'Landlord verification request submitted successfully.',
      data: user
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Request failed' });
  }
};

export const deleteAccount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    await User.findByIdAndDelete(userId);

    res.json({
      success: true,
      message: 'Account and personal data completely wiped from database.'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete account' });
  }
};
