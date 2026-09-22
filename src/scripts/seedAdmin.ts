import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { config } from '../config';

const seedAdmin = async () => {
  try {
    console.log('[Seed Script]: Connecting to MongoDB...');
    await mongoose.connect(config.mongoUri);

    const adminEmail = process.env.ADMIN_EMAIL || 'dev@gmail.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'spiderman';
    const adminName = process.env.ADMIN_NAME || 'Moi System Admin';

    let existingAdmin = await User.findOne({ email: adminEmail });
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(adminPassword, salt);

    if (existingAdmin) {
      console.log(`[Seed Script]: Admin user ${adminEmail} already exists. Updating password & roles...`);
      existingAdmin.passwordHash = passwordHash;
      if (!existingAdmin.roles.includes('admin')) {
        existingAdmin.roles.push('admin');
      }
      existingAdmin.activeRole = 'admin';
      existingAdmin.accountStatus = 'active';
      await existingAdmin.save();
      console.log(`[Seed Script]: Updated existing user ${adminEmail} to admin with active credentials.`);
      process.exit(0);
    }

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
