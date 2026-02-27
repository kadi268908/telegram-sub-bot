// src/services/cronService.js
// All scheduled cron jobs:
//   reminderScheduler    - expiry reminders at 7/3/1/0 days
//   gracePeriodHandler   - 3-day grace before group removal
//   inactiveUserDetector - re-engage users inactive 30+ days
//   membershipMonitor    - resend invite / ban mismatched users
//   dailySummary         - nightly channel report at 23:59
//   offerExpiryChecker   - deactivate expired offers

const cron = require('node-cron');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Offer = require('../models/Offer');
const Plan = require('../models/Plan');
const AdminLog = require('../models/AdminLog');
const { buildDailySummary } = require('./analyticsService');
const { safeSend, generateInviteLink, isGroupMember, banFromGroup, renewalKeyboard } = require('../utils/telegramUtils');
const { addDays, formatDate, startOfToday } = require('../utils/dateUtils');
const logger = require('../utils/logger');

// ── Helper: post to log channel ──────────────────────────────────────────────
const logToChannel = async (bot, message) => {
  try {
    await bot.telegram.sendMessage(process.env.LOG_CHANNEL_ID, message, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.warn(`logToChannel failed: ${err.message}`);
  }
};

// ── 1. REMINDER SCHEDULER ───────────────────────────────────────────────────
// Runs daily at 8:00 AM
// Sends reminders at 7, 3, 1 day before expiry and on expiry day
const reminderScheduler = async (bot) => {
  logger.info('[CRON] Running reminderScheduler...');
  const plans = await Plan.find({ isActive: true });

  const checkpoints = [
    { days: 7, flag: 'day7', label: '7 days' },
    { days: 3, flag: 'day3', label: '3 days' },
    { days: 1, flag: 'day1', label: '1 day' },
    { days: 0, flag: 'day0', label: 'today' },
  ];

  for (const { days, flag, label } of checkpoints) {
    const targetStart = addDays(startOfToday(), days);
    const targetEnd = new Date(targetStart);
    targetEnd.setHours(23, 59, 59, 999);

    const subs = await Subscription.find({
      status: 'active',
      expiryDate: { $gte: targetStart, $lte: targetEnd },
      [`reminderFlags.${flag}`]: false,
    });

    for (const sub of subs) {
      const sent = await safeSend(
        bot,
        sub.telegramId,
        `⏰ *Subscription Reminder*\n\n` +
        `Your subscription expires in *${days === 0 ? 'less than 24 hours' : label}*!\n` +
        `📅 Expiry date: *${formatDate(sub.expiryDate)}*\n\n` +
        `Tap a button below to renew:`,
        {
          parse_mode: 'Markdown',
          reply_markup: renewalKeyboard(plans),
        }
      );

      if (sent) {
        sub.reminderFlags[flag] = true;
        await sub.save();
        logger.info(`Reminder (${label}) sent to user ${sub.telegramId}`);
      }
    }
  }
};

// ── 2. GRACE PERIOD HANDLER ──────────────────────────────────────────────────
// Runs daily at 9:00 AM
// Day 0: expiry message
// Day +1: reminder
// Day +2: final warning
// Day +3: remove from group
const gracePeriodHandler = async (bot) => {
  logger.info('[CRON] Running gracePeriodHandler...');
  const GRACE_DAYS = parseInt(process.env.GRACE_PERIOD_DAYS) || 3;
  const today = startOfToday();

  // Find subscriptions that just expired (expiryDate was yesterday or today, status still active)
  const justExpired = await Subscription.find({
    status: 'active',
    expiryDate: { $lt: today },
  });

  for (const sub of justExpired) {
    // Transition to grace status
    sub.status = 'grace';
    sub.graceDaysUsed = 0;
    await sub.save();
    await User.findOneAndUpdate({ telegramId: sub.telegramId }, { status: 'expired', graceDaysRemaining: GRACE_DAYS });

    await safeSend(bot, sub.telegramId,
      `❌ *Subscription Expired*\n\nYour subscription expired on *${formatDate(sub.expiryDate)}*.\n\n` +
      `⏳ You have a ${GRACE_DAYS}-day grace period. Renew now to keep your access!`,
      {
        parse_mode: 'Markdown',
        reply_markup: renewalKeyboard(await Plan.find({ isActive: true })),
      }
    );

    await logToChannel(bot, `⚠️ *Grace Period Started*\nUser: \`${sub.telegramId}\`\nPlan: ${sub.planName}`);
  }

  // Process existing grace period subscriptions
  const inGrace = await Subscription.find({ status: 'grace' });

  for (const sub of inGrace) {
    const daysSinceExpiry = Math.floor((today - sub.expiryDate) / (1000 * 60 * 60 * 24));

    if (daysSinceExpiry >= GRACE_DAYS) {
      // Remove from group
      await banFromGroup(bot, process.env.PREMIUM_GROUP_ID, sub.telegramId);

      // Mark subscription fully expired
      sub.status = 'expired';
      sub.graceDaysUsed = GRACE_DAYS;
      await sub.save();
      await User.findOneAndUpdate({ telegramId: sub.telegramId }, { status: 'expired', graceDaysRemaining: 0 });

      await safeSend(bot, sub.telegramId,
        `🚫 *Access Removed*\n\nYour grace period has ended. You have been removed from the Premium Group.\n\nRequest a new subscription using /start.`,
        { parse_mode: 'Markdown' }
      );

      await logToChannel(bot,
        `🚫 *User Removed After Grace Period*\nUser: \`${sub.telegramId}\`\nDays overdue: ${daysSinceExpiry}`
      );

      await AdminLog.create({
        adminId: 0,
        actionType: 'ban_user',
        targetUserId: sub.telegramId,
        details: { reason: 'Grace period expired', daysOverdue: daysSinceExpiry },
      });

    } else if (daysSinceExpiry === GRACE_DAYS - 1 && !sub.graceNotifications.day2) {
      await safeSend(bot, sub.telegramId,
        `🔴 *Final Warning!*\n\nYou will be removed from the Premium Group in *1 day* if you don't renew.\n\nRenew now to keep access!`,
        {
          parse_mode: 'Markdown',
          reply_markup: renewalKeyboard(await Plan.find({ isActive: true })),
        }
      );
      sub.graceNotifications.day2 = true;
      await sub.save();

    } else if (daysSinceExpiry === 1 && !sub.graceNotifications.day1) {
      await safeSend(bot, sub.telegramId,
        `⚠️ *Grace Period Reminder*\n\nYour subscription has expired. You have ${GRACE_DAYS - 1} days left before removal.`,
        {
          parse_mode: 'Markdown',
          reply_markup: renewalKeyboard(await Plan.find({ isActive: true })),
        }
      );
      sub.graceNotifications.day1 = true;
      await sub.save();
    }
  }
};

// ── 3. INACTIVE USER DETECTOR ─────────────────────────────────────────────────
// Runs daily at 10:00 AM
// Re-engage users inactive 30+ days OR expired 7+ days
const inactiveUserDetector = async (bot) => {
  logger.info('[CRON] Running inactiveUserDetector...');
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const inactiveUsers = await User.find({
    role: 'user',
    isBlocked: false,
    $or: [
      { lastInteraction: { $lt: thirtyDaysAgo }, status: 'active' },
      { status: 'expired', updatedAt: { $lt: sevenDaysAgo } },
    ],
  });

  let contacted = 0;
  for (const user of inactiveUsers) {
    const sent = await safeSend(bot, user.telegramId,
      `👋 *We miss you, ${user.name}!*\n\n` +
      `It's been a while since we've seen you. We have a special offer waiting for you!\n\n` +
      `Tap below to see what's available:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎁 View Special Offers', callback_data: 'view_offers' }],
            [{ text: '🌟 Request Access', callback_data: 'request_access' }],
          ],
        },
      }
    );
    if (sent) contacted++;
  }

  if (contacted > 0) {
    logger.info(`inactiveUserDetector: ${contacted} re-engagement messages sent`);
  }
};

// ── 4. MEMBERSHIP MONITOR ─────────────────────────────────────────────────────
// Runs daily at 11:00 AM
// - Active sub but not in group → resend invite
// - Expired but still in group → ban
const membershipMonitor = async (bot) => {
  logger.info('[CRON] Running membershipMonitor...');

  // Active subscriptions
  const activeSubs = await Subscription.find({
    status: 'active',
    expiryDate: { $gt: new Date() },
  });

  for (const sub of activeSubs) {
    const inGroup = await isGroupMember(bot, process.env.PREMIUM_GROUP_ID, sub.telegramId);
    if (!inGroup) {
      // User has active sub but not in group — resend invite
      const link = await generateInviteLink(bot, process.env.PREMIUM_GROUP_ID, sub.telegramId);
      if (link) {
        sub.inviteLink = link;
        await sub.save();
        await safeSend(bot, sub.telegramId,
          `🔗 *Rejoining Instructions*\n\nYou have an active subscription but aren't in the group.\nHere's a new invite link:\n\n${link}\n\n⚠️ This link expires in 10 minutes and is single-use.`,
          { parse_mode: 'Markdown' }
        );
        logger.info(`Resent invite to active user ${sub.telegramId}`);
      }
    }
  }

  // Expired users still in group
  const expiredUsers = await Subscription.find({ status: { $in: ['expired', 'cancelled'] } })
    .select('telegramId');

  for (const sub of expiredUsers) {
    const inGroup = await isGroupMember(bot, process.env.PREMIUM_GROUP_ID, sub.telegramId);
    if (inGroup) {
      await banFromGroup(bot, process.env.PREMIUM_GROUP_ID, sub.telegramId);
      await logToChannel(bot,
        `🚫 *Expired User Removed by Monitor*\nUser: \`${sub.telegramId}\``
      );
    }
  }
};

