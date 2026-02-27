// src/utils/telegramUtils.js
// Telegram API helpers: safe message sending with block detection, invite link generation

const AdminLog = require('../models/AdminLog');
const User = require('../models/User');
const logger = require('../utils/logger');

/**
 * Safely send a message to a user.
 * If bot is blocked (403), update user status and log it.
 * Returns true on success, false on failure.
 */
const safeSend = async (bot, telegramId, text, extra = {}) => {
  try {
    await bot.telegram.sendMessage(telegramId, text, extra);
    return true;
  } catch (err) {
    // 403 = user blocked the bot
    if (err.code === 403 || (err.response && err.response.error_code === 403)) {
      await handleBlockedUser(bot, telegramId);
    } else {
      logger.warn(`safeSend to ${telegramId} failed: ${err.message}`);
    }
    return false;
  }
};

/**
 * Handle a 403 blocked-bot error
 */
const handleBlockedUser = async (bot, telegramId) => {
  try {
    await User.findOneAndUpdate(
      { telegramId },
      { isBlocked: true, status: 'blocked' }
    );

    await AdminLog.create({
      adminId: 0,
      actionType: 'ban_user',
      targetUserId: telegramId,
      details: { reason: 'Bot blocked by user (403)' },
    });

    await bot.telegram.sendMessage(
      process.env.LOG_CHANNEL_ID,
      `🚫 *Bot Blocked*\nUser ID: \`${telegramId}\` has blocked the bot.\nStatus updated to blocked.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    logger.warn(`User ${telegramId} has blocked the bot — marked as blocked`);
  } catch (e) {
    logger.error(`handleBlockedUser error: ${e.message}`);
  }
};

/**
 * Generate a one-time invite link expiring in 10 minutes
 * member_limit = 1 ensures link can only be used once
 */
const generateInviteLink = async (bot, groupId, userId, subscriptionExpiry) => {
  try {
    const expireAt = new Date(Date.now() + 10 * 60 * 1000); // +10 minutes
    const invite = await bot.telegram.createChatInviteLink(groupId, {
      name: `User_${userId}`,
      member_limit: 1,
      expire_date: Math.floor(expireAt.getTime() / 1000),
    });
    return invite.invite_link;
  } catch (err) {
    logger.error(`generateInviteLink error for user ${userId}: ${err.message}`);
    return null;
  }
};

/**
 * Check if a user is currently a member of the premium group
 */
const isGroupMember = async (bot, groupId, telegramId) => {
  try {
    const member = await bot.telegram.getChatMember(groupId, telegramId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (_) {
    return false;
  }
};

/**
 * Ban a user from the premium group
 */
const banFromGroup = async (bot, groupId, telegramId) => {
  try {
    await bot.telegram.banChatMember(groupId, telegramId);
    logger.info(`User ${telegramId} banned from group ${groupId}`);
    return true;
  } catch (err) {
    logger.warn(`Could not ban ${telegramId}: ${err.message}`);
    return false;
  }
};

/**
 * Renewal inline keyboard with plan buttons
 */
const renewalKeyboard = (plans) => {
  const buttons = plans.map(p => ([{
    text: `🔄 Renew ${p.durationDays} Days${p.price ? ` · ₹${p.price}` : ''}`,
    callback_data: `renew_request_${p._id}`,
  }]));
  return { inline_keyboard: buttons };
};

module.exports = {
  safeSend,
  handleBlockedUser,
  generateInviteLink,
  isGroupMember,
  banFromGroup,
  renewalKeyboard,
};
