import { Response } from 'express';
import mongoose from 'mongoose';
import { Booking } from '../models/Booking';
import { House } from '../models/House';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreateBookingInput, UpdateBookingStatusInput } from '@moi/shared';

export const createBooking = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { houseId, requestedMoveIn, message }: CreateBookingInput = req.body;
    const student = req.user!;

    const house = await House.findById(houseId);
    if (!house || house.status !== 'approved') {
      res.status(404).json({ success: false, error: 'Rental listing is not available for booking.' });
      return;
    }

    if (house.occupancyStatus === 'occupied') {
      res.status(400).json({ success: false, error: 'This property is currently occupied.' });
      return;
    }

    // Prevent landlord from booking their own house
    if (house.landlordId.toString() === student._id.toString()) {
      res.status(400).json({ success: false, error: 'Landlords cannot submit booking requests for their own properties.' });
      return;
    }

    // Prevent duplicate active booking requests for the same house by the same student
    const existingActiveBooking = await Booking.findOne({
      houseId,
      studentId: student._id,
      status: { $in: ['pending', 'accepted'] }
    });

    if (existingActiveBooking) {
      res.status(400).json({
        success: false,
        error: `You already have an active (${existingActiveBooking.status}) booking request for this property.`
      });
      return;
    }

    const booking = await Booking.create({
      houseId: house._id,
      studentId: student._id,
      landlordId: house.landlordId,
      requestedMoveIn,
      message,
      status: 'pending'
    });

    const populated = await booking.populate([
      { path: 'houseId', select: 'title location monthlyRent photos' },
      { path: 'landlordId', select: 'name email phone avatarUrl' },
      { path: 'studentId', select: 'name email phone' }
    ]);

    res.status(201).json({
      success: true,
      message: 'Booking request submitted successfully. Note: A booking request is not a guaranteed tenancy or proof of payment.',
      data: populated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Booking submission failed' });
  }
};

export const getBookings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const role = req.query.role as string || user.activeRole;

    let query: any = {};
    if (role === 'landlord') {
      query.landlordId = user._id;
    } else {
      query.studentId = user._id;
    }

    const bookings = await Booking.find(query)
      .populate('houseId', 'title location monthlyRent photos propertyType occupancyStatus')
      .populate('studentId', 'name email phone avatarUrl')
      .populate('landlordId', 'name email phone avatarUrl')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: bookings
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch bookings' });
  }
};

export const getBookingById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const booking = await Booking.findById(id)
      .populate('houseId')
      .populate('studentId', 'name email phone avatarUrl')
      .populate('landlordId', 'name email phone avatarUrl');

    if (!booking) {
      res.status(404).json({ success: false, error: 'Booking request not found.' });
      return;
    }

    const isStudent = booking.studentId._id.toString() === user._id.toString();
    const isLandlord = booking.landlordId._id.toString() === user._id.toString();
    const isAdmin = user.roles.includes('admin');

    if (!isStudent && !isLandlord && !isAdmin) {
      res.status(403).json({ success: false, error: 'Forbidden access to this booking request.' });
      return;
    }

    res.json({ success: true, data: booking });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch booking' });
  }
};

export const updateBookingStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status }: UpdateBookingStatusInput = req.body;
    const user = req.user!;

    const booking = await Booking.findById(id);
    if (!booking) {
      res.status(404).json({ success: false, error: 'Booking request not found.' });
      return;
    }

    const isStudent = booking.studentId.toString() === user._id.toString();
    const isLandlord = booking.landlordId.toString() === user._id.toString();
    const isAdmin = user.roles.includes('admin');

    // Students can only cancel their own pending booking
    if (status === 'cancelled') {
      if (!isStudent && !isAdmin) {
        res.status(403).json({ success: false, error: 'Only the requesting student can cancel this booking.' });
        return;
      }
      booking.status = 'cancelled';
      await booking.save();
      res.json({ success: true, message: 'Booking request cancelled.', data: booking });
      return;
    }

    // Landlord status modifications (accept / decline)
    if (!isLandlord && !isAdmin) {
      res.status(403).json({ success: false, error: 'Only the property landlord can respond to booking requests.' });
      return;
    }

    if (status === 'accepted') {
      // Concurrency check: Ensure house is still available and not already accepted elsewhere
      const house = await House.findById(booking.houseId);
      if (!house || house.occupancyStatus === 'occupied') {
        res.status(400).json({ success: false, error: 'Cannot accept booking: Property is no longer available or is marked occupied.' });
        return;
      }

      // Check if another booking was already accepted for this house
      const acceptedBooking = await Booking.findOne({
        houseId: booking.houseId,
        status: 'accepted',
        _id: { $ne: booking._id }
      });

      if (acceptedBooking) {
        res.status(400).json({ success: false, error: 'Another booking has already been accepted for this house.' });
        return;
      }

      booking.status = 'accepted';
      booking.respondedAt = new Date();
      await booking.save();

      // Automatically mark house occupied
      house.occupancyStatus = 'occupied';
      await house.save();

      // Automatically decline other pending requests for the same house
      await Booking.updateMany(
        { houseId: booking.houseId, _id: { $ne: booking._id }, status: 'pending' },
        { status: 'declined', respondedAt: new Date() }
      );
    } else if (status === 'declined') {
      booking.status = 'declined';
      booking.respondedAt = new Date();
      await booking.save();
    }

    const updated = await booking.populate([
      { path: 'houseId', select: 'title location monthlyRent photos propertyType occupancyStatus' },
      { path: 'studentId', select: 'name email phone' },
      { path: 'landlordId', select: 'name email phone' }
    ]);

    res.json({
      success: true,
      message: `Booking request ${status}.`,
      data: updated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Update booking failed' });
  }
};