// ── 5. DAILY SUMMARY ─────────────────────────────────────────────────────────
// Runs daily at 23:59
// Posts a full activity summary to the log channel
const dailySummaryJob = async (bot) => {
  logger.info('[CRON] Running dailySummaryJob...');
  try {
    const summary = await buildDailySummary();
    const today = new Date().toLocaleDateString('en-GB');

    await logToChannel(bot,
      `📊 *Daily Activity Summary — ${today}*\n\n` +
      `👤 New Users: ${summary.newUsers}\n` +
      `📩 Requests Received: ${summary.requestsReceived}\n` +
      `✅ Approvals: ${summary.approvals}\n` +
      `🔄 Renewals: ${summary.renewals}\n` +
      `❌ Expired Today: ${summary.expiredToday}\n`
    );
  } catch (err) {
    logger.error(`dailySummaryJob error: ${err.message}`);
  }
};

// ── 6. OFFER EXPIRY CHECKER ───────────────────────────────────────────────────
// Runs daily at 00:05
// Deactivates offers whose validTill has passed
const offerExpiryChecker = async () => {
  logger.info('[CRON] Running offerExpiryChecker...');
  const result = await Offer.updateMany(
    { isActive: true, validTill: { $lt: new Date() } },
    { isActive: false }
  );
  if (result.modifiedCount > 0) {
    logger.info(`offerExpiryChecker: ${result.modifiedCount} offers deactivated`);
  }
};

// ── INIT: Register all cron schedules ─────────────────────────────────────────
const initCronJobs = (bot) => {
  cron.schedule('0 8 * * *',  () => reminderScheduler(bot));    // 8:00 AM
  cron.schedule('0 9 * * *',  () => gracePeriodHandler(bot));   // 9:00 AM
  cron.schedule('0 10 * * *', () => inactiveUserDetector(bot)); // 10:00 AM
  cron.schedule('0 11 * * *', () => membershipMonitor(bot));    // 11:00 AM
  cron.schedule('59 23 * * *',() => dailySummaryJob(bot));      // 23:59
  cron.schedule('5 0 * * *',  () => offerExpiryChecker());      // 00:05

  logger.info('All cron jobs initialized.');
};

module.exports = {
  initCronJobs,
  logToChannel,
  reminderScheduler,
  gracePeriodHandler,
  inactiveUserDetector,
  membershipMonitor,
  dailySummaryJob,
  offerExpiryChecker,
};
