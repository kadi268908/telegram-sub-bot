// src/services/referralService.js
// Handles referral code generation, tracking, and bonus day awarding

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const AdminLog = require('../models/AdminLog');
const SellerWithdrawalRequest = require('../models/SellerWithdrawalRequest');
const { addDays } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const BONUS_DAYS = parseInt(process.env.BONUS_REFERRAL_DAYS) || 3;
const SELLER_COMMISSION_PERCENT = parseFloat(process.env.SELLER_COMMISSION_PERCENT || '15');
const SELLER_MIN_WITHDRAW_REFERRALS = parseInt(process.env.SELLER_MIN_WITHDRAW_REFERRALS || '10', 10);
const SELLER_MIN_WITHDRAW_BALANCE = parseFloat(process.env.SELLER_MIN_WITHDRAW_BALANCE || '200');
const UPI_ID_REGEX = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;

const getSuperAdminIds = () => {
  return String(process.env.SUPER_ADMIN_IDS || process.env.SUPER_ADMIN_ID || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);
};

const assertSuperAdmin = (telegramId) => {
  const superAdminIds = getSuperAdminIds();
  if (!superAdminIds.includes(Number(telegramId))) {
    throw new Error('Only super admin can approve/reject seller withdrawals.');
  }
};

const generateSellerCode = () => `SEL${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const generateUniqueSellerCode = async () => {
  let code = generateSellerCode();
  let exists = await User.exists({ sellerCode: code });

  while (exists) {
    code = generateSellerCode();
    exists = await User.exists({ sellerCode: code });
  }

  return code;
};

/**
 * Process referral when a new user starts the bot with ?start=ref_CODE
 */
const processReferral = async (newUser, referralCode) => {
  try {
    if (!referralCode || newUser.referredBy) return; // Already referred or no code

    const referrer = await User.findOne({ referralCode });
    if (!referrer || referrer.telegramId === newUser.telegramId) return;

    await User.findByIdAndUpdate(newUser._id, { referredBy: referrer.telegramId });
    logger.info(`Referral attribution: referredBy=${referrer.telegramId}, referredTo=${newUser.telegramId}, code=${referralCode}`);
  } catch (err) {
    logger.error(`processReferral error: ${err.message}`);
  }
};

/**
 * Award bonus days to referrer when referred user gets their FIRST approved subscription
 */
const awardReferralBonus = async (bot, newSubscriberTelegramId) => {
  try {
    const newUser = await User.findOne({ telegramId: newSubscriberTelegramId });
    if (!newUser || !newUser.referredBy || newUser.referralBonusApplied) return;

    // Only on first-ever subscription
    const subCount = await Subscription.countDocuments({
      telegramId: newSubscriberTelegramId,
      status: { $in: ['active', 'expired'] },
    });
    if (subCount > 1) return;

    const referrer = await User.findOne({ telegramId: newUser.referredBy });
    if (!referrer) return;

    // Find referrer's active subscription and extend it
    const referrerSub = await Subscription.findOne({
      telegramId: referrer.telegramId,
      status: 'active',
      expiryDate: { $gt: new Date() },
    });

    if (referrerSub) {
      const newExpiry = addDays(referrerSub.expiryDate, BONUS_DAYS);
      await Subscription.findByIdAndUpdate(referrerSub._id, { expiryDate: newExpiry });

      // Notify referrer
      try {
        await bot.telegram.sendMessage(
          referrer.telegramId,
          `🎁 *Referral Bonus!*\n\nYour referral *${newUser.name}* just subscribed!\n` +
          `+${BONUS_DAYS} bonus days added to your subscription. 🎉`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) { }
    }

    await User.findByIdAndUpdate(newUser._id, { referralBonusApplied: true });

    await AdminLog.create({
      adminId: 0, // system action
      actionType: 'referral_bonus',
      targetUserId: referrer.telegramId,
      details: {
        referredUser: newSubscriberTelegramId,
        bonusDays: BONUS_DAYS,
      },
    });

    logger.info(`Referral bonus: ${BONUS_DAYS} days awarded to ${referrer.telegramId}`);
  } catch (err) {
    logger.error(`awardReferralBonus error: ${err.message}`);
  }
};

/**
 * Register a user into seller program.
 */
const registerSellerProgram = async (telegramId) => {
  const user = await User.findOne({ telegramId });
  if (!user) return null;

  if (user.isSeller && user.sellerCode) return user;

  const sellerCode = user.sellerCode || await generateUniqueSellerCode();

  await User.findByIdAndUpdate(user._id, {
    isSeller: true,
    sellerCode,
    $setOnInsert: {
      sellerStats: {
        totalReferrals: 0,
        qualifiedReferrals: 0,
        lifetimeEarnings: 0,
        availableBalance: 0,
      },
    },
    $set: {
      'meta.sellerRegisteredAt': user.meta?.sellerRegisteredAt || new Date(),
    },
  });

  return User.findOne({ telegramId });
};

/**
 * Process seller referral when user starts with ?start=seller_CODE
 */
const processSellerReferral = async (newUser, sellerCode) => {
  try {
    if (!sellerCode || newUser.sellerReferredBy) return;

    const seller = await User.findOne({ sellerCode, isSeller: true });
    if (!seller || seller.telegramId === newUser.telegramId) return;

    await User.findByIdAndUpdate(newUser._id, { sellerReferredBy: seller.telegramId });
    await User.findByIdAndUpdate(seller._id, { $inc: { 'sellerStats.totalReferrals': 1 } });

    logger.info(`Seller referral attribution: referredBy=${seller.telegramId}, referredTo=${newUser.telegramId}, code=${sellerCode}`);
  } catch (err) {
    logger.error(`processSellerReferral error: ${err.message}`);
  }
};

/**
 * Credit seller commission when referred user gets first approved subscription.
 */
const awardSellerCommission = async (bot, newSubscriberTelegramId, saleValue = 0) => {
  try {
    const newUser = await User.findOne({ telegramId: newSubscriberTelegramId });
    if (!newUser || !newUser.sellerReferredBy || newUser.sellerCommissionApplied) return;

    const subCount = await Subscription.countDocuments({
      telegramId: newSubscriberTelegramId,
      status: { $in: ['active', 'expired'] },
    });
    if (subCount > 1) return;

    const seller = await User.findOne({ telegramId: newUser.sellerReferredBy, isSeller: true });
    if (!seller) return;

    const numericSale = Number(saleValue) || 0;
    const commission = Number(((numericSale * SELLER_COMMISSION_PERCENT) / 100).toFixed(2));

    await User.findByIdAndUpdate(seller._id, {
      $inc: {
        'sellerStats.qualifiedReferrals': 1,
        'sellerStats.lifetimeEarnings': commission,
        'sellerStats.availableBalance': commission,
      },
    });

    await User.findByIdAndUpdate(newUser._id, { sellerCommissionApplied: true });

    try {
      await bot.telegram.sendMessage(
        seller.telegramId,
        `💰 *Seller Commission Credited!*\n\n` +
        `Referral: *${newUser.name}*\n` +
        `Sale Value: *₹${numericSale.toFixed(2)}*\n` +
        `Commission (${SELLER_COMMISSION_PERCENT}%): *₹${commission.toFixed(2)}*\n\n` +
        `Use /seller to view your seller dashboard.`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) { }

    await AdminLog.create({
      adminId: 0,
      actionType: 'referral_bonus',
      targetUserId: seller.telegramId,
      details: {
        type: 'seller_commission',
        referredUser: newSubscriberTelegramId,
        saleValue: numericSale,
        commission,
        commissionPercent: SELLER_COMMISSION_PERCENT,
      },
    });
  } catch (err) {
    logger.error(`awardSellerCommission error: ${err.message}`);
  }
};

const getSellerProgramSummary = async (telegramId) => {
  const user = await User.findOne({ telegramId });
  if (!user) return null;

  const stats = user.sellerStats || {
    totalReferrals: 0,
    qualifiedReferrals: 0,
    lifetimeEarnings: 0,
    availableBalance: 0,
  };

  const canWithdraw =
    stats.qualifiedReferrals >= SELLER_MIN_WITHDRAW_REFERRALS ||
    stats.availableBalance >= SELLER_MIN_WITHDRAW_BALANCE;

  return {
    isSeller: !!user.isSeller,
    sellerCode: user.sellerCode,
    stats,
    canWithdraw,
    withdrawRules: {
      minReferrals: SELLER_MIN_WITHDRAW_REFERRALS,
      minBalance: SELLER_MIN_WITHDRAW_BALANCE,
    },
  };
};

const requestSellerWithdrawal = async (telegramId, upiIdRaw) => {
  const summary = await getSellerProgramSummary(telegramId);
  if (!summary || !summary.isSeller) {
    throw new Error('Seller program not registered.');
  }

  const upiId = String(upiIdRaw || '').trim().toLowerCase();
  if (!upiId) {
    throw new Error('UPI ID is required for withdrawal request.');
  }

  if (!UPI_ID_REGEX.test(upiId)) {
    throw new Error('Invalid UPI ID format. Example: name@bank');
  }

  if (!summary.canWithdraw) {
    throw new Error(
      `Withdrawal not unlocked. Need ${summary.withdrawRules.minReferrals} qualified referrals or ₹${summary.withdrawRules.minBalance} balance.`
    );
  }

  const pending = await SellerWithdrawalRequest.findOne({ sellerTelegramId: telegramId, status: 'pending' });
  if (pending) {
    throw new Error('You already have a pending withdrawal request.');
  }

  const amount = Number(summary.stats.availableBalance || 0);
  if (amount <= 0) {
    throw new Error('Available balance is zero.');
  }

  const request = await SellerWithdrawalRequest.create({
    sellerTelegramId: telegramId,
    upiId,
    amount,
  });

  await AdminLog.create({
    adminId: 0,
    actionType: 'seller_withdraw_request',
    targetUserId: telegramId,
    details: { requestId: request._id, amount, upiId },
  });

  return request;
};

const getPendingSellerWithdrawalRequests = async (limit = 20) => {
  return SellerWithdrawalRequest.find({ status: 'pending' })
    .sort({ requestedAt: 1 })
    .limit(limit);
};

const approveSellerWithdrawal = async (requestId, adminTelegramId) => {
  assertSuperAdmin(adminTelegramId);

  const request = await SellerWithdrawalRequest.findById(requestId);
  if (!request) throw new Error('Withdrawal request not found.');
  if (request.status !== 'pending') throw new Error('Withdrawal request already processed.');

  await User.findOneAndUpdate(
    { telegramId: request.sellerTelegramId },
    { $inc: { 'sellerStats.availableBalance': -request.amount } }
  );

  request.status = 'approved';
  request.reviewedAt = new Date();
  request.reviewedBy = adminTelegramId;
  await request.save();

  await AdminLog.create({
    adminId: adminTelegramId,
    actionType: 'seller_withdraw_approve',
    targetUserId: request.sellerTelegramId,
    details: { requestId: request._id, amount: request.amount },
  });

  return request;
};

const rejectSellerWithdrawal = async (requestId, adminTelegramId, note = '') => {
  assertSuperAdmin(adminTelegramId);

  const request = await SellerWithdrawalRequest.findById(requestId);
  if (!request) throw new Error('Withdrawal request not found.');
  if (request.status !== 'pending') throw new Error('Withdrawal request already processed.');

  request.status = 'rejected';
  request.reviewedAt = new Date();
  request.reviewedBy = adminTelegramId;
  request.note = note || '';
  await request.save();

  await AdminLog.create({
    adminId: adminTelegramId,
    actionType: 'seller_withdraw_reject',
    targetUserId: request.sellerTelegramId,
    details: { requestId: request._id, amount: request.amount, note: request.note },
  });

  return request;
};

module.exports = {
  processReferral,
  awardReferralBonus,
  registerSellerProgram,
  processSellerReferral,
  awardSellerCommission,
  getSellerProgramSummary,
  requestSellerWithdrawal,
  getPendingSellerWithdrawalRequests,
  approveSellerWithdrawal,
  rejectSellerWithdrawal,
};
