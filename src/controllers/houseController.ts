import { Response } from 'express';
import { House } from '../models/House';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreateHouseInput, UpdateHouseInput } from '@moi/shared';

export const getHouses = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '20', 10);
    const skip = (page - 1) * limit;

    const { location, propertyType, minRent, maxRent, occupancyStatus, search } = req.query;

    const query: any = { status: 'approved' };

    if (location) query.location = location;
    if (propertyType) query.propertyType = propertyType;
    if (occupancyStatus) query.occupancyStatus = occupancyStatus;

    if (minRent || maxRent) {
      query.monthlyRent = {};
      if (minRent) query.monthlyRent.$gte = parseInt(minRent as string, 10);
      if (maxRent) query.monthlyRent.$lte = parseInt(maxRent as string, 10);
    }

    if (search) {
      query.$text = { $search: search as string };
    }

    const total = await House.countDocuments(query);
    const houses = await House.find(query)
      .populate('landlordId', 'name email phone avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: houses,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch rental listings' });
  }
};

export const getHouseById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const house = await House.findById(id).populate('landlordId', 'name email phone avatarUrl');

    if (!house) {
      res.status(404).json({ success: false, error: 'Rental listing not found.' });
      return;
    }

    if (house.status !== 'approved') {
      const isOwner = req.user && house.landlordId._id.toString() === req.user._id.toString();
      const isAdmin = req.user && req.user.roles.includes('admin');
      if (!isOwner && !isAdmin) {
        res.status(403).json({ success: false, error: 'This rental listing is pending approval.' });
        return;
      }
    }

    res.json({ success: true, data: house });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch house detail' });
  }
};

export const createHouse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const input: CreateHouseInput = req.body;
    const user = req.user!;

    const newHouse = await House.create({
      ...input,
      landlordId: user._id,
      status: 'pending',
      occupancyStatus: 'available'
    });

    const populated = await newHouse.populate('landlordId', 'name email phone avatarUrl');

    res.status(201).json({
      success: true,
      message: 'Rental listing submitted successfully and is pending administrator approval.',
      data: populated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'House creation failed' });
  }
};

export const updateHouse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const input: UpdateHouseInput = req.body;
    const user = req.user!;

    const house = await House.findById(id);
    if (!house) {
      res.status(404).json({ success: false, error: 'Rental listing not found.' });
      return;
    }

    // Landlords can only modify their own listings. Admin can modify any.
    const isOwner = house.landlordId.toString() === user._id.toString();
    const isAdmin = user.roles.includes('admin');
    if (!isOwner && !isAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden: You cannot modify another landlord\'s listing.' });
      return;
    }

    Object.assign(house, input);
    await house.save();

    const updated = await house.populate('landlordId', 'name email phone avatarUrl');

    res.json({
      success: true,
      message: 'Rental listing updated successfully.',
      data: updated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Update failed' });
  }
};

export const getMyListings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const houses = await House.find({ landlordId: user._id }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: houses
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch listings' });
  }
};
