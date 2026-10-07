import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Admin2Credential, ADMIN2_ROLES, Admin2Role } from '../models/Admin2Credential';
import { config } from '../config';

const normalizeRole = (value: unknown): Admin2Role | null => {
  const role = String(value || '').trim();
  return (ADMIN2_ROLES as readonly string[]).includes(role) ? role as Admin2Role : null;
};

export const listCredentials = async (_req: Request, res: Response): Promise<void> => {
  try {
    const credentials = await Admin2Credential.find().select('-secretHash').sort({ role: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: credentials });
  } catch (error: any) { res.status(500).json({ success: false, error: error.message || 'Failed to load Admin2 credentials.' }); }
};

export const createCredential = async (req: Request, res: Response): Promise<void> => {
  try {
    const role = normalizeRole(req.body?.role);
    const adminCode = String(req.body?.adminCode || '').trim().toUpperCase();
    const email = String(req.body?.email || req.body?.adminEmail || '').trim().toLowerCase();
    const secret = String(req.body?.adminSecret || '');
    if (!role || adminCode.length < 3 || secret.length < 8) {
      res.status(400).json({ success: false, error: 'Choose a valid role, use an admin code of at least 3 characters, and a secret of at least 8 characters.' }); return;
    }
    const secretHash = await bcrypt.hash(secret, 12);
    const credential = await Admin2Credential.create({ role, adminCode, email, secretHash, active: true });
    res.status(201).json({ success: true, data: { _id: credential._id, role: credential.role, adminCode: credential.adminCode, email: credential.email, active: credential.active, createdAt: credential.createdAt } });
  } catch (error: any) {
    const duplicate = error?.code === 11000;
    res.status(duplicate ? 409 : 500).json({ success: false, error: duplicate ? 'That role and admin code already exist.' : (error.message || 'Failed to create Admin2 credential.') });
  }
};

export const updateCredential = async (req: Request, res: Response): Promise<void> => {
  try {
    const update: Record<string, unknown> = {};
    if (req.body?.active !== undefined) update.active = Boolean(req.body.active);
    if (req.body?.email !== undefined) update.email = String(req.body.email).trim().toLowerCase();
    if (req.body?.adminSecret) {
      const secret = String(req.body.adminSecret);
      if (secret.length < 8) { res.status(400).json({ success: false, error: 'The secret must be at least 8 characters.' }); return; }
      update.secretHash = await bcrypt.hash(secret, 12);
    }
    const credential = await Admin2Credential.findByIdAndUpdate(req.params.id, update, { new: true }).select('-secretHash').lean();
    if (!credential) { res.status(404).json({ success: false, error: 'Admin2 credential not found.' }); return; }
    res.json({ success: true, data: credential });
  } catch (error: any) { res.status(500).json({ success: false, error: error.message || 'Failed to update Admin2 credential.' }); }
};

export const deleteCredential = async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await Admin2Credential.findByIdAndDelete(req.params.id);
    if (!deleted) { res.status(404).json({ success: false, error: 'Admin2 credential not found.' }); return; }
    res.json({ success: true, message: 'Admin2 credential deleted.' });
  } catch (error: any) { res.status(500).json({ success: false, error: error.message || 'Failed to delete Admin2 credential.' }); }
};

export const loginAdmin2 = async (req: Request, res: Response): Promise<void> => {
  try {
    const role = normalizeRole(req.body?.role);
    const adminCode = String(req.body?.adminCode || '').trim().toUpperCase();
    const secret = String(req.body?.adminSecret || '');
    if (!role || !adminCode || !secret) { res.status(400).json({ success: false, error: 'Role, admin code, and admin secret are required.' }); return; }
    const credential = await Admin2Credential.findOne({ role, adminCode, active: true }).select('+secretHash');
    if (!credential || !(await bcrypt.compare(secret, credential.secretHash))) { res.status(401).json({ success: false, error: 'Invalid Admin2 role, code, or secret.' }); return; }
    const token = jwt.sign({ admin2: true, credentialId: credential._id.toString(), role: credential.role, email: credential.email || '' }, config.jwtAccessSecret, { expiresIn: '8h' });
    res.json({ success: true, data: { token, role: credential.role, email: credential.email || '', expiresIn: 8 * 60 * 60 } });
  } catch (error: any) { res.status(500).json({ success: false, error: error.message || 'Admin2 login failed.' }); }
};

export const validateAdmin2Session = async (req: Request, res: Response): Promise<void> => {
  const authorization = req.header('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) {
    res.status(401).json({ success: false, error: 'Admin2 session is missing.' });
    return;
  }

  try {
    const claims = jwt.verify(token, config.jwtAccessSecret) as jwt.JwtPayload;
    if (claims.admin2 !== true || typeof claims.credentialId !== 'string') {
      res.status(401).json({ success: false, error: 'Admin2 session is invalid.' });
      return;
    }

    const credential = await Admin2Credential.findOne({ _id: claims.credentialId, active: true }).select('role email').lean();
    if (!credential) {
      res.status(401).json({ success: false, error: 'These Admin2 credentials have been removed or disabled.' });
      return;
    }

    res.json({ success: true, data: { role: credential.role, email: credential.email || '' } });
  } catch (error: any) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: 'Admin2 session has expired. Please sign in again.' });
      return;
    }
    res.status(500).json({ success: false, error: error.message || 'Could not verify Admin2 session.' });
  }
};
