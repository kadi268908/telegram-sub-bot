// src/services/supportService.js
// Topics-based support system.
//
// Flow:
//   User /support → bot creates a Forum Topic in SUPPORT_GROUP_ID
//   User messages → forwarded into that topic
//   Admin replies in topic → bot forwards reply back to user's DM
//   Admin closes topic (button) → user notified, topic archived
//   1 ticket per user per day enforced via openedDate
//   Overflow → SUPPORT_CONTACT

const SupportTicket = require('../models/SupportTicket');
const AdminLog = require('../models/AdminLog');
const logger = require('../utils/logger');

const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '@ImaxSupport1Bot';
const SUPPORT_GROUP_ID = process.env.SUPPORT_GROUP_ID;

// Today as YYYY-MM-DD
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * Count tickets this user has opened today
 */
const getTodayTicketCount = async (telegramId) => {
  return SupportTicket.countDocuments({ telegramId, openedDate: todayStr() });
};

/**
 * Get the user's currently open ticket (if any)
 */
const getActiveTicket = async (telegramId) => {
  return SupportTicket.findOne({ telegramId, status: 'open' });
};

/**
 * Get ticket by forum topicId (used when admin replies in topic)
 */
const getTicketByTopicId = async (topicId) => {
  return SupportTicket.findOne({ topicId });
};

/**
 * Create a new forum topic + ticket record.
 * Throws { code: 'DAILY_LIMIT_REACHED' } if user already used their daily ticket.
 */
const openTicket = async (bot, user, firstMessage) => {
  // Daily limit check
  const count = await getTodayTicketCount(user.telegramId);
  if (count >= 1) {
    const err = new Error('DAILY_LIMIT_REACHED');
    err.code = 'DAILY_LIMIT_REACHED';
    throw err;
  }

  // Create a forum topic named after the user
  const topicName = `${user.name} · ${user.telegramId}`;
  const topic = await bot.telegram.createForumTopic(SUPPORT_GROUP_ID, topicName, {
    icon_color: 0x6FB9F0, // light blue
  });

  // Post the opening message into the topic so admins see it immediately
  const userTag = user.username ? `@${user.username}` : `ID: ${user.telegramId}`;
  await bot.telegram.sendMessage(
    SUPPORT_GROUP_ID,
    `🎫 *New Support Ticket*\n\n` +
    `👤 *User:* ${user.name} (${userTag})\n` +
    `📅 *Opened:* ${new Date().toLocaleString('en-IN')}\n\n` +
    `📝 *First Message:*\n${firstMessage}\n\n` +
    `─────────────────\n` +
    `Reply in this thread → user gets your message.\n` +
    `Press *Close Ticket* below when done.`,
    {
      message_thread_id: topic.message_thread_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Close Ticket', callback_data: `close_topic_${topic.message_thread_id}` },
        ]],
      },
    }
  );

  // Save ticket record
  const ticket = new SupportTicket({
    telegramId: user.telegramId,
    userId: user._id,
    userName: user.name,
    userUsername: user.username || null,
    topicId: topic.message_thread_id,
    firstMessage,
    openedDate: todayStr(),
  });
  await ticket.save();

  logger.info(`Support ticket ${ticket.ticketId} opened → topic ${topic.message_thread_id}`);
  return ticket;
};

/**
 * Forward a user's follow-up message into their open topic thread.
 */
const forwardUserMessage = async (bot, ticket, user, text) => {
  const userTag = user.username ? `@${user.username}` : `User ${user.telegramId}`;
  await bot.telegram.sendMessage(
    SUPPORT_GROUP_ID,
    `💬 *${userTag}:*\n${text}`,
    {
      message_thread_id: ticket.topicId,
      parse_mode: 'Markdown',
    }
  );
};

/**
 * Forward an admin's topic reply back to the user's DM.
 * Called when bot detects a message in the support group thread.
 */
const forwardAdminReply = async (bot, ticket, adminName, text) => {
  const { safeSend } = require('../utils/telegramUtils');
  await safeSend(
    bot,
    ticket.telegramId,
    `💬 *Support Team:*\n\n${text}`,
    { parse_mode: 'Markdown' }
  );

  await AdminLog.create({
    adminId: 0,
    actionType: 'support_reply',
    targetUserId: ticket.telegramId,
    details: { ticketId: ticket.ticketId, reply: text.substring(0, 100) },
  });
};

/**
 * Close a ticket — archives the forum topic and notifies the user.
 */
const closeTicket = async (bot, topicId, closedBy = null, byUser = false) => {
  const ticket = await SupportTicket.findOneAndUpdate(
    { topicId, status: 'open' },
    {
      status: 'closed',
      closedAt: new Date(),
      closedBy,
      closedByUser: byUser,
    },
    { new: true }
  );

  if (!ticket) return null;

  // Archive (close) the forum topic
  try {
    await bot.telegram.closeForumTopic(SUPPORT_GROUP_ID, topicId);
  } catch (e) {
    logger.warn(`closeForumTopic failed: ${e.message}`);
  }

  // Notify user in DM
  const { safeSend } = require('../utils/telegramUtils');
  const closedByMsg = byUser
    ? 'You closed this support chat.'
    : 'Our support team has resolved your ticket.';

  await safeSend(
    bot,
    ticket.telegramId,
    `✅ *Support Chat Closed*\n\n` +
    `Ticket: \`${ticket.ticketId}\`\n` +
    `${closedByMsg}\n\n` +
    `If you need help again tomorrow, use /support.\n` +
    `For urgent issues: ${SUPPORT_CONTACT}`,
    { parse_mode: 'Markdown' }
  );

  if (!byUser) {
    await AdminLog.create({
      adminId: closedBy || 0,
      actionType: 'close_ticket',
      targetUserId: ticket.telegramId,
      details: { ticketId: ticket.ticketId },
    });
  }

  logger.info(`Ticket ${ticket.ticketId} closed (byUser: ${byUser})`);
  return ticket;
};

/**
 * Get open tickets list for admin panel
 */
const getOpenTickets = async (limit = 15) => {
  return SupportTicket.find({ status: 'open' }).sort({ createdAt: -1 }).limit(limit);
};

module.exports = {
  openTicket,
  forwardUserMessage,
  forwardAdminReply,
  closeTicket,
  getActiveTicket,
  getTicketByTopicId,
  getTodayTicketCount,
  getOpenTickets,
  SUPPORT_CONTACT,
  SUPPORT_GROUP_ID,
};
