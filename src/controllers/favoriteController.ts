import { Response } from 'express';
import { Favorite } from '../models/Favorite';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreateFavoriteInput } from '@moi/shared';

export const getFavorites = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const favorites = await Favorite.find({ userId: user._id }).sort({ createdAt: -1 });

    const paperIds = favorites.filter(f => f.targetType === 'paper').map(f => f.targetId);
    const houseIds = favorites.filter(f => f.targetType === 'house').map(f => f.targetId);

    const papers = await Paper.find({ _id: { $in: paperIds } }).populate('submittedBy', 'name');
    const houses = await House.find({ _id: { $in: houseIds } }).populate('landlordId', 'name phone');

    res.json({
      success: true,
      data: {
        favorites,
        papers,
        houses
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch favorites' });
  }
};

export const addFavorite = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { targetType, targetId }: CreateFavoriteInput = req.body;
    const user = req.user!;

    const favorite = await Favorite.findOneAndUpdate(
      { userId: user._id, targetType, targetId },
      { userId: user._id, targetType, targetId },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      message: 'Item saved to favorites.',
      data: favorite
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to add favorite' });
  }
};

export const removeFavorite = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.user!;

    await Favorite.findOneAndDelete({ _id: id, userId: user._id });

    res.json({
      success: true,
      message: 'Item removed from favorites.'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to remove favorite' });
  }
};
