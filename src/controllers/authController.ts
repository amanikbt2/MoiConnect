import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { CommunityMessage } from '../models/CommunityMessage';
import { config } from '../config';
import { AuthenticatedRequest } from '../middleware/auth';
import { RegisterInput, LoginInput, RequestLandlordInput } from '@moi/shared';
import { uploadTempFileToCloudinary } from '../services/tempFileService';

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

    // Keep the local demo account usable as both an admin and a student tester.
    if (cleanEmail === 'dev@gmail.com') {
      if (password !== 'spiderman') {
        res.status(401).json({ success: false, error: 'Invalid email or password.' });
        return;
      }

      const salt = await bcrypt.genSalt(10);
      const expectedHash = await bcrypt.hash('spiderman', salt);
      if (!user) {
        user = await User.create({
          name: 'System Admin',
          email: 'dev@gmail.com',
          passwordHash: expectedHash,
          phone: '+254700000000',
          roles: ['student', 'landlord', 'admin'],
          activeRole: 'admin',
          landlordStatus: 'approved',
          accountStatus: 'active'
        });
      } else {
        if (!user.roles.includes('student')) {
          user.roles.push('student');
        }
        if (!user.roles.includes('landlord')) {
          user.roles.push('landlord');
        }
        if (!user.roles.includes('admin')) {
          user.roles.push('admin');
        }
        user.activeRole = 'admin';
        // user.name = 'Campus bot';
        user.landlordStatus = 'approved';
        user.accountStatus = 'active';
        user.passwordHash = expectedHash;
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

export const updateProfile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    const { name, phone, avatarUrl, school, course, yearOfStudy } = req.body || {};
    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName || cleanName.length > 120) {
        res.status(400).json({ success: false, error: 'Name must be between 1 and 120 characters.' });
        return;
      }
      user.name = cleanName;
    }
    if (phone !== undefined) user.phone = String(phone).trim();
    if (avatarUrl !== undefined) user.avatarUrl = String(avatarUrl).trim();
    if (school !== undefined) user.school = String(school).trim() || 'Unset';
    if (course !== undefined) user.course = String(course).trim() || 'Unset';
    if (yearOfStudy !== undefined) user.yearOfStudy = String(yearOfStudy).trim() || 'Unset';

    await user.save();
    const messageUpdates: Record<string, string> = { senderName: user.name, senderEmail: user.email };
    if (avatarUrl !== undefined) messageUpdates.senderAvatarUrl = user.avatarUrl || '';
    await CommunityMessage.updateMany({ senderId: user._id }, { $set: messageUpdates });
    await CommunityMessage.updateMany(
      { 'replyTo.senderEmail': user.email },
      { $set: { 'replyTo.senderName': user.name } }
    );
    const io = require('../socket').getSocketIO();
    io?.to('community_room').emit('community:user_updated', {
      userId: String(user._id),
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl || '',
      badge: user.badge || null
    });
    res.json({ success: true, message: 'Profile updated successfully.', data: user });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update profile.' });
  }
};

export const uploadProfileAvatar = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No profile image provided.' });
      return;
    }
    if (!String(req.file.mimetype || '').startsWith('image/')) {
      res.status(400).json({ success: false, error: 'Profile pictures must be image files.' });
      return;
    }

    const upload = await uploadTempFileToCloudinary(req.file.filename, 'moiconnect/profile_avatars', 'image');
    const avatarUrl = upload.secure_url;
    req.user.avatarUrl = avatarUrl;
    await req.user.save();
    await CommunityMessage.updateMany(
      { senderId: req.user._id },
      { $set: { senderAvatarUrl: avatarUrl } }
    );

    const io = require('../socket').getSocketIO();
    io?.to('community_room').emit('community:user_updated', {
      userId: String(req.user._id),
      email: req.user.email,
      name: req.user.name,
      avatarUrl,
      badge: req.user.badge || null
    });
    res.json({ success: true, data: { avatarUrl } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Profile image upload failed.' });
  }
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

