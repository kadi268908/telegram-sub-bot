// src/services/referralService.js
// Handles referral code generation, tracking, and bonus day awarding

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const AdminLog = require('../models/AdminLog');
const { addDays } = require('../utils/dateUtils');
const logger = require('../utils/logger');

const BONUS_DAYS = parseInt(process.env.BONUS_REFERRAL_DAYS) || 3;

/**
 * Process referral when a new user starts the bot with ?start=ref_CODE
 */
const processReferral = async (newUser, referralCode) => {
  try {
    if (!referralCode || newUser.referredBy) return; // Already referred or no code

    const referrer = await User.findOne({ referralCode });
    if (!referrer || referrer.telegramId === newUser.telegramId) return;

    await User.findByIdAndUpdate(newUser._id, { referredBy: referrer.telegramId });
    logger.info(`User ${newUser.telegramId} referred by ${referrer.telegramId} (code: ${referralCode})`);
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
      } catch (_) {}
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

module.exports = { processReferral, awardReferralBonus };
