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
    const safeExtra = {
      ...extra,
      protect_content: typeof extra?.protect_content === 'undefined' ? true : extra.protect_content,
    };
    await bot.telegram.sendMessage(telegramId, text, safeExtra);
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
    ).catch(() => { });

    logger.warn(`User ${telegramId} has blocked the bot — marked as blocked`);
  } catch (e) {
    logger.error(`handleBlockedUser error: ${e.message}`);
  }
};

/**
 * Generate a single-use invite link.
 * - member_limit: 1
 * - expire_date: short TTL (default 10 min) to reduce misuse window
 * If maxValidTill is provided, link expiry won't exceed that date.
 */
const generateInviteLink = async (bot, groupId, userId, maxValidTill = null) => {
  try {
    const ttlMinutes = Math.max(1, parseInt(process.env.INVITE_LINK_TTL_MINUTES || '10', 10));
    const nowUnix = Math.floor(Date.now() / 1000);
    const ttlExpiryUnix = nowUnix + (ttlMinutes * 60);

    let expireDateUnix = ttlExpiryUnix;
    if (maxValidTill) {
      const maxValidUnix = Math.floor(new Date(maxValidTill).getTime() / 1000);
      if (!Number.isNaN(maxValidUnix) && maxValidUnix > nowUnix) {
        expireDateUnix = Math.min(ttlExpiryUnix, maxValidUnix);
      }
    }

    const invite = await bot.telegram.createChatInviteLink(groupId, {
      name: `User_${userId}`,
      member_limit: 1,
      expire_date: expireDateUnix,
      creates_join_request: false,
    });
    return invite.invite_link;
  } catch (err) {
    logger.error(`generateInviteLink error for user ${userId}: ${err.message}`);
    return null;
  }
};

/**
 * Revoke a specific invite link immediately.
 */
const revokeInviteLink = async (bot, groupId, inviteLink) => {
  try {
    if (!inviteLink) return false;
    await bot.telegram.revokeChatInviteLink(groupId, inviteLink);
    return true;
  } catch (err) {
    logger.warn(`Could not revoke invite link: ${err.message}`);
    return false;
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
 * Unban a user from the premium group
 */
const unbanFromGroup = async (bot, groupId, telegramId) => {
  try {
    await bot.telegram.unbanChatMember(groupId, telegramId, { only_if_banned: true });
    logger.info(`User ${telegramId} unbanned from group ${groupId}`);
    return true;
  } catch (err) {
    logger.warn(`Could not unban ${telegramId}: ${err.message}`);
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
  revokeInviteLink,
  isGroupMember,
  banFromGroup,
  unbanFromGroup,
  renewalKeyboard,
};
