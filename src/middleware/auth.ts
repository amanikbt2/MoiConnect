import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, IUserDocument } from '../models/User';
import { UserRole } from '@moi/shared';

export interface AuthenticatedRequest extends Request {
  user?: IUserDocument;
}

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Authentication required. No token provided.' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwtAccessSecret) as { userId: string };

    const user = await User.findById(decoded.userId);
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid authentication token. User not found.' });
      return;
    }

    if (user.accountStatus === 'suspended') {
      res.status(403).json({ success: false, error: 'Account has been suspended.' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
};

export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    const hasRole = roles.some(role => req.user?.roles.includes(role));
    if (!hasRole) {
      res.status(403).json({
        success: false,
        error: `Forbidden: Requires one of these roles: ${roles.join(', ')}`
      });
      return;
    }

    next();
  };
};

export const requireLandlordVerified = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required.' });
    return;
  }

  const isLandlord = req.user.roles.includes('landlord');
  const isApproved = req.user.landlordStatus === 'approved';

  if (!isLandlord || !isApproved) {
    res.status(403).json({
      success: false,
      error: 'Landlord verification required before publishing rental listings.'
    });
    return;
  }

  next();
};
