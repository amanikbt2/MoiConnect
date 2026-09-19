import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { config } from '../config';

const seedAdmin = async () => {
  try {
    console.log('[Seed Script]: Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri);

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@moi.ac.ke';
    const adminPassword = process.env.ADMIN_PASSWORD || 'MoiAdmin2026!';
    const adminName = process.env.ADMIN_NAME || 'Moi System Admin';

    const existingAdmin = await User.findOne({ email: adminEmail });
    if (existingAdmin) {
      console.log(`[Seed Script]: Admin user ${adminEmail} already exists.`);
      if (!existingAdmin.roles.includes('admin')) {
        existingAdmin.roles.push('admin');
        existingAdmin.activeRole = 'admin';
        await existingAdmin.save();
        console.log(`[Seed Script]: Added admin role to existing user ${adminEmail}.`);
      }
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(adminPassword, salt);

    const admin = await User.create({
      name: adminName,
      email: adminEmail,
      passwordHash,
      phone: '+254700000000',
      roles: ['student', 'landlord', 'admin'],
      activeRole: 'admin',
      landlordStatus: 'approved',
      accountStatus: 'active'
    });

    console.log(`[Seed Script Success]: Admin created!`);
    console.log(`Email: ${admin.email}`);
    console.log(`Default Password: ${adminPassword}`);

    process.exit(0);
  } catch (error) {
    console.error('[Seed Script Error]:', error);
    process.exit(1);
  }
};

seedAdmin();
